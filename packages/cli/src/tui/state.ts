import type { ModelDescriptor, ReasoningIntent } from "@researk/contracts";
import type { SessionMeta } from "../config/sessions.js";
import { escapeUnsafeTerminalControls, neutralizeCarriageReturnsForDisplay } from "../safety.js";
import type { ThemeName } from "../theme.js";
import type { ProviderConnectionKind } from "../types.js";
import type { WorkspaceDocument } from "../workspace.js";

export const MAX_TUI_HISTORY_MESSAGES = 100;
export const MAX_CHAT_MESSAGE_CHARACTERS = 16_000_000;
/** Bounds retained conversation blocks so a long session cannot grow without limit. */
export const MAX_TUI_CONVERSATION_ENTRIES = 400;
/** Bounds the composer's recallable command history. */
export const MAX_COMMAND_HISTORY = 100;
/** The title of a session that has not been loaded or renamed yet. */
export const DEFAULT_SESSION_TITLE = "New session";

export type MessageRole = "user" | "assistant" | "tool" | "system";

/**
 * A conversation entry.
 *
 * `source` is the **redacted canonical source**: the assistant's or user's Markdown and LaTeX
 * preserved exactly, with only credential values replaced by `[REDACTED]`. ADR 0006 requires
 * canonical Markdown and LaTeX to survive every display path so a future export can reproduce it,
 * and the threat model requires that a credential is never retained. Redaction is the single
 * reconciliation of the two: it removes secret values and nothing else, so every Markdown and LaTeX
 * construct - delimiters, backslashes, braces, fences - stays byte-identical to what the model
 * produced. This value is what `/source` reveals and what is replayed as history.
 *
 * `source` may still contain raw C0/C1 control bytes, because those are part of the model's literal
 * output and removing them here would silently corrupt canonical text. They are never rendered:
 * `displayText` derives a terminal-safe projection at the rendering boundary, so no active control
 * sequence can reach Ink. Anything that puts an entry on screen must use `displayText`, never
 * `source`.
 */
export interface ConversationEntry {
  readonly id: string;
  readonly role: MessageRole;
  /**
   * Redacted canonical source. Free of credential values by construction; may contain raw control
   * characters, so it must never be rendered directly.
   */
  readonly source: string;
  /** True while a streaming assistant entry is still receiving deltas. */
  readonly streaming: boolean;
  readonly createdAt: number;
}

/**
 * Returns the canonical source from the newest completed assistant entry.
 *
 * An empty completed response is still a valid canonical source, so this deliberately checks the
 * entry's role and streaming state rather than filtering on source length.
 */
export function latestCompletedAssistantSource(
  conversation: readonly ConversationEntry[],
): string | undefined {
  for (let index = conversation.length - 1; index >= 0; index -= 1) {
    const entry = conversation[index];
    if (entry?.role === "assistant" && !entry.streaming) return entry.source;
  }
  return undefined;
}

/**
 * Derives the terminal-safe display projection of a redacted canonical string.
 *
 * This is the rendering boundary named in the `ConversationEntry` contract. It neutralizes control
 * characters into visible escapes so an untrusted response cannot move the cursor, retitle the
 * window, or corrupt Ink's retained frame. It is intentionally *not* applied to stored state:
 * canonical source stays canonical, and only what is drawn is transformed.
 *
 * Carriage returns are handled by a second pass because the shared escape preserves them for the
 * one-shot parser's CRLF normalization. Nothing drawn here reaches that parser, so a carriage return
 * is neutralized to stop untrusted text from returning the cursor to column zero and overwriting an
 * already-drawn line. Newlines and tabs still pass through as layout.
 */
export function displayText(source: string): string {
  return neutralizeCarriageReturnsForDisplay(escapeUnsafeTerminalControls(source));
}

export interface ProviderConnection {
  readonly providerId: string;
  readonly baseUrl?: string;
  readonly apiKeyEnvironmentVariable: string;
  readonly kind: ProviderConnectionKind;
}

export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "failed";

export type RunStatus = "idle" | "starting" | "streaming" | "cancelling";

/**
 * Ephemeral presentation state for an operation that is about to cross the network boundary.
 * The destination is deliberately a display-only description, never a credential or request URL.
 */
export interface ExternalActivity {
  readonly kind: "catalog" | "prompt";
  readonly destination: string;
  readonly documentCount: number;
}

export interface StatusNotice {
  readonly id: string;
  readonly level: "info" | "warning" | "error" | "success";
  readonly message: string;
  readonly createdAt: number;
}

/**
 * Provider configuration form fields. The API key is an ephemeral input; after a successful live
 * connection the controller may persist it through the OS credential store, never in this form,
 * session metadata, or ordinary provider configuration.
 */
export interface ProviderFormState {
  readonly kind: ProviderConnectionKind;
  readonly providerId: string;
  readonly baseUrl: string;
  readonly apiKeyEnvironmentVariable: string;
  readonly apiKey: string;
  readonly focusedField: number;
  readonly submitting: boolean;
  readonly error?: string | undefined;
}

