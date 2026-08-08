import type { ModelDescriptor, ReasoningIntent } from "@researk/contracts";
import type { ThemeName } from "../theme.js";
import type { WorkspaceDocument } from "../workspace.js";
import {
  type AppState,
  availableVariants,
  type ComposerState,
  type ConnectionStatus,
  type ConversationEntry,
  MAX_COMMAND_HISTORY,
  MAX_TUI_CONVERSATION_ENTRIES,
  type MessageRole,
  type OverlayState,
  type ProviderConnection,
  type RunStatus,
  selectedDescriptor,
  type StatusNotice,
} from "./state.js";

const MAX_NOTICES = 5;

export type AppAction =
  | { readonly type: "overlay/open"; readonly overlay: OverlayState }
  | { readonly type: "overlay/close" }
  | { readonly type: "composer/set"; readonly value: string; readonly cursor: number }
  | { readonly type: "composer/submit" }
  | { readonly type: "composer/history-previous" }
  | { readonly type: "composer/history-next" }
  | { readonly type: "theme/set"; readonly name: ThemeName }
  | { readonly type: "connection/connecting"; readonly connection: ProviderConnection }
  | {
      readonly type: "connection/connected";
      readonly connection: ProviderConnection;
      readonly catalog: readonly ModelDescriptor[];
      readonly credentialValues: Readonly<Record<string, string>>;
    }
  | { readonly type: "connection/failed"; readonly message: string }
  | { readonly type: "catalog/loading"; readonly loading: boolean }
  | { readonly type: "catalog/loaded"; readonly catalog: readonly ModelDescriptor[] }
  | { readonly type: "model/select"; readonly model: string }
  | { readonly type: "variant/select"; readonly variant: ReasoningIntent }
  | { readonly type: "conversation/append"; readonly entry: ConversationEntry }
  | { readonly type: "conversation/append-delta"; readonly id: string; readonly delta: string }
  | { readonly type: "conversation/finish"; readonly id: string }
  | { readonly type: "conversation/remove"; readonly id: string }
  | { readonly type: "conversation/clear" }
  | { readonly type: "run/status"; readonly status: RunStatus }
  | { readonly type: "run/phase"; readonly phase: string | undefined }
  | { readonly type: "notice/push"; readonly notice: StatusNotice }
  | { readonly type: "notice/dismiss"; readonly id: string }
  | { readonly type: "documents/stage"; readonly document: WorkspaceDocument }
  | { readonly type: "documents/consume" }
  | { readonly type: "scroll/by"; readonly lines: number }
  | { readonly type: "scroll/follow" }
  | { readonly type: "exit" };

export function reduce(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case "overlay/open":
      return { ...state, overlay: action.overlay };
    case "overlay/close":
      return { ...state, overlay: { kind: "none" } };
    case "composer/set":
      return {
        ...state,
        composer: {
          ...state.composer,
          value: action.value,
          cursor: clamp(action.cursor, 0, action.value.length),
          ...(state.composer.historyIndex === undefined
            ? {}
            : { historyIndex: undefined, draft: action.value }),
        },
      };
    case "composer/submit":
      return {
        ...state,
        composer: {
          value: "",
          cursor: 0,
          history: pushHistory(state.composer.history, state.composer.value),
          draft: "",
        },
      };
    case "composer/history-previous":
      return { ...state, composer: recallHistory(state.composer, -1) };
    case "composer/history-next":
      return { ...state, composer: recallHistory(state.composer, 1) };
    case "theme/set":
      return { ...state, themeName: action.name };
    case "connection/connecting":
      return {
        ...state,
        connectionStatus: "connecting" satisfies ConnectionStatus,
        connection: action.connection,
      };
    case "connection/connected":
      return {
        ...state,
        connectionStatus: "connected",
        connection: action.connection,
        credentialValues: action.credentialValues,
        catalog: action.catalog,
        catalogLoading: false,
        model: undefined,
        variant: "auto",
      };
    case "connection/failed":
      return {
        ...state,
        connectionStatus: "failed",
        catalogLoading: false,
        notices: pushNotice(state.notices, {
          id: `connection-${state.notices.length}-${action.message.length}`,
          level: "error",
          message: action.message,
          createdAt: 0,
        }),
      };
    case "catalog/loading":
      return { ...state, catalogLoading: action.loading };
    case "catalog/loaded":
      return { ...state, catalog: action.catalog, catalogLoading: false };
    case "model/select":
      return applyModelSelection(state, action.model);
    case "variant/select":
      return { ...state, variant: action.variant };
    case "conversation/append":
      // Appending happens on submit, so following the live tail is the intended behaviour. The
      // offset is still re-clamped rather than assumed, because the bounded window may have
      // dropped the oldest entry in the same step.
      return {
        ...state,
        conversation: boundConversation([...state.conversation, action.entry]),
        scrollOffset: 0,
      };
    case "conversation/append-delta":
      return {
        ...state,
        conversation: state.conversation.map((entry) =>
          entry.id === action.id ? { ...entry, source: entry.source + action.delta } : entry,
        ),
      };
    case "conversation/finish": {
      const finished = state.conversation.find((entry) => entry.id === action.id);
      return {
        ...state,
        conversation: state.conversation.map((entry) =>
          entry.id === action.id ? { ...entry, streaming: false } : entry,
        ),
        ...(finished === undefined || finished.role !== "assistant"
          ? {}
          : { latestAssistantSource: finished.source }),
      };
    }
    case "conversation/remove": {
      // Discards a streaming placeholder that never received any text, so a run that failed before
      // the first delta does not leave a permanently empty assistant bubble. `latestAssistantSource`
      // is untouched: a removed placeholder was never promoted to it, so the previously revealed
      // canonical source stays intact.
      const conversation = state.conversation.filter((entry) => entry.id !== action.id);
      if (conversation.length === state.conversation.length) return state;
      return {
        ...state,
        conversation,
        scrollOffset: clamp(state.scrollOffset, 0, Math.max(0, conversation.length - 1)),
      };
    }
    case "conversation/clear":
      return {
        ...state,
        conversation: [],
        latestAssistantSource: undefined,
        scrollOffset: 0,
      };
    case "run/status":
      return {
        ...state,
        runStatus: action.status,
        ...(action.status === "idle" ? { phase: undefined } : {}),
      };
    case "run/phase":
      return { ...state, phase: action.phase };
    case "notice/push":
      return { ...state, notices: pushNotice(state.notices, action.notice) };
    case "notice/dismiss":
      return { ...state, notices: state.notices.filter((item) => item.id !== action.id) };
    case "documents/stage":
      return {
        ...state,
        stagedDocuments: [
          ...state.stagedDocuments.filter(
            (item) => item.relativePath !== action.document.relativePath,
          ),
          action.document,
        ],
      };
    case "documents/consume":
      return { ...state, stagedDocuments: [] };
    case "scroll/by":
      // The offset counts retained entries away from the newest. Clamping to the retained count
      // keeps at least the oldest message on screen, so scrollback cannot run past the transcript
      // into an empty view that reports no hidden messages in either direction.
      return {
        ...state,
        scrollOffset: clamp(
          state.scrollOffset + action.lines,
          0,
          Math.max(0, state.conversation.length - 1),
        ),
      };
    case "scroll/follow":
      return { ...state, scrollOffset: 0 };
    case "exit":
      return { ...state, exiting: true };
  }
}

