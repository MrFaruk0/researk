import {
  canonicalModelId,
  EffectiveReasoningSchema,
  ModelCapabilitiesSchema,
  ModelCatalogSchema,
  type ModelDescriptor,
  ModelIdSchema,
  type ProviderDescriptor,
  ProviderDescriptorSchema,
  type ReasoningIntent,
  type ReasoningRequest,
  type TokenUsage,
  TokenUsageSchema,
} from "@researk/contracts";
import {
  failure,
  HarnessError,
  normalizeErrorMessage,
  type ProviderAdapter,
  type ProviderContext,
  type ProviderStreamEvent,
  redactSecrets,
  sanitizeSafeText,
  sanitizeUntrustedText,
} from "@researk/harness";
import { parseSse } from "./sse.js";

/** Native OpenRouter adapter.  It deliberately does not fall back to a different model. */
export interface OpenRouterAdapterOptions {
  /** Environment-variable or other injected credential reference. */
  readonly apiKeyReference?: string;
  /** For a loopback contract server only; production defaults to the OpenRouter API. */
  readonly baseUrl?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
  readonly maxBodyBytes?: number;
}

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1/";
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 3_600_000;
const DEFAULT_MAX_BODY_BYTES = 16_000_000;
const MAX_BODY_BYTES = 64_000_000;
const KNOWN_INTENTS = new Set<ReasoningIntent>([
  "auto",
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);

interface RequestedResponse {
  readonly response: Response;
  readonly signal: AbortSignal;
  readonly timeoutSignal: AbortSignal;
}

/**
 * Implements OpenRouter's native model catalog and `reasoning.effort` request
 * shape. Catalog data is untrusted: unknown/malformed entries are skipped and
 * duplicate valid ids fail closed.
 */
export class OpenRouterAdapter implements ProviderAdapter {
  readonly descriptor: ProviderDescriptor = ProviderDescriptorSchema.parse({
    providerId: "openrouter",
    displayName: "OpenRouter",
    kind: "remote",
  });
  readonly #baseUrl: URL;
  readonly #apiKeyReference: string | undefined;
  readonly #fetch: typeof globalThis.fetch;
  readonly #timeoutMs: number;
  readonly #maxBodyBytes: number;

  constructor(options: OpenRouterAdapterOptions = {}) {
    this.#baseUrl = parseBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
    this.#apiKeyReference = options.apiKeyReference;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeoutMs = boundedPositiveSafeInteger(
      options.timeoutMs,
      DEFAULT_TIMEOUT_MS,
      MAX_TIMEOUT_MS,
      "timeoutMs",
    );
    this.#maxBodyBytes = boundedPositiveSafeInteger(
      options.maxBodyBytes,
      DEFAULT_MAX_BODY_BYTES,
      MAX_BODY_BYTES,
      "maxBodyBytes",
    );
  }

  async discoverModels(context: ProviderContext) {
    const credential = await this.#credential(context);
    const requested = await this.#request(
      "models",
      { method: "GET", headers: headers(credential) },
      context,
      credential,
    );
    try {
      const value = await readJson(
        requested.response,
        this.#maxBodyBytes,
        credential,
        requested.signal,
      );
      const rows = isRecord(value) && Array.isArray(value.data) ? value.data : undefined;
      if (rows === undefined)
        throw this.#protocol("OpenRouter model catalog did not contain a data array.");
      const now = new Date().toISOString();
      const models: ModelDescriptor[] = [];
      const seen = new Set<string>();
      for (const row of rows) {
        if (!isRecord(row)) continue;
        const descriptor = normalizeModel(row, this.descriptor.providerId, now);
        if (descriptor === undefined) continue;
        if (seen.has(descriptor.modelId)) {
          throw this.#protocol("OpenRouter model catalog contained a duplicate model ID.");
        }
        seen.add(descriptor.modelId);
        models.push(descriptor);
      }
      return ModelCatalogSchema.parse({
        provider: this.descriptor,
        models,
        source: "live",
        refreshedAt: now,
        stale: false,
      });
    } catch (error) {
      this.#throwBodyFailure(error, context, requested.timeoutSignal, credential);
    }
  }

  async resolveReasoning(model: ModelDescriptor, request: ReasoningRequest) {
    if (model.providerId !== this.descriptor.providerId) {
      throw failure("capability_missing", "The selected model does not belong to OpenRouter.", {
        providerId: this.descriptor.providerId,
        modelId: model.modelId,
      });
    }
    if (request.nativeOverride !== undefined) {
      throw failure(
        "capability_missing",
        "Native reasoning overrides are not accepted by OpenRouter.",
        {
          providerId: model.providerId,
          modelId: model.modelId,
        },
      );
    }
    if (request.intent === "auto") {
      return {
        reasoning: EffectiveReasoningSchema.parse({
          requestedIntent: "auto",
          usedNativeOverride: false,
          diagnostics: [],
        }),
        nativeOptions: {},
      };
    }
    if (
      !model.capabilities.reasoning.supported ||
      !model.capabilities.reasoning.intents.includes(request.intent)
    ) {
      throw failure(
        "capability_missing",
        `Reasoning intent '${request.intent}' is not advertised by this OpenRouter model.`,
        {
          providerId: model.providerId,
          modelId: model.modelId,
        },
      );
    }
    const nativeValue = request.intent === "off" ? "none" : request.intent;
    return {
      reasoning: EffectiveReasoningSchema.parse({
        requestedIntent: request.intent,
        effectiveIntent: request.intent,
        nativeField: "reasoning.effort",
        nativeValue,
        usedNativeOverride: false,
        diagnostics: [],
      }),
      nativeOptions: Object.freeze({ "reasoning.effort": nativeValue }),
    };
  }

  async *stream(
    request: Parameters<ProviderAdapter["stream"]>[0],
    context: ProviderContext,
  ): AsyncIterable<ProviderStreamEvent> {
    if (request.resolved.selection.providerId !== this.descriptor.providerId) {
      throw failure("capability_missing", "The selected provider is not OpenRouter.", {
        providerId: this.descriptor.providerId,
        modelId: request.resolved.selection.modelId,
      });
    }
    const credential = await this.#credential(context);
    const requested = await this.#request(
      "chat/completions",
      {
        method: "POST",
        headers: { ...headers(credential), "content-type": "application/json" },
        body: JSON.stringify({
          model: request.resolved.selection.modelId,
          messages: request.run.messages,
          stream: request.run.stream,
          ...toOpenRouterOptions(request.resolved.nativeOptions),
        }),
      },
      context,
      credential,
    );
    try {
      const response = requested.response;
      const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
      if (contentType.includes("text/event-stream")) {
        if (response.body === null)
          throw this.#protocol("OpenRouter returned an empty event stream.");
        for await (const sse of parseSse(response.body, {
          signal: requested.signal,
          maxBytes: this.#maxBodyBytes,
        })) {
          if (sse.data.trim() === "[DONE]") {
            yield { type: "completed", finishReason: "stop" };
            return;
          }
          const completion = parseCompletion(parseJson(sse.data, credential), true);
          this.#assertExactModel(completion.modelId, request.resolved.selection.modelId);
          if (completion.text !== undefined && completion.text.length > 0) {
            yield {
              type: "text_delta",
              delta: sanitizeUntrustedText(completion.text, 1_000_000),
              ...(completion.modelId === undefined ? {} : { responseModelId: completion.modelId }),
            };
          }
          if (completion.finishReason !== undefined) {
            yield {
              type: "completed",
              finishReason: completion.finishReason,
              ...(completion.usage === undefined ? {} : { usage: completion.usage }),
              ...(completion.modelId === undefined ? {} : { responseModelId: completion.modelId }),
            };
            return;
          }
        }
        throw this.#protocol("OpenRouter event stream ended before completion.");
      }
      const completion = parseCompletion(
        await readJson(response, this.#maxBodyBytes, credential, requested.signal),
        false,
      );
      this.#assertExactModel(completion.modelId, request.resolved.selection.modelId);
      if (completion.text !== undefined && completion.text.length > 0) {
        yield {
          type: "text_delta",
          delta: sanitizeUntrustedText(completion.text, 1_000_000),
          ...(completion.modelId === undefined ? {} : { responseModelId: completion.modelId }),
        };
      }
      yield {
        type: "completed",
        finishReason: completion.finishReason ?? "other",
        ...(completion.usage === undefined ? {} : { usage: completion.usage }),
        ...(completion.modelId === undefined ? {} : { responseModelId: completion.modelId }),
      };
    } catch (error) {
      this.#throwBodyFailure(error, context, requested.timeoutSignal, credential);
    }
  }

  async #credential(context: ProviderContext): Promise<string | undefined> {
    if (this.#apiKeyReference === undefined) return undefined;
    try {
      return await context.credentials.resolve(this.#apiKeyReference, context.signal);
    } catch (error) {
      if (context.signal.aborted) throw error;
      throw failure("credential_unavailable", normalizeErrorMessage(error), {
        providerId: this.descriptor.providerId,
      });
    }
  }

  async #request(
    path: string,
    init: RequestInit,
    context: ProviderContext,
    credential?: string,
  ): Promise<RequestedResponse> {
    const timeoutSignal = AbortSignal.timeout(this.#timeoutMs);
    const signal = AbortSignal.any([context.signal, timeoutSignal]);
    try {
      const response = await this.#fetch(new URL(path, this.#baseUrl), { ...init, signal });
      if (!response.ok) {
        const body = await readLimitedText(response, Math.min(this.#maxBodyBytes, 65_536), signal);
        throw failure(
          "provider_http_error",
          `OpenRouter request failed with HTTP ${response.status}: ${sanitizeSafeText(redactSecrets(body, credential === undefined ? [] : [credential]))}`,
          {
            providerId: this.descriptor.providerId,
            httpStatus: response.status,
            retryable: response.status === 408 || response.status === 429 || response.status >= 500,
          },
        );
      }
      return { response, signal, timeoutSignal };
    } catch (error) {
      this.#throwRequestFailure(error, context, timeoutSignal, credential);
    }
  }

  #assertExactModel(responseModelId: string | undefined, requestedModelId: string): void {
    if (responseModelId !== undefined && responseModelId !== requestedModelId) {
      throw failure(
        "model_substitution",
        "OpenRouter returned a different model than the selected model.",
        {
          providerId: this.descriptor.providerId,
          modelId: requestedModelId,
        },
      );
    }
  }

  #throwBodyFailure(
    error: unknown,
    context: ProviderContext,
    timeoutSignal: AbortSignal,
    credential?: string,
  ): never {
    if (context.signal.aborted || timeoutSignal.aborted || isBodyLimitError(error)) {
      if (isBodyLimitError(error)) throw this.#protocol(error.message);
      return this.#throwRequestFailure(error, context, timeoutSignal, credential);
    }
    return this.#throwRequestFailure(error, context, timeoutSignal, credential);
  }

  #throwRequestFailure(
    error: unknown,
    context: ProviderContext,
    timeoutSignal: AbortSignal,
    credential?: string,
  ): never {
    if (context.signal.aborted) throw error;
    if (timeoutSignal.aborted)
      throw failure("timeout", "The OpenRouter request timed out.", {
        providerId: this.descriptor.providerId,
      });
    if (error instanceof HarnessError) throw error;
    throw failure(
      "provider_unavailable",
      normalizeErrorMessage(error, credential === undefined ? [] : [credential]),
      {
        providerId: this.descriptor.providerId,
        retryable: true,
      },
    );
  }

  #protocol(message: string) {
    return failure("provider_protocol_error", message, { providerId: this.descriptor.providerId });
  }
}

