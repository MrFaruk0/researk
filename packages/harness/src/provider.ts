import type {
  EffectiveReasoning,
  ModelCatalog,
  ModelDescriptor,
  ModelSelection,
  NativeReasoningValue,
  NormalizedError,
  ProviderDescriptor,
  ReasoningRequest,
  RunRequest,
  TokenUsage,
} from "@researk/contracts";

export interface CredentialResolver {
  resolve(reference: string, signal: AbortSignal): Promise<string>;
}

export interface ProviderContext {
  readonly credentials: CredentialResolver;
  readonly signal: AbortSignal;
}

export interface ResolvedProviderSelection {
  readonly selection: ModelSelection;
  readonly nativeOptions: Readonly<Record<string, NativeReasoningValue>>;
}

export type ProviderStreamEvent =
  | Readonly<{ type: "text_delta"; delta: string; responseModelId?: string }>
  | Readonly<{
      type: "completed";
      finishReason: "stop" | "length" | "tool_calls" | "content_filter" | "other";
      usage?: TokenUsage;
      responseModelId?: string;
    }>;

export interface ProviderAdapter {
  readonly descriptor: ProviderDescriptor;
  discoverModels(context: ProviderContext): Promise<ModelCatalog>;
  resolveReasoning(
    model: ModelDescriptor,
    request: ReasoningRequest,
  ): Promise<
    Readonly<{
      reasoning: EffectiveReasoning;
      nativeOptions: Readonly<Record<string, NativeReasoningValue>>;
    }>
  >;
  stream(
    request: Readonly<{ run: RunRequest; resolved: ResolvedProviderSelection }>,
    context: ProviderContext,
  ): AsyncIterable<ProviderStreamEvent>;
}

export class HarnessError extends Error {
  readonly normalized: NormalizedError;

  constructor(error: NormalizedError) {
    super(error.message);
    this.name = "HarnessError";
    this.normalized = error;
  }
}
