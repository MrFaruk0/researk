import type { ApprovalKind, CapabilityRequirements, ToolPermissionKind } from "@researk/contracts";

export type WorkflowId =
  | "literature-research"
  | "scientific-writing-revision"
  | "reproduction-planning";

export interface ApprovalDeclaration {
  readonly id: string;
  readonly kind: ApprovalKind;
  readonly trigger: string;
  readonly permissions: readonly ToolPermissionKind[];
}

export interface WorkflowLimits {
  readonly maximumModelTurns: number;
  readonly maximumToolCalls: number;
  readonly maximumDurationMs: number;
}

export interface ResearchWorkflowDescriptor {
  readonly id: WorkflowId;
  readonly displayName: string;
  readonly description: string;
  readonly implementationStatus: "metadata-only";
  readonly supported: false;
  readonly requiredCapabilities: CapabilityRequirements;
  readonly allowedTools: readonly string[];
  readonly approvals: readonly ApprovalDeclaration[];
  readonly limits: WorkflowLimits;
  readonly autonomousNetworkAccess: false;
  readonly autonomousCodeExecution: false;
}

export type PublicationProfileId = "apa-7" | "ieee";

export interface PublicationProfileDescriptor {
  readonly id: PublicationProfileId;
  readonly displayName: string;
  readonly status: "planned";
  readonly supported: false;
  readonly processor: "unavailable";
  readonly intendedProcessor: "csl-citeproc";
  readonly exportTargets: readonly ["markdown", "latex"];
}

const WORKFLOWS = Object.freeze([
  Object.freeze({
    id: "literature-research",
    displayName: "Literature research",
    description: "Discover sources and assemble traceable evidence with explicit network approval.",
    implementationStatus: "metadata-only",
    supported: false,
    requiredCapabilities: Object.freeze({ streaming: true, toolCalls: true }),
    allowedTools: Object.freeze(["scholarly-search", "web-retrieval", "source-ingestion"]),
    approvals: Object.freeze([
      Object.freeze({
        id: "literature-network",
        kind: "tool",
        trigger: "Before contacting each undeclared scholarly or web destination.",
        permissions: Object.freeze(["network"] as const),
      }),
    ]),
    limits: Object.freeze({
      maximumModelTurns: 6,
      maximumToolCalls: 12,
      maximumDurationMs: 600_000,
    }),
    autonomousNetworkAccess: false,
    autonomousCodeExecution: false,
  }),
  Object.freeze({
    id: "scientific-writing-revision",
    displayName: "Scientific writing and revision",
    description:
      "Plan, draft, analyze, and revise manuscript content while keeping writes reviewable.",
    implementationStatus: "metadata-only",
    supported: false,
    requiredCapabilities: Object.freeze({ streaming: true }),
    allowedTools: Object.freeze(["workspace-read", "manuscript-diff"]),
    approvals: Object.freeze([
      Object.freeze({
        id: "manuscript-write",
        kind: "tool",
        trigger: "Before writing or replacing a user manuscript file.",
        permissions: Object.freeze(["filesystem_write"] as const),
      }),
    ]),
    limits: Object.freeze({
      maximumModelTurns: 8,
      maximumToolCalls: 8,
      maximumDurationMs: 600_000,
    }),
    autonomousNetworkAccess: false,
    autonomousCodeExecution: false,
  }),
  Object.freeze({
    id: "reproduction-planning",
    displayName: "Paper reproduction planning",
    description: "Create a reviewable reproduction plan without executing downloaded code.",
    implementationStatus: "metadata-only",
    supported: false,
    requiredCapabilities: Object.freeze({ streaming: true, structuredOutput: true }),
    allowedTools: Object.freeze(["workspace-read", "repository-metadata"]),
    approvals: Object.freeze([
      Object.freeze({
        id: "reproduction-source-network",
        kind: "reproduction",
        trigger: "Before retrieving a declared paper or repository resource.",
        permissions: Object.freeze(["network"] as const),
      }),
    ]),
    limits: Object.freeze({
      maximumModelTurns: 6,
      maximumToolCalls: 8,
      maximumDurationMs: 600_000,
    }),
    autonomousNetworkAccess: false,
    autonomousCodeExecution: false,
  }),
] satisfies readonly ResearchWorkflowDescriptor[]);

const PROFILES = Object.freeze([
  Object.freeze({
    id: "apa-7",
    displayName: "APA 7th edition",
    status: "planned",
    supported: false,
    processor: "unavailable",
    intendedProcessor: "csl-citeproc",
    exportTargets: Object.freeze(["markdown", "latex"] as const),
  }),
  Object.freeze({
    id: "ieee",
    displayName: "IEEE",
    status: "planned",
    supported: false,
    processor: "unavailable",
    intendedProcessor: "csl-citeproc",
    exportTargets: Object.freeze(["markdown", "latex"] as const),
  }),
] satisfies readonly PublicationProfileDescriptor[]);

export function listResearchWorkflows(): readonly ResearchWorkflowDescriptor[] {
  return WORKFLOWS;
}

export function getResearchWorkflow(id: WorkflowId): ResearchWorkflowDescriptor {
  const workflow = WORKFLOWS.find((candidate) => candidate.id === id);
  if (workflow === undefined) {
    throw new Error(`Unknown research workflow: ${id}`);
  }
  return workflow;
}

export function listPublicationProfiles(): readonly PublicationProfileDescriptor[] {
  return PROFILES;
}

export function getPublicationProfile(id: PublicationProfileId): PublicationProfileDescriptor {
  const profile = PROFILES.find((candidate) => candidate.id === id);
  if (profile === undefined) {
    throw new Error(`Unknown publication profile: ${id}`);
  }
  return profile;
}