function normalizeModel(
  row: Record<string, unknown>,
  providerId: string,
  discoveredAt: string,
): ModelDescriptor | undefined {
  const id = ModelIdSchema.safeParse(row.id);
  if (!id.success) return undefined;
  const architecture = isRecord(row.architecture) ? row.architecture : {};
  const topProvider = isRecord(row.top_provider) ? row.top_provider : {};
  const parameters = stringList(row.supported_parameters);
  const reasoning = normalizeReasoning(row, parameters);
  const contextWindowTokens =
    positiveInteger(topProvider.context_length) ?? positiveInteger(row.context_length);
  const maxOutputTokens =
    positiveInteger(topProvider.max_completion_tokens) ??
    positiveInteger(row.max_completion_tokens);
  const inputModalities = stringList(architecture.input_modalities);
  const modality = typeof architecture.modality === "string" ? architecture.modality : "";
  const capabilities = ModelCapabilitiesSchema.parse({
    streaming: true,
    toolCalls: parameters.includes("tools") || parameters.includes("tool_choice"),
    structuredOutput:
      parameters.includes("structured_outputs") || parameters.includes("response_format"),
    vision: inputModalities.includes("image") || modality.includes("image"),
    files: inputModalities.includes("file") || inputModalities.includes("pdf"),
    ...(contextWindowTokens === undefined ? {} : { contextWindowTokens }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    reasoning,
  });
  const revision = safeRevision(row);
  return {
    providerId,
    modelId: id.data,
    canonicalId: canonicalModelId(providerId, id.data),
    displayName: sanitizeSafeText(typeof row.name === "string" ? row.name : id.data),
    revision,
    capabilities,
    status: row.status === "unavailable" || row.status === "available" ? row.status : "available",
    catalogSource: "live",
    discoveredAt,
  };
}

function normalizeReasoning(row: Record<string, unknown>, parameters: readonly string[]) {
  const advertised =
    parameters.includes("reasoning") ||
    parameters.includes("reasoning_effort") ||
    parameters.includes("include_reasoning");
  const values = new Set<ReasoningIntent>();
  const candidates = [
    row.reasoning,
    isRecord(row.default_parameters) ? row.default_parameters.reasoning : undefined,
    row.reasoning_efforts,
  ];
  for (const candidate of candidates) collectReasoningIntents(candidate, values);
  const defaultCandidate =
    isRecord(row.default_parameters) && isRecord(row.default_parameters.reasoning)
      ? row.default_parameters.reasoning.effort
      : undefined;
  const defaultIntent = nativeIntent(defaultCandidate);
  if (defaultIntent !== undefined) values.add(defaultIntent);
  // A model that merely advertises the generic `reasoning` parameter supports automatic routing,
  // but it has not advertised a selectable effort. Do not invent one.
  return {
    supported: advertised,
    intents: [...values],
    nativeOverride: false,
    ...(defaultIntent === undefined ? {} : { defaultIntent }),
  };
}

function collectReasoningIntents(value: unknown, destination: Set<ReasoningIntent>): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      const intent = nativeIntent(item);
      if (intent !== undefined) destination.add(intent);
    }
    return;
  }
  if (!isRecord(value)) return;
  for (const key of ["efforts", "supported_efforts", "allowed_efforts", "levels", "values"]) {
    collectReasoningIntents(value[key], destination);
  }
  const intent = nativeIntent(value.effort);
  if (intent !== undefined) destination.add(intent);
}

