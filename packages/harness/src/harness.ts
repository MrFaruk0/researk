import {
  type NormalizedError,
  type RunEvent,
  RunEventSchema,
  type RunRequest,
  RunRequestSchema,
} from "@researk/contracts";
import { type CredentialResolver, HarnessError } from "./provider.js";
import { failure, type ProviderRegistry } from "./registry.js";
import { normalizeErrorMessage } from "./security.js";

export interface HarnessOptions {
  readonly registry: ProviderRegistry;
  readonly credentials: CredentialResolver;
  readonly now?: () => Date;
}

export class Harness {
  readonly #registry: ProviderRegistry;
  readonly #credentials: CredentialResolver;
  readonly #now: () => Date;

  constructor(options: HarnessOptions) {
    this.#registry = options.registry;
    this.#credentials = options.credentials;
    this.#now = options.now ?? (() => new Date());
  }

  async *run(
    input: RunRequest,
    signal: AbortSignal = new AbortController().signal,
  ): AsyncIterable<RunEvent> {
    const request = RunRequestSchema.parse(input);
    const timeoutSignal =
      request.timeoutMs === undefined ? undefined : AbortSignal.timeout(request.timeoutMs);
    const runSignal =
      timeoutSignal === undefined ? signal : AbortSignal.any([signal, timeoutSignal]);
    let sequence = 0;
    const event = (value: RunEventInput): RunEvent =>
      RunEventSchema.parse({
        ...value,
        schemaVersion: 1,
        runId: request.runId,
        sequence: sequence++,
        timestamp: this.#now().toISOString(),
      });

    try {
      runSignal.throwIfAborted();
      yield event({ type: "phase", phase: "selection", status: "started" });
      const { adapter, resolved } = await this.#registry.resolve(
        request.selection,
        request.requiredCapabilities,
        { credentials: this.#credentials, signal: runSignal },
      );
      yield event({ type: "selection", selection: resolved.selection });
      yield event({ type: "phase", phase: "selection", status: "completed" });
      yield event({ type: "phase", phase: "generation", status: "started" });
      let completed = false;
      for await (const providerEvent of adapter.stream(
        { run: request, resolved },
        { credentials: this.#credentials, signal: runSignal },
      )) {
        runSignal.throwIfAborted();
        if (
          providerEvent.responseModelId !== undefined &&
          providerEvent.responseModelId !== resolved.selection.modelId
        ) {
          throw failure("model_substitution", "The provider responded with a different model.", {
            providerId: resolved.selection.providerId,
            modelId: resolved.selection.modelId,
          });
        }
        if (providerEvent.type === "text_delta") {
          if (providerEvent.delta.length > 0)
            yield event({ type: "text_delta", delta: providerEvent.delta });
        } else {
          completed = true;
          yield event({ type: "phase", phase: "generation", status: "completed" });
          yield event({
            type: "completed",
            selection: resolved.selection,
            finishReason: providerEvent.finishReason,
            ...(providerEvent.usage === undefined ? {} : { usage: providerEvent.usage }),
          });
          break;
        }
      }
      if (!completed) {
        throw failure(
          "provider_protocol_error",
          "The provider stream ended without a completion event.",
          {
            providerId: resolved.selection.providerId,
            modelId: resolved.selection.modelId,
          },
        );
      }
    } catch (error) {
      if (runSignal.aborted) {
        if (signal.aborted) {
          yield event({ type: "cancelled", reason: "The run was cancelled." });
          return;
        }
        if (timeoutSignal?.aborted) {
          yield event({
            type: "error",
            error: failure("timeout", "The run timed out.").normalized,
          });
          return;
        }
      }
      const normalized = normalize(error);
      yield event({ type: "error", error: normalized });
    }
  }
}

type WithoutEventBase<T> = T extends unknown
  ? Omit<T, "schemaVersion" | "runId" | "sequence" | "timestamp">
  : never;
type RunEventInput = WithoutEventBase<RunEvent>;

function normalize(error: unknown): NormalizedError {
  if (error instanceof HarnessError) return error.normalized;
  return failure("internal_error", normalizeErrorMessage(error)).normalized;
}
