import { z } from "zod";
import { ContractSchemaVersionSchema, EntityIdSchema, RunIdSchema, SafeTextSchema } from "./ids.js";
import { CapabilityRequirementsSchema, ModelSelectionRequestSchema } from "./model.js";
import { ToolPermissionSchema } from "./tools.js";

export const ChatRoleSchema = z.enum(["system", "user", "assistant", "tool"]);

export type ChatRole = z.infer<typeof ChatRoleSchema>;

export const ChatMessageSchema = z
  .object({
    role: ChatRoleSchema,
    content: z.string().max(16_000_000),
    name: SafeTextSchema.optional(),
    toolCallId: EntityIdSchema.optional(),
  })
  .strict()
  .readonly();

export type ChatMessage = z.infer<typeof ChatMessageSchema>;

export const RunRequestSchema = z
  .object({
    schemaVersion: ContractSchemaVersionSchema,
    runId: RunIdSchema,
    selection: ModelSelectionRequestSchema,
    messages: z.array(ChatMessageSchema).min(1).max(10_000).readonly(),
    requiredCapabilities: CapabilityRequirementsSchema.default({}),
    toolPermissions: z.array(ToolPermissionSchema).max(256).readonly().default([]),
    stream: z.boolean().default(true),
    timeoutMs: z.number().int().positive().max(3_600_000).optional(),
  })
  .strict()
  .readonly();

export type RunRequest = z.infer<typeof RunRequestSchema>;

export const TokenUsageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    totalTokens: z.number().int().nonnegative().optional(),
  })
  .strict()
  .readonly();

export type TokenUsage = z.infer<typeof TokenUsageSchema>;