function nativeIntent(value: unknown): ReasoningIntent | undefined {
  if (value === "none") return "off";
  return typeof value === "string" && KNOWN_INTENTS.has(value as ReasoningIntent)
    ? (value as ReasoningIntent)
    : undefined;
}

function safeRevision(row: Record<string, unknown>): string | null {
  for (const value of [row.revision, row.model_revision, row.canonical_slug]) {
    if (typeof value === "string" && value.trim().length > 0) return sanitizeSafeText(value, 256);
  }
  return null;
}

function toOpenRouterOptions(
  options: Readonly<Record<string, string | number | boolean>>,
): Record<string, unknown> {
  const effort = options["reasoning.effort"];
  if (typeof effort !== "string") return {};
  return { reasoning: { effort } };
}

function headers(credential?: string): Record<string, string> {
  return credential === undefined
    ? { accept: "application/json" }
    : { accept: "application/json", authorization: `Bearer ${credential}` };
}

async function readLimitedText(
  response: Response,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<string> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let result = "";
  let reachedEnd = false;
  const cancel = () => void reader.cancel().catch(() => undefined);
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) {
        reachedEnd = true;
        break;
      }
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new Error("Provider response exceeded its byte limit.");
      result += decoder.decode(value, { stream: true });
    }
    return result + decoder.decode();
  } finally {
    signal?.removeEventListener("abort", cancel);
    if (!reachedEnd) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

async function readJson(
  response: Response,
  maxBytes: number,
  credential: string | undefined,
  signal?: AbortSignal,
): Promise<unknown> {
  return parseJson(await readLimitedText(response, maxBytes, signal), credential);
}

function parseJson(value: string, credential?: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw failure(
      "provider_protocol_error",
      normalizeErrorMessage(error, credential === undefined ? [] : [credential]),
    );
  }
}

