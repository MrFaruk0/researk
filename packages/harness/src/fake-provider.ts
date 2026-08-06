import {
  EffectiveReasoningSchema,
  type ModelCatalog,
  ModelCatalogSchema,
  type ModelDescriptor,
  type ProviderDescriptor,
  type ReasoningRequest,
} from "@researk/contracts";
import type { ProviderAdapter, ProviderContext, ProviderStreamEvent } from "./provider.js";
import { failure } from "./registry.js";

export interface FakeProviderOptions {
  readonly descriptor: ProviderDescriptor;
  readonly models: readonly ModelDescriptor[];
  readonly events: readonly ProviderStreamEvent[];
}

export class FakeProviderAdapter implements ProviderAdapter {
  readonly descriptor: ProviderDescriptor;
  readonly #models: readonly ModelDescriptor[];
  readonly #events: readonly ProviderStreamEvent[];

  constructor(options: FakeProviderOptions) {
    this.descriptor = options.descriptor;
    this.#models = options.models;
    this.#events = options.events;
  }

  async discoverModels(context: ProviderContext): Promise<ModelCatalog> {
    context.signal.throwIfAborted();
    return ModelCatalogSchema.parse({
      provider: this.descriptor,
      models: this.#models,
      source: "configured",
      refreshedAt: "2026-08-06T00:00:00.000Z",
      stale: false,
    });
  }

  async resolveReasoning(model: ModelDescriptor, request: ReasoningRequest) {
    if (request.nativeOverride !== undefined) {
      throw failure(
        "capability_missing",
        "The fake provider does not accept native reasoning overrides.",
        {
          providerId: model.providerId,
          modelId: model.modelId,
        },
      );
    }
    if (
      request.intent !== "auto" &&
      (!model.capabilities.reasoning.supported ||
        !model.capabilities.reasoning.intents.includes(request.intent))
    ) {
      throw failure(
        "capability_missing",
        `Reasoning intent '${request.intent}' is not supported.`,
        {
          providerId: model.providerId,
          modelId: model.modelId,
        },
      );
    }
    return {
      reasoning: EffectiveReasoningSchema.parse({
        requestedIntent: request.intent,
        ...(request.intent === "auto" ? {} : { effectiveIntent: request.intent }),
        usedNativeOverride: false,
        diagnostics: [],
      }),
      nativeOptions: {},
    };
  }

  async *stream(
    _request: Parameters<ProviderAdapter["stream"]>[0],
    context: ProviderContext,
  ): AsyncIterable<ProviderStreamEvent> {
    for (const event of this.#events) {
      context.signal.throwIfAborted();
      yield event;
    }
  }
}