/**
 * Selecting a model re-derives the variant from that model's advertised capabilities. A variant the
 * new model does not advertise is reset rather than silently carried over.
 */
function applyModelSelection(state: AppState, model: string): AppState {
  const next: AppState = { ...state, model };
  const allowed = availableVariants(selectedDescriptor(next));
  if (allowed.includes(state.variant)) return next;
  return {
    ...next,
    variant: "auto",
    notices: pushNotice(state.notices, {
      id: `variant-reset-${model}`,
      level: "info",
      message: "The selected model does not advertise the previous variant; reset to auto.",
      createdAt: 0,
    }),
  };
}

function boundConversation(entries: readonly ConversationEntry[]): readonly ConversationEntry[] {
  if (entries.length <= MAX_TUI_CONVERSATION_ENTRIES) return entries;
  return entries.slice(entries.length - MAX_TUI_CONVERSATION_ENTRIES);
}

function pushNotice(
  notices: readonly StatusNotice[],
  notice: StatusNotice,
): readonly StatusNotice[] {
  const next = [...notices, notice];
  return next.length <= MAX_NOTICES ? next : next.slice(next.length - MAX_NOTICES);
}

function pushHistory(history: readonly string[], value: string): readonly string[] {
  const trimmed = value.trim();
  if (trimmed.length === 0) return history;
  const withoutDuplicate = history.filter((item) => item !== trimmed);
  const next = [...withoutDuplicate, trimmed];
  return next.length <= MAX_COMMAND_HISTORY ? next : next.slice(next.length - MAX_COMMAND_HISTORY);
}

function recallHistory(composer: ComposerState, direction: -1 | 1): ComposerState {
  const { history } = composer;
  if (history.length === 0) return composer;
  if (composer.historyIndex === undefined) {
    if (direction === 1) return composer;
    const index = history.length - 1;
    const value = history[index] ?? "";
    return { ...composer, historyIndex: index, draft: composer.value, value, cursor: value.length };
  }
  const nextIndex = composer.historyIndex + direction;
  if (nextIndex < 0) {
    const value = history[0] ?? "";
    return { ...composer, historyIndex: 0, value, cursor: value.length };
  }
  if (nextIndex >= history.length) {
    return {
      ...composer,
      historyIndex: undefined,
      value: composer.draft,
      cursor: composer.draft.length,
    };
  }
  const value = history[nextIndex] ?? "";
  return { ...composer, historyIndex: nextIndex, value, cursor: value.length };
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

export function appendEntryId(state: AppState, role: MessageRole): string {
  return `${role}-${state.conversation.length}-${Date.now().toString(36)}`;
}