function parseCompletion(
  value: unknown,
  streaming: boolean,
): Readonly<{
  text?: string;
  modelId?: string;
  finishReason?: "stop" | "length" | "tool_calls" | "content_filter" | "other";
  usage?: TokenUsage;
}> {
  if (!isRecord(value) || !Array.isArray(value.choices))
    throw failure("provider_protocol_error", "OpenRouter completion did not contain choices.");
  const choice = value.choices[0];
  if (!isRecord(choice))
    throw failure("provider_protocol_error", "OpenRouter completion choice was malformed.");
  const container = streaming ? choice.delta : choice.message;
  const text =
    isRecord(container) && typeof container.content === "string" ? container.content : undefined;
  const model = ModelIdSchema.safeParse(value.model);
  const usage = TokenUsageSchema.safeParse(
    isRecord(value.usage)
      ? {
          inputTokens: value.usage.prompt_tokens,
          outputTokens: value.usage.completion_tokens,
          totalTokens: value.usage.total_tokens,
        }
      : undefined,
  );
  const finishReason = normalizeFinishReason(choice.finish_reason);
  return {
    ...(text === undefined ? {} : { text }),
    ...(model.success ? { modelId: model.data } : {}),
    ...(finishReason === undefined ? {} : { finishReason }),
    ...(usage.success ? { usage: usage.data } : {}),
  };
}

