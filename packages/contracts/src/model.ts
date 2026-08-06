import { z } from "zod";
import {
  CanonicalModelIdSchema,
  IsoDateTimeSchema,
  ModelIdSchema,
  ProviderIdSchema,
  SafeTextSchema,
} from "./ids.js";

export const ReasoningIntentSchema = z.enum([
  "auto",
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);

export type ReasoningIntent = z.infer<typeof ReasoningIntentSchema>;

export const NativeReasoningValueSchema = z.union([
  z.string().max(256),
  z.number().finite(),
  z.boolean(),
]);

export type NativeReasoningValue = z.infer<typeof NativeReasoningValueSchema>;

export const NativeReasoningOverrideSchema = z
  .object({
    field: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z][A-Za-z0-9_.-]*$/u),
    value: NativeReasoningValueSchema,
  })
  .strict()
  .readonly();

export type NativeReasoningOverride = z.infer<typeof NativeReasoningOverrideSchema>;

export const ReasoningRequestSchema = z
  .object({
    intent: ReasoningIntentSchema.default("auto"),
    nativeOverride: NativeReasoningOverrideSchema.optional(),
  })
  .strict()
  .readonly();

export type ReasoningRequest = z.infer<typeof ReasoningRequestSchema>;

export const ReasoningCapabilitiesSchema = z
  .object({
    supported: z.boolean(),
    intents: z.array(ReasoningIntentSchema).max(7).readonly(),
    nativeOverride: z.boolean(),
    defaultIntent: ReasoningIntentSchema.optional(),
    mandatory: z.boolean().default(false),
    supportsMaxTokens: z.boolean().default(false),
  })
  .strict()
  .readonly()
  .superRefine((value, context) => {
    if (!value.supported && value.intents.length > 0) {
      context.addIssue({ code: "custom", message: "Unsupported reasoning cannot list intents" });
    }
    if (new Set(value.intents).size !== value.intents.length) {
      context.addIssue({ code: "custom", message: "Reasoning intents must be unique" });
    }
    if (!value.supported && value.defaultIntent !== undefined) {
      context.addIssue({ code: "custom", message: "Unsupported reasoning cannot have a default" });
    }
    if (value.defaultIntent !== undefined && !value.intents.includes(value.defaultIntent)) {
      context.addIssue({ code: "custom", message: "Reasoning default must be an accepted intent" });
    }
    if (value.mandatory && !value.supported) {
      context.addIssue({ code: "custom", message: "Mandatory reasoning must be supported" });
    }
    if (value.mandatory && value.intents.includes("off")) {
      context.addIssue({ code: "custom", message: "Mandatory reasoning cannot accept off" });
    }
    if (value.supportsMaxTokens && !value.supported) {
      context.addIssue({
        code: "custom",
        message: "Reasoning max-token controls require reasoning support",
      });
    }
  });

export type ReasoningCapabilities = z.infer<typeof ReasoningCapabilitiesSchema>;

export const ModelCapabilitiesSchema = z
  .object({
    streaming: z.boolean(),
    toolCalls: z.boolean(),
    structuredOutput: z.boolean(),
    vision: z.boolean(),
    files: z.boolean(),
    contextWindowTokens: z.number().int().positive().optional(),
    maxOutputTokens: z.number().int().positive().optional(),
    reasoning: ReasoningCapabilitiesSchema,
  })
  .strict()
  .readonly();

export type ModelCapabilities = z.infer<typeof ModelCapabilitiesSchema>;

export const CapabilityRequirementsSchema = z
  .object({
    streaming: z.literal(true).optional(),
    toolCalls: z.literal(true).optional(),
    structuredOutput: z.literal(true).optional(),
    vision: z.literal(true).optional(),
    files: z.literal(true).optional(),
    minimumContextWindowTokens: z.number().int().positive().optional(),
    minimumOutputTokens: z.number().int().positive().optional(),
    reasoningIntent: ReasoningIntentSchema.optional(),
  })
  .strict()
  .readonly();

