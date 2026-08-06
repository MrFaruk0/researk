import {
  canonicalModelId,
  EffectiveReasoningSchema,
  type ModelCapabilities,
  ModelCapabilitiesSchema,
  ModelCatalogSchema,
  type ModelDescriptor,
  ModelIdSchema,
  type NativeReasoningValue,
  type ProviderDescriptor,
  ProviderDescriptorSchema,
  type ReasoningIntent,
  ReasoningIntentSchema,
  type ReasoningRequest,
  type TokenUsage,
  TokenUsageSchema,
} from "@researk/contracts";
import {
  failure,
  normalizeErrorMessage,
  type ProviderAdapter,
  type ProviderContext,
  type ProviderStreamEvent,
  redactSecrets,
  sanitizeSafeText,
  sanitizeUntrustedText,
} from "@researk/harness";
import { parseSse } from "./sse.js";

export interface ReasoningMapping {
  readonly field: string;
  readonly value: NativeReasoningValue;
  readonly effectiveIntent?: ReasoningIntent;
}

export interface OpenAiCompatibleOptions {
  readonly providerId: string;
  readonly displayName: string;
  readonly baseUrl: string;
  readonly apiKeyReference?: string;
  readonly kind?: "remote" | "local" | "custom";
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
  readonly maxBodyBytes?: number;
  readonly capabilities?: Readonly<Record<string, ModelCapabilities>>;
  readonly reasoning?: Partial<Readonly<Record<ReasoningIntent, ReasoningMapping>>>;
}

const CONSERVATIVE_CAPABILITIES = ModelCapabilitiesSchema.parse({
  streaming: false,
  toolCalls: false,
  structuredOutput: false,
  vision: false,
  files: false,
  reasoning: { supported: false, intents: [], nativeOverride: false },
});

export class OpenAiCompatibleAdapter implements ProviderAdapter {
  readonly descriptor: ProviderDescriptor;
  readonly #baseUrl: URL;
  readonly #apiKeyReference: string | undefined;
  readonly #fetch: typeof globalThis.fetch;
  readonly #timeoutMs: number;
  readonly #maxBodyBytes: number;
  readonly #capabilities: Readonly<Record<string, ModelCapabilities>>;
  readonly #reasoning: Partial<Readonly<Record<ReasoningIntent, ReasoningMapping>>>;

