import {
  CanonicalModelIdSchema,
  type CapabilityRequirements,
  canonicalModelId,
  type ErrorCode,
  ModelCapabilitiesSchema,
  type ModelCatalog,
  ModelCatalogSchema,
  type ModelDescriptor,
  ModelIdSchema,
  type ModelSelectionRequest,
  ModelSelectionSchema,
  NormalizedErrorSchema,
  ProviderDescriptorSchema,
  ProviderIdSchema,
  SafeTextSchema,
} from "@researk/contracts";
import {
  HarnessError,
  type ProviderAdapter,
  type ProviderContext,
  type ResolvedProviderSelection,
} from "./provider.js";
import { sanitizeSafeText } from "./security.js";

export class ProviderRegistry {
  readonly #adapters = new Map<string, ProviderAdapter>();

  register(adapter: ProviderAdapter): void {
    const descriptor = ProviderDescriptorSchema.parse(adapter.descriptor);
    if (this.#adapters.has(descriptor.providerId)) {
      throw failure(
        "duplicate_provider",
        `Provider '${descriptor.providerId}' is already registered.`,
        {
          providerId: descriptor.providerId,
        },
      );
    }
    this.#adapters.set(descriptor.providerId, adapter);
  }

  get(providerId: string): ProviderAdapter {
    const parsed = ProviderIdSchema.parse(providerId);
    const adapter = this.#adapters.get(parsed);
    if (adapter === undefined) {
      throw failure("provider_not_found", `Provider '${parsed}' is not registered.`, {
        providerId: parsed,
      });
    }
    return adapter;
  }

  async discover(providerId: string, context: ProviderContext): Promise<ModelCatalog> {
    const adapter = this.get(providerId);
    return sanitizeCatalog(await adapter.discoverModels(context), adapter);
  }

  async resolve(
    requested: ModelSelectionRequest,
    requirements: CapabilityRequirements,
    context: ProviderContext,
  ): Promise<Readonly<{ adapter: ProviderAdapter; resolved: ResolvedProviderSelection }>> {
    const adapter = this.get(requested.providerId);
    const catalog = await this.discover(requested.providerId, context);
    const model = catalog.models.find((candidate) => candidate.modelId === requested.modelId);
    if (model === undefined) {
      throw failure(
        "model_not_found",
        `Model '${requested.modelId}' was not found for provider '${requested.providerId}'.`,
        {
          providerId: requested.providerId,
          modelId: requested.modelId,
        },
      );
    }
    assertCapabilities(model, requirements);
    const resolvedReasoning = await adapter.resolveReasoning(model, requested.reasoning);
    const selection = ModelSelectionSchema.parse({
      providerId: requested.providerId,
      modelId: requested.modelId,
      canonicalId: canonicalModelId(requested.providerId, requested.modelId),
      ...(model.revision === undefined ? {} : { revision: model.revision }),
      capabilities: model.capabilities,
      reasoning: resolvedReasoning.reasoning,
    });
    return {
      adapter,
      resolved: { selection, nativeOptions: Object.freeze({ ...resolvedReasoning.nativeOptions }) },
    };
  }
}

function sanitizeCatalog(catalog: ModelCatalog, adapter: ProviderAdapter): ModelCatalog {
  const parsedProvider = ProviderDescriptorSchema.parse(adapter.descriptor);
  const raw = catalog as unknown as Record<string, unknown>;
  const rawModels = Array.isArray(raw.models) ? raw.models : [];
  const seen = new Set<string>();
  const models: ModelDescriptor[] = [];

  for (const item of rawModels) {
    if (typeof item !== "object" || item === null) continue;
    const candidate = item as Record<string, unknown>;
    const modelId = ModelIdSchema.safeParse(candidate.modelId);
    const capabilities = ModelCapabilitiesSchema.safeParse(candidate.capabilities);
    if (!modelId.success || !capabilities.success || seen.has(modelId.data)) continue;
    const suppliedProvider = ProviderIdSchema.safeParse(candidate.providerId);
    const suppliedCanonical = CanonicalModelIdSchema.safeParse(candidate.canonicalId);
    const expectedCanonical = canonicalModelId(parsedProvider.providerId, modelId.data);
    if (
      !suppliedProvider.success ||
      suppliedProvider.data !== parsedProvider.providerId ||
      !suppliedCanonical.success ||
      suppliedCanonical.data !== expectedCanonical
    ) {
      throw failure("model_substitution", "Discovered model identity did not match its provider.", {
        providerId: parsedProvider.providerId,
        modelId: modelId.data,
      });
    }
    seen.add(modelId.data);
    const displayName = SafeTextSchema.safeParse(candidate.displayName);
    const revision =
      typeof candidate.revision === "string" ? sanitizeSafeText(candidate.revision) : undefined;
    models.push({
      providerId: parsedProvider.providerId,
      modelId: modelId.data,
      canonicalId: expectedCanonical,
      displayName: displayName.success ? displayName.data : sanitizeSafeText(modelId.data),
      ...(revision === undefined ? {} : { revision }),
      capabilities: capabilities.data,
      status:
        candidate.status === "available" || candidate.status === "unavailable"
          ? candidate.status
          : "unknown",
      catalogSource:
        candidate.catalogSource === "cache" || candidate.catalogSource === "configured"
          ? candidate.catalogSource
          : "live",
      ...(typeof candidate.discoveredAt === "string"
        ? { discoveredAt: candidate.discoveredAt }
        : {}),
    });
  }

  return ModelCatalogSchema.parse({
    provider: parsedProvider,
    models,
    source: raw.source === "cache" || raw.source === "configured" ? raw.source : "live",
    refreshedAt: raw.refreshedAt,
    stale: raw.stale === true,
  });
}

function assertCapabilities(model: ModelDescriptor, required: CapabilityRequirements): void {
  const missing: string[] = [];
  for (const key of ["streaming", "toolCalls", "structuredOutput", "vision", "files"] as const) {
    if (required[key] === true && !model.capabilities[key]) missing.push(key);
  }
  if (
    required.minimumContextWindowTokens !== undefined &&
    (model.capabilities.contextWindowTokens ?? 0) < required.minimumContextWindowTokens
  )
    missing.push("contextWindowTokens");
  if (
    required.minimumOutputTokens !== undefined &&
    (model.capabilities.maxOutputTokens ?? 0) < required.minimumOutputTokens
  )
    missing.push("maxOutputTokens");
  if (
    required.reasoningIntent !== undefined &&
    (!model.capabilities.reasoning.supported ||
      !model.capabilities.reasoning.intents.includes(required.reasoningIntent))
  )
    missing.push(`reasoning:${required.reasoningIntent}`);
  if (missing.length > 0) {
    throw failure(
      "capability_missing",
      `Model is missing required capabilities: ${missing.join(", ")}.`,
      {
        providerId: model.providerId,
        modelId: model.modelId,
      },
    );
  }
}

export function failure(
  code: ErrorCode,
  message: string,
  fields: Readonly<{
    providerId?: string;
    modelId?: string;
    httpStatus?: number;
    retryable?: boolean;
  }> = {},
): HarnessError {
  return new HarnessError(
    NormalizedErrorSchema.parse({
      code,
      message: sanitizeSafeText(message),
      retryable: fields.retryable ?? false,
      ...(fields.providerId === undefined ? {} : { providerId: fields.providerId }),
      ...(fields.modelId === undefined ? {} : { modelId: fields.modelId }),
      ...(fields.httpStatus === undefined ? {} : { httpStatus: fields.httpStatus }),
    }),
  );
}