export type OverlayState =
  | { readonly kind: "none" }
  | { readonly kind: "help" }
  /** `offset` is the first source line shown, so every line stays reachable by paging. */
  | { readonly kind: "source"; readonly offset: number }
  | { readonly kind: "commands"; readonly selected: number }
  | { readonly kind: "provider-picker"; readonly selected: number }
  | { readonly kind: "provider-form"; readonly form: ProviderFormState }
  | { readonly kind: "model"; readonly query: string; readonly selected: number }
  | { readonly kind: "variant"; readonly selected: number }
  | { readonly kind: "theme"; readonly selected: number }
  | {
      readonly kind: "sessions";
      readonly sessions: readonly SessionMeta[];
      readonly selected: number;
    }
  | { readonly kind: "read"; readonly value: string; readonly error?: string | undefined };

export interface ComposerState {
  readonly value: string;
  /** Cursor offset in code units within `value`. */
  readonly cursor: number;
  readonly history: readonly string[];
  /** `undefined` means the user is editing live text rather than browsing history. */
  readonly historyIndex?: number | undefined;
  /** Retains the live draft while the user browses history. */
  readonly draft: string;
}

export interface AppState {
  readonly workspaceRoot: string;
  readonly connection?: ProviderConnection;
  readonly connectionStatus: ConnectionStatus;
  /** Ephemeral network activity disclosure; never persisted in sessions or configuration. */
  readonly externalActivity?: ExternalActivity | undefined;
  /** Ephemeral credential values. Never written to disk, output, or events. */
  readonly credentialValues: Readonly<Record<string, string>>;
  readonly catalog: readonly ModelDescriptor[];
  readonly catalogLoading: boolean;
  readonly model?: string | undefined;
  /** Reasoning intent shown as "variant" in the UI; always drawn from model capabilities. */
  readonly variant: ReasoningIntent;
  readonly themeName: ThemeName;
  readonly colorEnabled: boolean;
  readonly conversation: readonly ConversationEntry[];
  /**
   * Redacted canonical source of the most recent completed assistant response, under the same
   * contract as `ConversationEntry.source`: exact Markdown and LaTeX, no credential values, and
   * never rendered without `displayText`.
   */
  readonly latestAssistantSource?: string | undefined;
  /** Identifier of the persisted session, set when one is loaded. */
  readonly sessionId?: string;
  /** Display title of the current session; a fresh session starts untitled. */
  readonly sessionTitle: string;
  /** ISO timestamp of the last persisted session change. */
  readonly sessionUpdatedAt?: string;
  readonly overlay: OverlayState;
  readonly composer: ComposerState;
  readonly runStatus: RunStatus;
  readonly phase?: string | undefined;
  readonly notices: readonly StatusNotice[];
  readonly stagedDocuments: readonly WorkspaceDocument[];
  /** Scroll offset in rendered terminal rows from the bottom. Zero follows the live tail. */
  readonly scrollOffset: number;
  /** Maximum rendered-row offset measured by the conversation viewport. */
  readonly scrollMax: number;
  readonly exiting: boolean;
}

export function createInitialState(
  options: Readonly<{
    workspaceRoot: string;
    themeName: ThemeName;
    colorEnabled: boolean;
    connection?: ProviderConnection;
    model?: string;
    variant: ReasoningIntent;
    credentialValues?: Readonly<Record<string, string>>;
    sessionId?: string;
    sessionTitle?: string;
    sessionUpdatedAt?: string;
    conversation?: readonly ConversationEntry[];
    notices?: readonly StatusNotice[];
  }>,
): AppState {
  const conversation = options.conversation ?? [];
  return {
    workspaceRoot: options.workspaceRoot,
    ...(options.connection === undefined ? {} : { connection: options.connection }),
    connectionStatus: options.connection === undefined ? "disconnected" : "disconnected",
    externalActivity: undefined,
    credentialValues: options.credentialValues ?? {},
    catalog: [],
    catalogLoading: false,
    ...(options.model === undefined ? {} : { model: options.model }),
    variant: options.variant,
    themeName: options.themeName,
    colorEnabled: options.colorEnabled,
    ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
    sessionTitle: options.sessionTitle ?? DEFAULT_SESSION_TITLE,
    ...(options.sessionUpdatedAt === undefined
      ? {}
      : { sessionUpdatedAt: options.sessionUpdatedAt }),
    conversation,
    latestAssistantSource: latestCompletedAssistantSource(conversation),
    overlay: { kind: "none" },
    composer: { value: "", cursor: 0, history: [], draft: "" },
    runStatus: "idle",
    notices: options.notices ?? [],
    stagedDocuments: [],
    scrollOffset: 0,
    scrollMax: 0,
    exiting: false,
  };
}

/**
 * Derives the selectable reasoning variants from the selected model's advertised capabilities.
 * There is no provider-specific hardcoding: `auto` is always available because the Harness resolves
 * it, and every other entry comes from the descriptor.
 */
export function availableVariants(
  descriptor: ModelDescriptor | undefined,
): readonly ReasoningIntent[] {
  const intents: ReasoningIntent[] = ["auto"];
  if (descriptor === undefined) return intents;
  for (const intent of descriptor.capabilities.reasoning.intents) {
    if (!intents.includes(intent)) intents.push(intent);
  }
  return intents;
}

export function selectedDescriptor(state: AppState): ModelDescriptor | undefined {
  if (state.model === undefined) return undefined;
  return state.catalog.find((item) => item.canonicalId === state.model);
}

export function stagedByteTotal(state: AppState): number {
  return state.stagedDocuments.reduce((total, item) => total + item.byteLength, 0);
}
