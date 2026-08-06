import { z } from "zod";
import { ModelIdSchema, ProviderIdSchema, SafeTextSchema } from "./ids.js";

export const ErrorCodeSchema = z.enum([
  "cancelled",
  "timeout",
  "invalid_request",
  "duplicate_provider",
  "provider_not_found",
  "model_not_found",
  "model_substitution",
  "capability_missing",
  "credential_unavailable",
  "provider_http_error",
  "provider_protocol_error",
  "provider_unavailable",
  "approval_required",
  "permission_denied",
  "internal_error",
]);

export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

const ErrorDetailValueSchema = z.union([z.string().max(1024), z.number().finite(), z.boolean()]);

export const NormalizedErrorSchema = z
  .object({
    code: ErrorCodeSchema,
    message: SafeTextSchema,
    retryable: z.boolean(),
    providerId: ProviderIdSchema.optional(),
    modelId: ModelIdSchema.optional(),
    httpStatus: z.number().int().min(100).max(599).optional(),
    details: z.record(z.string().max(64), ErrorDetailValueSchema).readonly().optional(),
  })
  .strict()
  .readonly();

export type NormalizedError = z.infer<typeof NormalizedErrorSchema>;
