import type { Readable, Writable } from "node:stream";
import type {
  ApprovalDecision,
  ApprovalRequestEvent,
  ModelDescriptor,
  RunEvent,
  RunRequest,
} from "@researk/contracts";

export interface HarnessRunOptions {
  readonly signal: AbortSignal;
  readonly onApprovalRequest?: (event: ApprovalRequestEvent) => Promise<ApprovalDecision>;
}

export interface CliHarness {
  run(request: RunRequest, options: HarnessRunOptions): AsyncIterable<RunEvent>;
  listModels(signal?: AbortSignal): Promise<readonly ModelDescriptor[]>;
}

export type ProviderConnectionKind = "openrouter" | "compatible";

export interface ProviderEnvironmentReference {
  readonly providerId: string;
  readonly modelId?: string;
  readonly baseUrl?: string;
  readonly apiKeyEnvironmentVariable: string;
  readonly kind?: ProviderConnectionKind;
}

export interface CliIo {
  readonly stdin: Readable;
  readonly stdout: Writable;
  readonly stderr: Writable;
  readonly isTTY: boolean;
  readonly onInterrupt?: (handler: () => void) => () => void;
}

export interface CliDependencies {
  readonly harness?: CliHarness;
  readonly createHarness?: (configuration: ProviderEnvironmentReference) => Promise<CliHarness>;
  readonly io?: CliIo;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly signal?: AbortSignal;
  readonly createRunId?: () => string;
  readonly onApprovalRequest?: (event: ApprovalRequestEvent) => Promise<ApprovalDecision>;
  readonly cwd?: string;
}
