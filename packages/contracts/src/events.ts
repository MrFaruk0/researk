import { z } from "zod";
import { NormalizedErrorSchema } from "./errors.js";
import {
  ContractSchemaVersionSchema,
  EntityIdSchema,
  IsoDateTimeSchema,
  RunIdSchema,
  SafeTextSchema,
  Sha256Schema,
} from "./ids.js";
import { ModelSelectionSchema } from "./model.js";
import { TokenUsageSchema } from "./run.js";
import { ApprovalDecisionSchema, ApprovalKindSchema, ToolPermissionSchema } from "./tools.js";

const RunEventBaseShape = {
  schemaVersion: ContractSchemaVersionSchema,
  runId: RunIdSchema,
  sequence: z.number().int().nonnegative(),
  timestamp: IsoDateTimeSchema,
};

export const RunPhaseSchema = z.enum([
  "selection",
  "planning",
  "retrieval",
  "evidence",
  "context",
  "generation",
  "verification",
  "tool",
  "reproduction",
  "completion",
]);

export type RunPhase = z.infer<typeof RunPhaseSchema>;

export const PhaseEventSchema = z
  .object({
    ...RunEventBaseShape,
    type: z.literal("phase"),
    phase: RunPhaseSchema,
    status: z.enum(["started", "progress", "completed"]),
    message: SafeTextSchema.optional(),
    progress: z.number().min(0).max(1).optional(),
  })
  .strict();

export const SelectionEventSchema = z
  .object({
    ...RunEventBaseShape,
    type: z.literal("selection"),
    selection: ModelSelectionSchema,
  })
  .strict();

export const SourceReferenceSchema = z
  .object({
    sourceId: EntityIdSchema,
    title: SafeTextSchema.optional(),
    url: z.string().url().max(4096).optional(),
    doi: z.string().min(1).max(512).optional(),
    accessedAt: IsoDateTimeSchema.optional(),
    contentHash: Sha256Schema.optional(),
  })
  .strict()
  .readonly();

export type SourceReference = z.infer<typeof SourceReferenceSchema>;

export const SourceEventSchema = z
  .object({
    ...RunEventBaseShape,
    type: z.literal("source"),
    action: z.enum(["discovered", "retrieved", "used"]),
    source: SourceReferenceSchema,
  })
  .strict();

export const EvidenceReferenceSchema = z
  .object({
    evidenceId: EntityIdSchema,
    sourceId: EntityIdSchema,
    claimId: EntityIdSchema.optional(),
    locator: SafeTextSchema.optional(),
    verificationState: z.enum(["unverified", "supported", "conflicting", "unsupported"]),
  })
  .strict()
  .readonly();

export type EvidenceReference = z.infer<typeof EvidenceReferenceSchema>;

export const EvidenceEventSchema = z
  .object({
    ...RunEventBaseShape,
    type: z.literal("evidence"),
    evidence: EvidenceReferenceSchema,
  })
  .strict();

export const ApprovalRequestEventSchema = z
  .object({
    ...RunEventBaseShape,
    type: z.literal("approval_request"),
    approvalId: EntityIdSchema,
    kind: ApprovalKindSchema,
    title: SafeTextSchema,
    description: SafeTextSchema,
    permissions: z.array(ToolPermissionSchema).min(1).max(256).readonly(),
  })
  .strict();

export const ApprovalResultEventSchema = z
  .object({
    ...RunEventBaseShape,
    type: z.literal("approval_result"),
    approvalId: EntityIdSchema,
    decision: ApprovalDecisionSchema,
    grantedPermissions: z.array(ToolPermissionSchema).max(256).readonly(),
  })
  .strict();

export const TextDeltaEventSchema = z
  .object({
    ...RunEventBaseShape,
    type: z.literal("text_delta"),
    delta: z.string().min(1).max(1_000_000),
  })
  .strict();

export const DiagnosticEventSchema = z
  .object({
    ...RunEventBaseShape,
    type: z.literal("diagnostic"),
    level: z.enum(["debug", "info", "warning", "error"]),
    code: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-z][a-z0-9_.-]*$/u),
    message: SafeTextSchema,
  })
  .strict();

export const CompletedEventSchema = z
  .object({
    ...RunEventBaseShape,
    type: z.literal("completed"),
    selection: ModelSelectionSchema,
    finishReason: z.enum(["stop", "length", "tool_calls", "content_filter", "other"]),
    usage: TokenUsageSchema.optional(),
    outputHash: Sha256Schema.optional(),
  })
  .strict();

export const CancelledEventSchema = z
  .object({
    ...RunEventBaseShape,
    type: z.literal("cancelled"),
    reason: SafeTextSchema.optional(),
  })
  .strict();

export const ErrorEventSchema = z
  .object({
    ...RunEventBaseShape,
    type: z.literal("error"),
    error: NormalizedErrorSchema,
  })
  .strict();

export const RunEventSchema = z
  .discriminatedUnion("type", [
    PhaseEventSchema,
    SelectionEventSchema,
    SourceEventSchema,
    EvidenceEventSchema,
    ApprovalRequestEventSchema,
    ApprovalResultEventSchema,
    TextDeltaEventSchema,
    DiagnosticEventSchema,
    CompletedEventSchema,
    CancelledEventSchema,
    ErrorEventSchema,
  ])
  .readonly();

export type RunEvent = z.infer<typeof RunEventSchema>;
export type PhaseEvent = z.infer<typeof PhaseEventSchema>;
export type SelectionEvent = z.infer<typeof SelectionEventSchema>;
export type SourceEvent = z.infer<typeof SourceEventSchema>;
export type EvidenceEvent = z.infer<typeof EvidenceEventSchema>;
export type ApprovalRequestEvent = z.infer<typeof ApprovalRequestEventSchema>;
export type ApprovalResultEvent = z.infer<typeof ApprovalResultEventSchema>;
export type TextDeltaEvent = z.infer<typeof TextDeltaEventSchema>;
export type DiagnosticEvent = z.infer<typeof DiagnosticEventSchema>;
export type CompletedEvent = z.infer<typeof CompletedEventSchema>;
export type CancelledEvent = z.infer<typeof CancelledEventSchema>;
export type ErrorEvent = z.infer<typeof ErrorEventSchema>;