  constructor(options: OpenAiCompatibleOptions) {
    this.descriptor = ProviderDescriptorSchema.parse({
      providerId: options.providerId,
      displayName: sanitizeSafeText(options.displayName),
      kind: options.kind ?? "custom",
    });
    this.#baseUrl = new URL(
      options.baseUrl.endsWith("/") ? options.baseUrl : `${options.baseUrl}/`,
    );
    if (
      this.#baseUrl.protocol !== "https:" &&
      this.#baseUrl.hostname !== "localhost" &&
      this.#baseUrl.hostname !== "127.0.0.1"
    ) {
      throw new TypeError("Provider base URL must use HTTPS unless it is local.");
    }
    this.#apiKeyReference = options.apiKeyReference;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeoutMs = options.timeoutMs ?? 120_000;
    this.#maxBodyBytes = options.maxBodyBytes ?? 16_000_000;
    this.#capabilities = options.capabilities ?? {};
    this.#reasoning = options.reasoning ?? {};
  }

  async discoverModels(context: ProviderContext) {
    const credential = await this.#credential(context);
    const response = await this.#request(
      "models",
      { method: "GET", headers: headers(credential) },
      context,
      credential,
    );
    const value = await readJson(
      response,
      this.#maxBodyBytes,
      credential === undefined ? [] : [credential],
    );
    const rows = isRecord(value) && Array.isArray(value.data) ? value.data : undefined;
    if (rows === undefined) throw this.#protocol("Model catalog did not contain a data array.");
    const now = new Date().toISOString();
    const models: ModelDescriptor[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      if (!isRecord(row)) continue;
      const parsedId = ModelIdSchema.safeParse(row.id);
      if (!parsedId.success || seen.has(parsedId.data)) continue;
      seen.add(parsedId.data);
      const capability = this.#capabilities[parsedId.data] ?? CONSERVATIVE_CAPABILITIES;
      models.push({
        providerId: this.descriptor.providerId,
        modelId: parsedId.data,
        canonicalId: canonicalModelId(this.descriptor.providerId, parsedId.data),
        displayName: sanitizeSafeText(parsedId.data),
        capabilities: capability,
        status: this.#capabilities[parsedId.data] === undefined ? "unknown" : "available",
        catalogSource: "live",
        discoveredAt: now,
      });
    }
    return ModelCatalogSchema.parse({
      provider: this.descriptor,
      models,
      source: "live",
      refreshedAt: now,
      stale: false,
    });
  }

  async resolveReasoning(model: ModelDescriptor, request: ReasoningRequest) {
    if (request.nativeOverride !== undefined) {
      throw failure(
        "capability_missing",
        "Native reasoning overrides are not enabled for this adapter.",
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
    const mapping = this.#reasoning[ReasoningIntentSchema.parse(request.intent)];
    if (mapping === undefined) {
      throw failure(
        "capability_missing",
        `Reasoning intent '${request.intent}' has no configured mapping.`,
        {
          providerId: model.providerId,
          modelId: model.modelId,
        },
      );
    }
    return {
      reasoning: EffectiveReasoningSchema.parse({
        requestedIntent: request.intent,
        effectiveIntent: mapping.effectiveIntent ?? request.intent,
        nativeField: mapping.field,
        nativeValue: mapping.value,
        usedNativeOverride: false,
        diagnostics: [],
      }),
      nativeOptions: Object.freeze({ [mapping.field]: mapping.value }),
    };
  }

  async *stream(
    request: Parameters<ProviderAdapter["stream"]>[0],
    context: ProviderContext,
  ): AsyncIterable<ProviderStreamEvent> {
    const credential = await this.#credential(context);
    const response = await this.#request(
      "chat/completions",
      {
        method: "POST",
        headers: { ...headers(credential), "content-type": "application/json" },
        body: JSON.stringify({
          model: request.resolved.selection.modelId,
          messages: request.run.messages,
          stream: request.run.stream,
          ...request.resolved.nativeOptions,
        }),
      },
      context,
      credential,
    );
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (contentType.includes("text/event-stream")) {
      if (response.body === null) throw this.#protocol("Provider returned an empty event stream.");
      let completed = false;
      for await (const sse of parseSse(response.body, {
        signal: context.signal,
        maxBytes: this.#maxBodyBytes,
      })) {
        if (sse.data.trim() === "[DONE]") {
          if (!completed) yield { type: "completed", finishReason: "stop" };
          return;
        }
        const chunk = parseJson(sse.data, credential === undefined ? [] : [credential]);
        const parsed = parseCompletion(chunk, true);
        if (parsed.modelId !== undefined && parsed.modelId !== request.resolved.selection.modelId) {
          throw failure("model_substitution", "The provider returned a different model.", {
            providerId: this.descriptor.providerId,
            modelId: request.resolved.selection.modelId,
          });
        }
        if (parsed.text !== undefined && parsed.text.length > 0) {
          yield {
            type: "text_delta",
            delta: sanitizeUntrustedText(parsed.text, 1_000_000),
            ...(parsed.modelId === undefined ? {} : { responseModelId: parsed.modelId }),
          };
        }
        if (parsed.finishReason !== undefined) {
          yield {
            type: "completed",
            finishReason: parsed.finishReason,
            ...(parsed.usage === undefined ? {} : { usage: parsed.usage }),
            ...(parsed.modelId === undefined ? {} : { responseModelId: parsed.modelId }),
          };
          completed = true;
        }
      }
      if (!completed) throw this.#protocol("Provider event stream ended before completion.");
      return;
    }
    const value = await readJson(
      response,
      this.#maxBodyBytes,
      credential === undefined ? [] : [credential],
    );
    const parsed = parseCompletion(value, false);
    if (parsed.modelId !== undefined && parsed.modelId !== request.resolved.selection.modelId) {
      throw failure("model_substitution", "The provider returned a different model.", {
        providerId: this.descriptor.providerId,
        modelId: request.resolved.selection.modelId,
      });
    }
    if (parsed.text !== undefined && parsed.text.length > 0)
      yield {
        type: "text_delta",
        delta: sanitizeUntrustedText(parsed.text, 1_000_000),
        ...(parsed.modelId === undefined ? {} : { responseModelId: parsed.modelId }),
      };
    yield {
      type: "completed",
      finishReason: parsed.finishReason ?? "other",
      ...(parsed.usage === undefined ? {} : { usage: parsed.usage }),
      ...(parsed.modelId === undefined ? {} : { responseModelId: parsed.modelId }),
    };
  }

  async #credential(context: ProviderContext): Promise<string | undefined> {
    if (this.#apiKeyReference === undefined) return undefined;
    try {
      return await context.credentials.resolve(this.#apiKeyReference, context.signal);
    } catch (error) {
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
  ): Promise<Response> {
    const timeout = AbortSignal.timeout(this.#timeoutMs);
    const signal = AbortSignal.any([context.signal, timeout]);
    try {
      const response = await this.#fetch(new URL(path, this.#baseUrl), { ...init, signal });
      if (!response.ok) {
        const body = await readLimitedText(response, Math.min(this.#maxBodyBytes, 65_536));
        const safeBody = sanitizeSafeText(
          redactSecrets(body, credential === undefined ? [] : [credential]),
        );
        throw failure(
          "provider_http_error",
          `Provider request failed with HTTP ${response.status}: ${safeBody}`,
          {
            providerId: this.descriptor.providerId,
            httpStatus: response.status,
            retryable: response.status === 408 || response.status === 429 || response.status >= 500,
          },
        );
      }
      return response;
    } catch (error) {
      if (context.signal.aborted) throw error;
      if (timeout.aborted)
        throw failure("timeout", "The provider request timed out.", {
          providerId: this.descriptor.providerId,
        });
      if (error instanceof Error && error.name === "HarnessError") throw error;
      throw failure(
        "provider_unavailable",
        normalizeErrorMessage(error, credential === undefined ? [] : [credential]),
        {
          providerId: this.descriptor.providerId,
          retryable: true,
        },
      );
    }
  }

  #protocol(message: string) {
    return failure("provider_protocol_error", message, { providerId: this.descriptor.providerId });
  }
}

function headers(credential?: string): Record<string, string> {
  return credential === undefined
    ? { accept: "application/json" }
    : { accept: "application/json", authorization: `Bearer ${credential}` };
}

async function readLimitedText(response: Response, maxBytes: number): Promise<string> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let result = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new Error("Provider response exceeded its byte limit.");
      result += decoder.decode(value, { stream: true });
    }
    return result + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

async function readJson(
  response: Response,
  maxBytes: number,
  secrets: readonly string[],
): Promise<unknown> {
  return parseJson(await readLimitedText(response, maxBytes), secrets);
}

function parseJson(value: string, secrets: readonly string[]): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw failure("provider_protocol_error", normalizeErrorMessage(error, secrets));
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
    throw failure("provider_protocol_error", "Provider completion did not contain choices.");
  const choice = value.choices[0];
  if (!isRecord(choice))
    throw failure("provider_protocol_error", "Provider completion choice was malformed.");
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

function normalizeFinishReason(value: unknown) {
  if (value === null || value === undefined) return undefined;
  if (
    value === "stop" ||
    value === "length" ||
    value === "tool_calls" ||
    value === "content_filter"
  )
    return value;
  return "other" as const;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