export type CapabilityRequirements = z.infer<typeof CapabilityRequirementsSchema>;

export const ProviderDescriptorSchema = z
  .object({
    providerId: ProviderIdSchema,
    displayName: SafeTextSchema,
    kind: z.enum(["remote", "local", "custom"]),
  })
  .strict()
  .readonly();

export type ProviderDescriptor = z.infer<typeof ProviderDescriptorSchema>;

export const ModelDescriptorSchema = z
  .object({
    providerId: ProviderIdSchema,
    modelId: ModelIdSchema,
    canonicalId: CanonicalModelIdSchema,
    displayName: SafeTextSchema,
    revision: SafeTextSchema.nullable().default(null),
    capabilities: ModelCapabilitiesSchema,
    status: z.enum(["available", "unavailable", "unknown"]),
    catalogSource: z.enum(["live", "cache", "configured"]),
    discoveredAt: IsoDateTimeSchema.optional(),
  })
  .strict()
  .readonly()
  .superRefine((value, context) => {
    if (value.canonicalId !== `${value.providerId}:${value.modelId}`) {
      context.addIssue({ code: "custom", message: "Canonical model identity does not match" });
    }
  });

export type ModelDescriptor = z.infer<typeof ModelDescriptorSchema>;

export const ModelCatalogSchema = z
  .object({
    provider: ProviderDescriptorSchema,
    models: z.array(ModelDescriptorSchema).readonly(),
    source: z.enum(["live", "cache", "configured"]),
    refreshedAt: IsoDateTimeSchema,
    stale: z.boolean(),
  })
  .strict()
  .readonly()
  .superRefine((value, context) => {
    const identities = new Set<string>();
    for (const model of value.models) {
      if (model.providerId !== value.provider.providerId) {
        context.addIssue({ code: "custom", message: "Catalog contains a different provider" });
      }
      if (identities.has(model.canonicalId)) {
        context.addIssue({ code: "custom", message: "Catalog contains a duplicate model" });
      }
      identities.add(model.canonicalId);
    }
  });

export type ModelCatalog = z.infer<typeof ModelCatalogSchema>;

export const ModelSelectionRequestSchema = z
  .object({
    providerId: ProviderIdSchema,
    modelId: ModelIdSchema,
    reasoning: ReasoningRequestSchema.default({ intent: "auto" }),
  })
  .strict()
  .readonly();

export type ModelSelectionRequest = z.infer<typeof ModelSelectionRequestSchema>;

export const EffectiveReasoningSchema = z
  .object({
    requestedIntent: ReasoningIntentSchema,
    effectiveIntent: ReasoningIntentSchema.optional(),
    nativeField: z.string().min(1).max(64).optional(),
    nativeValue: NativeReasoningValueSchema.optional(),
    usedNativeOverride: z.boolean(),
    diagnostics: z.array(SafeTextSchema).readonly(),
  })
  .strict()
  .readonly()
  .superRefine((value, context) => {
    if ((value.nativeField === undefined) !== (value.nativeValue === undefined)) {
      context.addIssue({
        code: "custom",
        message: "Native reasoning field and value must appear together",
      });
    }
    if (value.usedNativeOverride && value.nativeField === undefined) {
      context.addIssue({
        code: "custom",
        message: "A native override must record its resolved field",
      });
    }
  });

export type EffectiveReasoning = z.infer<typeof EffectiveReasoningSchema>;

export const ModelSelectionSchema = z
  .object({
    providerId: ProviderIdSchema,
    modelId: ModelIdSchema,
    canonicalId: CanonicalModelIdSchema,
    revision: SafeTextSchema.nullable().default(null),
    capabilities: ModelCapabilitiesSchema,
    reasoning: EffectiveReasoningSchema,
  })
  .strict()
  .readonly()
  .superRefine((value, context) => {
    if (value.canonicalId !== `${value.providerId}:${value.modelId}`) {
      context.addIssue({ code: "custom", message: "Canonical model identity does not match" });
    }
  });

export type ModelSelection = z.infer<typeof ModelSelectionSchema>;
