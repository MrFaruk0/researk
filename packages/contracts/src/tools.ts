import { z } from "zod";
import { EntityIdSchema, SafeTextSchema } from "./ids.js";

export const ToolPermissionKindSchema = z.enum([
  "network",
  "filesystem_read",
  "filesystem_write",
  "process_execute",
  "credential_use",
]);

export type ToolPermissionKind = z.infer<typeof ToolPermissionKindSchema>;

export const ToolPermissionSchema = z
  .object({
    permissionId: EntityIdSchema,
    kind: ToolPermissionKindSchema,
    resource: SafeTextSchema,
    description: SafeTextSchema,
    access: z.enum(["once", "run"]),
  })
  .strict()
  .readonly();

export type ToolPermission = z.infer<typeof ToolPermissionSchema>;

export const ApprovalKindSchema = z.enum(["tool", "reproduction"]);

export type ApprovalKind = z.infer<typeof ApprovalKindSchema>;

export const ApprovalDecisionSchema = z.enum(["approved", "denied", "cancelled"]);

export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;