function normalizeFinishReason(
  value: unknown,
): "stop" | "length" | "tool_calls" | "content_filter" | "other" | undefined {
  if (value === null || value === undefined) return undefined;
  if (
    value === "stop" ||
    value === "length" ||
    value === "tool_calls" ||
    value === "content_filter"
  )
    return value;
  return "other";
}

function parseBaseUrl(value: string): URL {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim())
    throw new TypeError(
      "Provider base URL must be a non-empty URL without surrounding whitespace.",
    );
  if (value.includes("?") || value.includes("#"))
    throw new TypeError("Provider base URL must not include query parameters or a fragment.");
  let parsed: URL;
  try {
    parsed = new URL(value.endsWith("/") ? value : `${value}/`);
  } catch {
    throw new TypeError("Provider base URL must be a valid absolute URL.");
  }
  if (parsed.username.length > 0 || parsed.password.length > 0)
    throw new TypeError("Provider base URL must not contain credentials.");
  if (parsed.protocol === "https:") return parsed;
  if (
    parsed.protocol === "http:" &&
    (parsed.hostname === "localhost" ||
      parsed.hostname === "127.0.0.1" ||
      parsed.hostname === "[::1]")
  )
    return parsed;
  throw new TypeError("Provider base URL must use HTTPS unless it is a loopback endpoint.");
}

function boundedPositiveSafeInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
  name: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0 || resolved > maximum)
    throw new TypeError(`${name} must be a positive safe integer no greater than ${maximum}.`);
  return resolved;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function isBodyLimitError(error: unknown): error is Error {
  return (
    error instanceof Error &&
    [
      "Provider response exceeded its byte limit.",
      "Provider stream exceeded its byte limit.",
      "Provider stream event exceeded its byte limit.",
      "Provider stream event exceeded its line limit.",
    ].includes(error.message)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
