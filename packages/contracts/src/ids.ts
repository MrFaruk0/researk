import { z } from "zod";

function containsControlCharacters(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint !== undefined &&
      (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f))
    ) {
      return true;
    }
  }
  return false;
}

export const SafeTextSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !containsControlCharacters(value), "Control characters are not allowed")
  .refine((value) => value === value.trim(), "Leading and trailing whitespace are not allowed");

export type SafeText = z.infer<typeof SafeTextSchema>;

export const ProviderIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/u, "Invalid provider ID");

export type ProviderId = z.infer<typeof ProviderIdSchema>;

export const ModelIdSchema = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => !containsControlCharacters(value), "Control characters are not allowed")
  .refine((value) => value === value.trim(), "Leading and trailing whitespace are not allowed");

export type ModelId = z.infer<typeof ModelIdSchema>;

export const CanonicalModelIdSchema = z
  .string()
  .min(3)
  .max(321)
  .superRefine((value, context) => {
    const separator = value.indexOf(":");
    if (separator < 1) {
      context.addIssue({ code: "custom", message: "Expected provider:model identity" });
      return;
    }

    const providerResult = ProviderIdSchema.safeParse(value.slice(0, separator));
    const modelResult = ModelIdSchema.safeParse(value.slice(separator + 1));
    if (!providerResult.success || !modelResult.success) {
      context.addIssue({ code: "custom", message: "Invalid provider:model identity" });
    }
  });

export type CanonicalModelId = z.infer<typeof CanonicalModelIdSchema>;

export function canonicalModelId(providerId: ProviderId, modelId: ModelId): CanonicalModelId {
  return CanonicalModelIdSchema.parse(`${providerId}:${modelId}`);
}

export function splitCanonicalModelId(identity: CanonicalModelId): Readonly<{
  providerId: ProviderId;
  modelId: ModelId;
}> {
  const separator = identity.indexOf(":");
  return Object.freeze({
    providerId: ProviderIdSchema.parse(identity.slice(0, separator)),
    modelId: ModelIdSchema.parse(identity.slice(separator + 1)),
  });
}

export const RunIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/u, "Invalid run ID");

export type RunId = z.infer<typeof RunIdSchema>;

export const EntityIdSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9._:/-]*[A-Za-z0-9])?$/u, "Invalid entity ID");

export type EntityId = z.infer<typeof EntityIdSchema>;

export const IsoDateTimeSchema = z.string().datetime({ offset: true });

export const Sha256Schema = z.string().regex(/^sha256:[a-f0-9]{64}$/u, "Invalid SHA-256 value");

export const ContractSchemaVersionSchema = z.literal(1);

export type ContractSchemaVersion = z.infer<typeof ContractSchemaVersionSchema>;
