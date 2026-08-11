import { randomUUID } from "node:crypto";
import {
  CanonicalModelIdSchema,
  type ChatMessage,
  ModelIdSchema,
  ProviderIdSchema,
  type ReasoningIntent,
  ReasoningIntentSchema,
  splitCanonicalModelId,
} from "@researk/contracts";
import { Box, type DOMElement, useApp, useInput, useStdout, useWindowSize } from "ink";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { SESSION_SCHEMA_VERSION, type Session } from "../config/sessions.js";
import { VERSION } from "../help.js";
import { redactSecrets, safeErrorMessage, safeTerminalText } from "../safety.js";
import { isThemeName, type ThemeName } from "../theme.js";
import {
  type ClipboardResult,
  type ClipboardTerminalContext,
  copyFormulaSource,
} from "./clipboard.js";
import { completeSlashCommand, parseSlashCommand, SLASH_COMMANDS } from "./commands.js";
import {
  Composer,
  composerSuggestionRows,
  composerInputRows as measureComposerInputRows,
} from "./components/Composer.js";
import { Conversation } from "./components/Conversation.js";
import { Footer } from "./components/Footer.js";
import { Header } from "./components/Header.js";
import { Notices } from "./components/Notices.js";
import { Sidebar, shouldShowSidebar, sidebarWidth } from "./components/Sidebar.js";
import { Welcome, welcomeSuggestionBudget } from "./components/Welcome.js";
import type {
  ChatOutcome,
  ControllerEvent,
  ResolvedProvider,
  TuiController,
} from "./controller.js";
import { OPENROUTER_DEFAULT_BASE_URL } from "./controller.js";
import {
  type FormulaRef,
  indexConversationFormulas,
  lookupFormula,
  nextFormula,
  previousFormula,
  reconcileFormulaSelection,
  wrapFormulaDraft,
} from "./formulas.js";
import {
  FormulaGraphic,
  type FormulaGraphicsRefLike,
  type FormulaGraphicsRuntime,
} from "./graphics.js";
import { displayRowCount } from "./layout.js";
import { DISABLE_MOUSE_TRACKING, ENABLE_MOUSE_TRACKING, parseSgrMouseReport } from "./mouse.js";
import { FormulaOverlay, formulaCursorOffset } from "./overlays/FormulaOverlay.js";
import {
  CommandOverlay,
  clampSourceOffset,
  HelpOverlay,
  ReadOverlay,
  SourceOverlay,
  sourceOverlayPageLines,
  sourcePanelTextWidth,
} from "./overlays/InfoOverlays.js";
import { filterModels, ModelOverlay } from "./overlays/ModelOverlay.js";
import {
  formFields,
  PROVIDER_CHOICES,
  ProviderForm,
  ProviderPicker,
} from "./overlays/ProviderOverlay.js";
import { SessionOverlay, ThemeOverlay, VariantOverlay } from "./overlays/SelectOverlays.js";
import { reduce } from "./reducer.js";
import {
  type AppState,
  availableVariants,
  type ConversationEntry,
  DEFAULT_SESSION_TITLE,
  MAX_CHAT_MESSAGE_CHARACTERS,
  MAX_TUI_HISTORY_MESSAGES,
  type MessageRole,
  type ProviderFormState,
  selectedDescriptor,
} from "./state.js";
import { createTuiTheme, formulaRenderStyle, themeColor, tuiThemeNames } from "./theme.js";

export interface AppProps {
  readonly controller: TuiController;
  readonly initialState: AppState;
  /** Injected for tests so notice identities and timings stay deterministic. */
  readonly now?: () => number;
  /** Injectable session-id seam; production uses a UUID rather than a timestamp-only id. */
  readonly createSessionId?: () => string;
  /** Overrides Ink's own exit so the exit path can be observed in tests. */
  readonly onExit?: () => void;
  /** Deterministic terminal dimensions for render tests. */
  readonly terminalWidth?: number;
  readonly terminalHeight?: number;
  /** Enables trusted SGR mouse tracking only when startTui has verified a real interactive TTY. */
  readonly mouseTrackingEnabled?: boolean;
  /** Optional terminal graphics owner created before Ink mounts. */
  readonly graphicsRuntime?: FormulaGraphicsRuntime;
  /** Environment used by the explicit OSC 52 formula clipboard action. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Injectable clipboard policy for tests and embedders. */
  readonly formulaClipboardContext?: ClipboardTerminalContext;
  /** Injectable copy seam; defaults to the local OSC 52 adapter. */
  readonly copyFormula?: (source: string) => ClipboardResult | Promise<ClipboardResult>;
}

let noticeCounter = 0;
const MOUSE_SCROLL_STEP = 3;
/** Ink's single-line shell components each render one content row plus one border row. */
const HEADER_ROWS = 2;
const FOOTER_ROWS = 2;
const NOTICE_ROWS = 1;
const TINY_TERMINAL_MAX_HEIGHT = 5;
/** Keeps interactive draft editing bounded without restricting canonical assistant source. */
export const MAX_FORMULA_DRAFT_CHARACTERS = 64 * 1024;
/**
 * Commands in this allow-list cannot alter the active session, provider, model, or documents.
 * They remain usable while a Harness run is in flight; every other known command must wait until
 * Ctrl+X cancellation has completed and released `activeRun`.
 */
const SAFE_DURING_RUN_COMMANDS = new Set([
  "/help",
  "/commands",
  "/source",
  "/formula",
  "/themes",
  "/exit",
]);
const ACTIVE_RUN_COMMAND_WARNING =
  "A response is in progress. Press Ctrl+X to cancel it, then retry that command.";

interface FormulaViewState {
  readonly selectedKey: string;
  readonly selectedSource: string;
  readonly mode: "browse" | "edit";
  readonly showSource: boolean;
  readonly draft: string;
  readonly cursor: number;
  readonly appliedDraft?: string;
}

const formulaGraphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function App(props: AppProps): ReactNode {
  const [state, dispatch] = useReducer(reduce, props.initialState);
  const [formulaView, setFormulaView] = useState<FormulaViewState | undefined>(undefined);
  const { exit } = useApp();
  const { stdout } = useStdout();
  const windowSize = useWindowSize();
  const now = props.now ?? Date.now;
  const createSessionId = useCallback(
    () => props.createSessionId?.() ?? `session-${randomUUID()}`,
    [props.createSessionId],
  );

  const activeRun = useRef<AbortController | undefined>(undefined);
  /** Set when exit/unmount begins so a late provider completion cannot update or save the TUI. */
  const shuttingDown = useRef(false);
  /** Increments per connection attempt so a superseded reply cannot overwrite a newer connection. */
  const connectGeneration = useRef(0);
  /** Stable identifier of the current persisted session; undefined until the first autosave. */
  const sessionIdRef = useRef<string | undefined>(props.initialState.sessionId);
  /** Invalidates an autosave that belongs to a session the user has since replaced or loaded. */
  const sessionGeneration = useRef(0);
  /** Serializes session-pointer writes so an older autosave cannot finish after `/new` wins. */
  const sessionConfigWrite = useRef(Promise.resolve());
  const stateRef = useRef(state);
  stateRef.current = state;
  const formulaOverlayRef = useRef<DOMElement | null>(null);

  const formulas = useMemo(
    () => indexConversationFormulas(state.conversation),
    [state.conversation],
  );
  const selectedFormula = useMemo(
    () => reconcileFormulaSelection(formulas, formulaView?.selectedKey),
    [formulaView?.selectedKey, formulas],
  );
  const selectedFormulaDraft =
    selectedFormula === undefined ? undefined : (formulaView?.appliedDraft ?? selectedFormula.tex);
  const selectedFormulaPreviewSource =
    selectedFormula === undefined || selectedFormulaDraft === undefined
      ? undefined
      : formulaView?.appliedDraft === undefined
        ? selectedFormula.source
        : wrapFormulaDraft(selectedFormula, selectedFormulaDraft);

  useEffect(() => {
    if (formulaView === undefined) return;
    const selected = reconcileFormulaSelection(formulas, formulaView.selectedKey);
    if (selected === undefined) {
      setFormulaView(undefined);
      return;
    }
    // A streaming assistant entry can retain its key while its source changes. Any local draft or
    // source toggle belongs to the old snapshot and must not leak into the new formula.
    if (
      selected.key !== formulaView.selectedKey ||
      selected.source !== formulaView.selectedSource
    ) {
      setFormulaView({
        selectedKey: selected.key,
        selectedSource: selected.source,
        mode: "browse",
        showSource: false,
        draft: selected.tex,
        cursor: 0,
      });
    }
  }, [formulaView, formulas]);

  const theme = useMemo(
    () => createTuiTheme(state.themeName, { colorEnabled: state.colorEnabled }),
    [state.themeName, state.colorEnabled],
  );

  useEffect(() => {
    const runtime = props.graphicsRuntime;
    if (runtime === undefined) return;
    try {
      if (runtime.disposed) return;
      const style = formulaRenderStyle(theme, runtime.rendererId);
      // Color-disabled/accessibility presentations intentionally keep exact source. Do not pass an
      // undefined style to the runtime, and do not let an invalid style break the TUI shell.
      if (style === undefined) return;
      runtime.updateStyle(style);
    } catch {
      // A graphics style is optional presentation state. Invalid runtime/style input fails closed
      // to the source-rendering path instead of crashing the retained shell.
    }
  }, [props.graphicsRuntime, theme]);

  const terminalWidth = Math.max(
    1,
    props.terminalWidth ?? windowSize.columns ?? stdout.columns ?? 80,
  );
  const terminalHeight = Math.max(1, props.terminalHeight ?? windowSize.rows ?? stdout.rows ?? 24);

  const abortActiveRun = useCallback((): void => {
    activeRun.current?.abort();
  }, []);

  useEffect(() => {
    return () => {
      // Abort before Ink restores the terminal so a provider/Harness request cannot keep running
      // after the alternate screen has been torn down. The shutdown flag also suppresses any late
      // event, placeholder, status, or autosave writes from a promise that does not stop instantly.
      shuttingDown.current = true;
      abortActiveRun();
      // The startup owner also disposes in its finalizer. This idempotent early disposal is needed
      // for Ink's normal `exit()` path, which unmounts before startTui regains control.
      props.graphicsRuntime?.dispose();
    };
  }, [abortActiveRun, props.graphicsRuntime]);

  useEffect(() => {
    if (props.mouseTrackingEnabled !== true) return undefined;
    // startTui gates this prop to a real, interactive TTY. The write is deliberately best-effort:
    // a terminal that rejects the private mode must still leave the TUI usable.
    try {
      stdout.write(ENABLE_MOUSE_TRACKING);
    } catch {
      // Restoration is attempted by both this cleanup and startTui's finalizer.
    }
    return () => {
      try {
        stdout.write(DISABLE_MOUSE_TRACKING);
      } catch {
        // Terminal cleanup must never mask the application's own exit path.
      }
    };
  }, [props.mouseTrackingEnabled, stdout]);

  const overlayOpen = state.overlay.kind !== "none" || formulaView !== undefined;
  const tinyTerminal = terminalHeight <= TINY_TERMINAL_MAX_HEIGHT;
  const isHome = state.conversation.length === 0 && !overlayOpen;
  const showHeader = !isHome && !tinyTerminal;
  const showFooter =
    !overlayOpen && (!tinyTerminal || (isHome ? terminalHeight >= 3 : terminalHeight >= 4));
  const footerRows = showFooter ? FOOTER_ROWS : 0;
  const showSidebar =
    !tinyTerminal && state.conversation.length > 0 && shouldShowSidebar(terminalWidth, 96);
  const width = showSidebar
    ? Math.max(1, terminalWidth - sidebarWidth())
    : Math.min(112, terminalWidth);
  const composerWidth = isHome ? Math.min(80, Math.max(1, width - 2)) : width;
  const hasActionableNotice = state.notices.some(
    (notice) => notice.level === "warning" || notice.level === "error",
  );
  const composerInputRows = measureComposerInputRows(
    state.composer,
    state.runStatus !== "idle",
    composerWidth,
  );
  const homeHeight = Math.max(1, terminalHeight - footerRows);
  // A one-row home region cannot show both a diagnostic and the input. Keep the composer as the
  // primary affordance; the warning remains in state and reappears automatically after resize.
  const homeNoticeRows =
    isHome && hasActionableNotice && homeHeight >= composerInputRows + NOTICE_ROWS
      ? NOTICE_ROWS
      : 0;
  // Reserve one viewport row for chat before allowing suggestions to consume the remaining shell.
  // Home has a separate stack budget because Welcome owns its setup copy and composer.
  const chatSuggestionBudget = tinyTerminal
    ? 0
    : Math.max(
        0,
        terminalHeight -
          (showHeader ? HEADER_ROWS : 0) -
          footerRows -
          (hasActionableNotice ? NOTICE_ROWS : 0) -
          1 -
          composerInputRows,
      );
  const homeSuggestionBudget = isHome
    ? welcomeSuggestionBudget(width, homeHeight, composerInputRows, homeNoticeRows)
    : 0;
  const suggestionBudget = isHome ? homeSuggestionBudget : chatSuggestionBudget;
  const suggestionRows = composerSuggestionRows(state.composer.value, suggestionBudget);
  const composerRows = composerInputRows + suggestionRows;
  // Home owns its notice and composer inside Welcome, so those rows belong to the home stack rather
  // than being deducted as siblings. Chat and overlays render them below the viewport and reserve
  // their measured rows here. Header/Footer include a border row in Ink's actual frame.
  const siblingRows =
    overlayOpen && tinyTerminal
      ? 0
      : isHome
        ? 0
        : composerRows + (tinyTerminal ? 0 : hasActionableNotice ? NOTICE_ROWS : 0);
  const shellRows = (showHeader ? HEADER_ROWS : 0) + footerRows + siblingRows;
  // Conversation, overlays, and the home stack all share the actual remaining shell height. Tiny
  // terminals deliberately allow a zero-row conversation because the composer or overlay owns the
  // scarce rows; conditional rendering below keeps Ink from mounting a forced overflow viewport.
  const conversationHeight = Math.max(0, terminalHeight - shellRows);
  const sourcePanelWidth = Math.max(1, width - 2);
  const sourceTextWidth =
    conversationHeight < 9 ? sourcePanelWidth : sourcePanelTextWidth(sourcePanelWidth);
  const sourceRowCount = useMemo(
    () =>
      state.latestAssistantSource === undefined
        ? 0
        : displayRowCount(state.latestAssistantSource, sourceTextWidth),
    [sourceTextWidth, state.latestAssistantSource],
  );

  const notify = useCallback(
    (level: "info" | "warning" | "error" | "success", message: string): void => {
      noticeCounter += 1;
      dispatch({
        type: "notice/push",
        notice: {
          id: `notice-${noticeCounter}`,
          level,
          // Every notice passes through terminal neutralization before it can reach Ink.
          message: safeTerminalText(message, []),
          createdAt: now(),
        },
      });
    },
    [now],
  );

  const secrets = useMemo(
    () => props.controller.secretsFor(state.connection, state.credentialValues),
    [props.controller, state.connection, state.credentialValues],
  );
  // Read from callbacks that must not be re-created when the credential map changes.
  const secretsRef = useRef(secrets);
  secretsRef.current = secrets;

  const blockCommandDuringRun = useCallback((): boolean => {
    if (activeRun.current === undefined) return false;
    notify("warning", ACTIVE_RUN_COMMAND_WARNING);
    return true;
  }, [notify]);

  const saveSessionPointer = useCallback(
    (sessionId: string | null, generation: number): void => {
      const write = sessionConfigWrite.current.then(async () => {
        if (generation !== sessionGeneration.current || shuttingDown.current) return;
        let result: Awaited<ReturnType<TuiController["saveConfig"]>>;
        try {
          result = await props.controller.saveConfig({ sessionId });
        } catch {
          if (generation === sessionGeneration.current && !shuttingDown.current) {
            notify("warning", "Could not save configuration.");
          }
          return;
        }
        // A replacement may have happened while the config write was in flight. The queue keeps
        // invocation order, while this check documents that a stale write never authorizes a later
        // pointer update in this operation.
        if (generation !== sessionGeneration.current || shuttingDown.current) return;
        if (!result.ok) {
          // Persistence is optional for embedders/tests without a config store. Other failures
          // must be visible, but the notice remains generic and never carries backend details.
          if (result.message !== "Configuration persistence is unavailable.") {
            notify("warning", "Could not save configuration.");
          }
          return;
        }
      });
      // Keep the queue alive after a best-effort config failure; a later `/new` or load must still
      // be able to write its pointer.
      sessionConfigWrite.current = write.catch(() => {});
    },
    [notify, props.controller],
  );

  /** Persists the empty session created by `/new` before advancing its global config pointer. */
  const persistNewSession = useCallback(
    (sessionId: string, timestamp: string, snapshot: AppState, generation: number): void => {
      const session: Session = {
        schemaVersion: SESSION_SCHEMA_VERSION,
        id: sessionId,
        title: DEFAULT_SESSION_TITLE,
        createdAt: timestamp,
        updatedAt: timestamp,
        workspace: snapshot.workspaceRoot,
        providerId: snapshot.connection?.providerId ?? null,
        modelId: snapshot.model ?? null,
        variantId: snapshot.variant,
        messages: [],
      };
      void props.controller
        .saveSession(session)
        .then((result) => {
          if (generation !== sessionGeneration.current || shuttingDown.current) return;
          if (!result.ok) {
            if (result.message !== "Session persistence is unavailable.") {
              notify("warning", result.message ?? "Could not save the new session.");
            }
            return;
          }
          saveSessionPointer(sessionId, generation);
        })
        .catch(() => {
          if (generation !== sessionGeneration.current || shuttingDown.current) return;
          notify("warning", "Could not save the new session.");
        });
    },
    [notify, props.controller, saveSessionPointer],
  );

  useEffect(() => {
    if (!state.exiting) return;
    shuttingDown.current = true;
    abortActiveRun();
    props.graphicsRuntime?.dispose();
    if (props.onExit === undefined) exit();
    else props.onExit();
  }, [abortActiveRun, state.exiting, exit, props.graphicsRuntime, props.onExit]);

  // --- Actions -------------------------------------------------------------------------------

  const connect = useCallback(
    async (form: ProviderFormState): Promise<void> => {
      if (blockCommandDuringRun()) return;
      dispatch({ type: "notice/clear" });
      let connection: ReturnType<TuiController["buildConnection"]>;
      try {
        connection = props.controller.buildConnection({
          kind: form.kind,
          providerId: form.kind === "openrouter" ? "openrouter" : form.providerId,
          baseUrl: form.baseUrl,
          apiKeyEnvironmentVariable: form.apiKeyEnvironmentVariable,
        });
      } catch (error) {
        dispatch({
          type: "overlay/open",
          overlay: {
            kind: "provider-form",
            form: { ...form, submitting: false, error: safeErrorMessage(error) },
          },
        });
        return;
      }

      const sameProviderEndpoint =
        state.connection?.providerId === connection.providerId &&
        state.connection?.baseUrl === connection.baseUrl &&
        state.connection?.kind === connection.kind;
      const inheritedCredentialValues = sameProviderEndpoint ? state.credentialValues : {};
      let credentialValues =
        form.apiKey.length === 0
          ? inheritedCredentialValues
          : {
              ...inheritedCredentialValues,
              [connection.apiKeyEnvironmentVariable]: form.apiKey,
            };

      dispatch({
        type: "overlay/open",
        overlay: { kind: "provider-form", form: { ...form, submitting: true, error: undefined } },
      });
      dispatch({ type: "connection/connecting", connection });
      dispatch({
        type: "external/set",
        activity: {
          kind: "catalog",
          destination: props.controller.describeConnection(connection),
          documentCount: 0,
        },
      });

      // Catalog retrieval is slow enough that a user can start a second connection before the
      // first one answers. Each attempt claims a generation, and only the newest one is allowed to
      // write a result, so a late reply from a superseded endpoint cannot replace the connection,
      // catalog, or credentials the user actually chose.
      connectGeneration.current += 1;
      const generation = connectGeneration.current;

      try {
        // A blank interactive field means "reuse this selected provider profile", not "discard the
        // credential". Resolve through the registry so the provider-scoped secure value wins over
        // its environment fallback. Only merge a profile whose complete identity matches the form;
        // a credential from another provider or protocol must never cross the boundary. The
        // submitted endpoint may intentionally edit an existing custom profile's metadata, while
        // its provider-scoped credential remains ephemeral and is never copied into that profile.
        let resolvedProvider: ResolvedProvider | null = null;
        if (form.apiKey.length === 0) {
          try {
            resolvedProvider = await props.controller.resolveProvider(connection.providerId);
          } catch {
            resolvedProvider = null;
          }
          if (generation !== connectGeneration.current || shuttingDown.current) return;
          const resolvedConnection = resolvedProvider?.connection;
          if (
            resolvedProvider !== null &&
            resolvedConnection !== undefined &&
            resolvedConnection.providerId === connection.providerId &&
            resolvedConnection.kind === connection.kind
          ) {
            const resolvedSecret =
              resolvedProvider.credentialValues[resolvedConnection.apiKeyEnvironmentVariable];
            credentialValues = {
              ...inheritedCredentialValues,
              ...(resolvedSecret === undefined
                ? {}
                : { [connection.apiKeyEnvironmentVariable]: resolvedSecret }),
            };
          }
        }
        const catalog = await props.controller.connect(connection, credentialValues);
        if (generation !== connectGeneration.current || shuttingDown.current) return;
        if (blockCommandDuringRun()) return;
        dispatch({ type: "notice/clear" });
        dispatch({ type: "connection/connected", connection, catalog, credentialValues });
        dispatch({ type: "overlay/close" });
        // Persist the active provider profile and credential, then record the connection in the
        // app config so a later session can restore it. Best-effort: failures never break the UI,
        // but the user gets a redacted, actionable warning instead of assuming a restart will work.
        try {
          // A blank key can still be a deliberate metadata edit to an existing custom profile. Keep
          // its already-resolved secure credential ephemeral while updating endpoint/protocol,
          // display, or environment-reference metadata that the user submitted.
          const metadataOnlyProfileUpdate =
            form.apiKey.length === 0 &&
            resolvedProvider !== null &&
            connection.kind === "compatible" &&
            (resolvedProvider.profile.protocol !== "compatible" ||
              resolvedProvider.profile.baseUrl !== connection.baseUrl ||
              resolvedProvider.profile.name !== connection.providerId ||
              resolvedProvider.connection.apiKeyEnvironmentVariable !==
                connection.apiKeyEnvironmentVariable);
          const persistence =
            form.apiKey.length > 0 || resolvedProvider === null || metadataOnlyProfileUpdate
              ? await props.controller.persistProvider(
                  connection,
                  form.apiKey.length > 0 ? credentialValues : {},
                )
              : { ok: true as const };
          if (generation !== connectGeneration.current || shuttingDown.current) return;
          const metadataOnlySavedWithoutCredential =
            metadataOnlyProfileUpdate &&
            persistence.message ===
              "No interactive credential was supplied; provider metadata was saved only.";
          if (!persistence.ok && !metadataOnlySavedWithoutCredential) {
            const message = redactSecrets(
              persistence.message ??
                "Provider persistence failed; configure its environment variable or enable secure storage.",
              props.controller.secretsFor(connection, credentialValues),
            );
            notify("warning", message);
          }
        } catch (error) {
          notify(
            "warning",
            safeErrorMessage(error, props.controller.secretsFor(connection, credentialValues)),
          );
        }
        void props.controller.saveConfig({ connection }).catch(() => {});
      } catch (error) {
        if (generation !== connectGeneration.current || shuttingDown.current) return;
        if (blockCommandDuringRun()) return;
        dispatch({ type: "notice/clear" });
        const message = safeErrorMessage(
          error,
          props.controller.secretsFor(connection, credentialValues),
        );
        dispatch({ type: "connection/failed", message });
        dispatch({
          type: "overlay/open",
          overlay: {
            kind: "provider-form",
            form: { ...form, submitting: false, error: message },
          },
        });
      }
    },
    [
      blockCommandDuringRun,
      notify,
      props.controller,
      state.connection?.baseUrl,
      state.connection?.kind,
      state.connection?.providerId,
      state.credentialValues,
    ],
  );

  /**
   * Persists the current conversation as a session. A stable session id is minted once and reused
   * for every write, so repeated exchanges keep appending to the same session rather than spawning
   * one file per prompt. Best-effort: failures surface as a warning notice, never a crash.
   *
   * The conversation is passed in explicitly because the reducer state is not yet committed when a
   * run finishes; the streamed deltas live in the run outcome, not in `stateRef.current`.
   */
  const autosaveSession = useCallback(
    async (
      sessionId: string,
      messages: Session["messages"],
      providerId: string | null,
      modelId: string | null,
      variant: ReasoningIntent,
      generation: number,
    ): Promise<void> => {
      if (generation !== sessionGeneration.current || shuttingDown.current) return;
      const timestamp = new Date().toISOString();
      const session: Session = {
        schemaVersion: SESSION_SCHEMA_VERSION,
        id: sessionId,
        title: props.controller.autoTitle(messages),
        createdAt: timestamp,
        updatedAt: timestamp,
        workspace: stateRef.current.workspaceRoot,
        providerId,
        modelId,
        variantId: variant,
        messages,
      };
      try {
        const result = await props.controller.saveSession(session);
        // `/new` or a session load may have happened while the filesystem write was in flight. The
        // old exchange may remain persisted, but it must not reclaim the new session's pointer.
        if (generation !== sessionGeneration.current || shuttingDown.current) return;
        if (!result.ok) {
          if (result.message !== "Session persistence is unavailable.") {
            notify("warning", result.message ?? "Could not save the session.");
          }
          return;
        }
        saveSessionPointer(sessionId, generation);
      } catch {
        if (!shuttingDown.current && generation === sessionGeneration.current) {
          notify("warning", "Could not save the session.");
        }
      }
    },
    [props.controller, notify, saveSessionPointer],
  );

  const submitPrompt = useCallback(
    async (prompt: string): Promise<void> => {
      const current = stateRef.current;
      // Defence in depth: the single-run invariant is enforced at the call site, but this is the
      // function that actually claims `activeRun`, so it re-checks before overwriting the slot.
      if (shuttingDown.current || activeRun.current !== undefined) return;
      const runSessionGeneration = sessionGeneration.current;
      // A new attempt supersedes an old diagnostic. Validation below may immediately replace it
      // with a newly emitted actionable error.
      dispatch({ type: "notice/clear" });
      if (current.connectionStatus === "connecting") {
        notify("warning", "A provider connection is still loading. Please wait for it to finish.");
        return;
      }
      if (current.connection === undefined) {
        notify("error", "Connect a provider first with /provider.");
        return;
      }
      if (current.model === undefined) {
        notify("error", "Select a model first with /model.");
        return;
      }
      if (current.conversation.length > MAX_TUI_HISTORY_MESSAGES - 2) {
        notify(
          "error",
          `Session history reached ${MAX_TUI_HISTORY_MESSAGES} messages. Use /clear to start a new bounded session.`,
        );
        return;
      }
      if (prompt.length > MAX_CHAT_MESSAGE_CHARACTERS) {
        notify("error", "The prompt exceeds the message size limit.");
        return;
      }

      const documents = current.stagedDocuments;
      const history: readonly ChatMessage[] = current.conversation
        .filter((entry) => entry.role === "user" || entry.role === "assistant")
        .map((entry) => ({ role: entry.role as "user" | "assistant", content: entry.source }));

      const userId = `user-${now().toString(36)}-${current.conversation.length}`;
      const assistantId = `assistant-${now().toString(36)}-${current.conversation.length}`;
      dispatch({
        type: "conversation/append",
        entry: {
          id: userId,
          role: "user",
          // The user's own text is stored as its redacted canonical source, exactly like an
          // assistant response, so what is replayed as history and revealed by `/source` is what
          // was actually typed. Neutralizing it here would have mislabelled a transformed string
          // as canonical and silently changed the LaTeX a researcher wrote. Redaction is still
          // applied, because a credential pasted into the composer must not be retained; the
          // control characters that remain are neutralized by `displayText` when drawn.
          source: redactSecrets(prompt, secretsRef.current),
          streaming: false,
          createdAt: now(),
        },
      });
      dispatch({
        type: "conversation/append",
        entry: {
          id: assistantId,
          role: "assistant",
          source: "",
          streaming: true,
          createdAt: now(),
        },
      });
      dispatch({
        type: "external/set",
        activity: {
          kind: "prompt",
          destination: props.controller.describeConnection(current.connection),
          documentCount: documents.length,
        },
      });
      dispatch({ type: "documents/consume" });
      dispatch({ type: "run/status", status: "starting" });

      const controller = new AbortController();
      activeRun.current = controller;
      let started = false;
      let outcome: ChatOutcome | undefined;

      // `runChat` is contracted not to reject, but run ownership is released in `finally`
      // regardless. The slot, the streaming placeholder, and `runStatus` are this component's
      // invariants: if anything unexpected escaped the controller, leaving them set would pin the
      // composer as disabled, leave a message spinning forever, and put the single active-run slot
      // beyond the reach of Ctrl+C, so the only way out would be killing the terminal.
      try {
        outcome = await props.controller.runChat({
          connection: current.connection,
          credentialValues: current.credentialValues,
          model: current.model,
          variant: current.variant,
          history,
          prompt,
          documents,
          signal: controller.signal,
          onEvent: (event: ControllerEvent) => {
            if (shuttingDown.current) return;
            switch (event.type) {
              case "delta":
                if (!started) {
                  started = true;
                  dispatch({ type: "run/status", status: "streaming" });
                }
                dispatch({
                  type: "conversation/append-delta",
                  id: assistantId,
                  delta: event.delta,
                });
                break;
              case "phase":
                dispatch({ type: "run/phase", phase: event.phase });
                break;
              case "selection":
                // Selection is represented by the chosen model/variant in the shell; it is not an
                // actionable diagnostic and should not become transcript-like status chatter.
                break;
              case "diagnostic":
                if (event.level === "error") notify("error", event.message);
                else if (event.level === "warning") notify("warning", event.message);
                break;
              case "tool":
                // Routine tool activity is intentionally omitted from the notice stream.
                break;
              case "error":
                notify("error", event.message);
                break;
              case "cancelled":
                notify("warning", "Cancelled.");
                break;
              case "completed":
                break;
            }
          },
        });
      } catch (error) {
        // A rejection means the run never produced a single event, so there is nothing to preserve.
        // Report it as a sanitized in-TUI error rather than letting it become an unhandled
        // rejection that the alternate screen would hide entirely.
        if (!shuttingDown.current) notify("error", safeErrorMessage(error, secretsRef.current));
      } finally {
        activeRun.current = undefined;
        if (!shuttingDown.current) {
          if (started) {
            // Text arrived, so the placeholder became a real partial response: keep it and mark it
            // complete, which also promotes it to the canonical source `/source` reveals.
            dispatch({ type: "conversation/finish", id: assistantId });
          } else {
            // Nothing was ever streamed into it. An empty assistant bubble under the prompt would
            // read as a silent empty answer, so the placeholder is removed and the reported error is
            // the only account of what happened.
            dispatch({ type: "conversation/remove", id: assistantId });
          }
          dispatch({ type: "run/status", status: "idle" });

          // Persist the completed exchange as a session. The reducer state is stale here (the final
          // deltas were not committed through it), so the messages are assembled from the history
          // captured before the run plus the outcome the run actually produced.
          if (started && outcome !== undefined) {
            const sessionId =
              sessionIdRef.current ??
              current.sessionId ??
              `session-${now().toString(36)}-${Date.now().toString(36)}`;
            sessionIdRef.current = sessionId;
            const messages: Session["messages"] = [
              ...current.conversation.map((entry) => ({ role: entry.role, content: entry.source })),
              { role: "user", content: redactSecrets(prompt, secretsRef.current) },
              { role: "assistant", content: outcome.text },
            ];
            void autosaveSession(
              sessionId,
              messages,
              current.connection.providerId,
              current.model,
              current.variant,
              runSessionGeneration,
            ).catch(() => {});
          }
        }
      }

      if (
        !shuttingDown.current &&
        outcome !== undefined &&
        outcome.text.length > MAX_CHAT_MESSAGE_CHARACTERS
      ) {
        notify("warning", "This exchange exceeds the retained message size limit.");
      }
    },
    [props.controller, notify, now, autosaveSession],
  );

  const stageDocument = useCallback(
    async (request: string): Promise<void> => {
      if (blockCommandDuringRun()) return;
      const generation = sessionGeneration.current;
      dispatch({ type: "notice/clear" });
      try {
        const document = await props.controller.stageDocument(
          request,
          stateRef.current.stagedDocuments,
        );
        if (generation !== sessionGeneration.current || shuttingDown.current) return;
        if (blockCommandDuringRun()) return;
        dispatch({ type: "documents/stage", document });
        dispatch({ type: "overlay/close" });
      } catch (error) {
        if (generation !== sessionGeneration.current || shuttingDown.current) return;
        dispatch({
          type: "overlay/open",
          overlay: { kind: "read", value: request, error: safeErrorMessage(error) },
        });
      }
    },
    [blockCommandDuringRun, props.controller],
  );

  const openModelOverlay = useCallback(async (): Promise<void> => {
    const current = stateRef.current;
    if (blockCommandDuringRun()) return;
    dispatch({ type: "notice/clear" });
    if (current.connection === undefined) {
      notify("error", "Connect a provider first with /provider.");
      return;
    }
    dispatch({ type: "overlay/open", overlay: { kind: "model", query: "", selected: 0 } });
    if (current.catalog.length > 0) return;
    dispatch({ type: "catalog/loading", loading: true });
    dispatch({
      type: "external/set",
      activity: {
        kind: "catalog",
        destination: props.controller.describeConnection(current.connection),
        documentCount: 0,
      },
    });
    try {
      const catalog = await props.controller.refreshCatalog(
        current.connection,
        current.credentialValues,
      );
      if (blockCommandDuringRun()) {
        dispatch({ type: "catalog/loading", loading: false });
        return;
      }
      dispatch({ type: "catalog/loaded", catalog });
    } catch (error) {
      dispatch({ type: "catalog/loading", loading: false });
      notify("error", safeErrorMessage(error, secrets));
    }
  }, [blockCommandDuringRun, props.controller, notify, secrets]);

  /** Opens the saved-sessions browser after asynchronously loading the session list. */
  const openSessionsOverlay = useCallback(async (): Promise<void> => {
    if (blockCommandDuringRun()) return;
    dispatch({ type: "notice/clear" });
    const generation = sessionGeneration.current;
    const loadedSessions = await props.controller.listSessions();
    if (generation !== sessionGeneration.current || shuttingDown.current) return;
    if (blockCommandDuringRun()) return;
    const sessions = loadedSessions.map((session) => ({
      ...session,
      title: redactSecrets(session.title, secretsRef.current),
    }));
    dispatch({ type: "overlay/open", overlay: { kind: "sessions", sessions, selected: 0 } });
  }, [blockCommandDuringRun, props.controller]);

  const openFormulaOverlay = useCallback((): void => {
    dispatch({ type: "notice/clear" });
    const currentFormulas = indexConversationFormulas(stateRef.current.conversation);
    const first = currentFormulas[0];
    if (first === undefined) {
      notify("warning", "No assistant formulas are available yet.");
      return;
    }
    setFormulaView({
      selectedKey: first.key,
      selectedSource: first.source,
      mode: "browse",
      showSource: false,
      draft: first.tex,
      cursor: 0,
    });
  }, [notify]);

  const formulaClipboardContext = useMemo<ClipboardTerminalContext>(
    () =>
      props.formulaClipboardContext ?? {
        interactive: true,
        stdout,
        env: props.env ?? {},
      },
    [props.env, props.formulaClipboardContext, stdout],
  );

  const copyFormula = useCallback(
    (source: string): Promise<ClipboardResult> => {
      if (props.copyFormula !== undefined) return Promise.resolve(props.copyFormula(source));
      return copyFormulaSource(source, formulaClipboardContext, (sequence) =>
        stdout.write(sequence),
      );
    },
    [formulaClipboardContext, props.copyFormula, stdout],
  );

  const copySelectedFormula = useCallback(
    async (formula: FormulaRef): Promise<void> => {
      const result = await copyFormula(formula.source);
      if (result.ok) {
        notify("success", "Formula source copied.");
      } else {
        notify("warning", `Formula source was not copied (${result.reason}).`);
      }
    },
    [copyFormula, notify],
  );

  const insertSelectedFormula = useCallback(
    (formula: FormulaRef): void => {
      if (activeRun.current !== undefined) {
        notify("warning", ACTIVE_RUN_COMMAND_WARNING);
        return;
      }
      const view = formulaView;
      const draft = view?.appliedDraft;
      const source = draft === undefined ? formula.source : wrapFormulaDraft(formula, draft);
      const composer = stateRef.current.composer;
      const cursor = Math.min(Math.max(composer.cursor, 0), composer.value.length);
      dispatch({
        type: "composer/set",
        value: composer.value.slice(0, cursor) + source + composer.value.slice(cursor),
        cursor: cursor + source.length,
      });
      setFormulaView(undefined);
    },
    [formulaView, notify],
  );

  /** Loads one persisted session into the conversation and closes the browser overlay. */
  const loadSession = useCallback(
    async (id: string): Promise<void> => {
      if (blockCommandDuringRun()) return;
      dispatch({ type: "notice/clear" });
      // Claim the replacement before the first await. `/new` and any later load increment this
      // same generation, so no late load can dispatch a transcript or reclaim the config pointer.
      const generation = sessionGeneration.current + 1;
      sessionGeneration.current = generation;
      const current = stateRef.current;
      const session: Session | null = await props.controller.loadSession(id);
      if (generation !== sessionGeneration.current || shuttingDown.current) return;
      if (blockCommandDuringRun()) return;
      if (session === null) {
        dispatch({ type: "overlay/close" });
        notify("warning", "That session could not be loaded.");
        return;
      }
      // Guard against accidentally loading a session into the wrong workspace.
      if (session.workspace !== current.workspaceRoot) {
        notify(
          "warning",
          `This session belongs to workspace ${session.workspace}. Switch to that directory first, or use /new to start a session in the current workspace.`,
        );
        return;
      }

      // A transcript can outlive the global provider selection. Resolve its saved provider through
      // the controller without fetching a catalog, so persisted credentials win over any current
      // environment fallback and a missing profile cannot silently become the current provider.
      const rawProviderId = session.providerId;
      const sessionProviderId = validSessionProviderId(rawProviderId);
      let resolvedProvider: ResolvedProvider | null = null;
      if (rawProviderId !== null && sessionProviderId === null) {
        dispatch({ type: "connection/cleared" });
        notify("warning", "This session has invalid provider metadata; reconnect with /provider.");
      } else if (sessionProviderId !== null) {
        resolvedProvider = await props.controller.resolveProvider(sessionProviderId);
        if (generation !== sessionGeneration.current || shuttingDown.current) return;
        if (blockCommandDuringRun()) return;
        if (resolvedProvider === null) {
          dispatch({ type: "connection/cleared" });
          notify(
            "warning",
            `Saved provider profile "${sessionProviderId}" is unavailable. Reconnect with /provider before sending a prompt.`,
          );
        } else {
          dispatch({
            type: "connection/restored",
            connection: resolvedProvider.connection,
            credentialValues: resolvedProvider.credentialValues,
          });
          if (!resolvedProvider.credentialAvailable) {
            notify(
              "warning",
              `Saved credential for provider "${sessionProviderId}" is unavailable. Reconnect with /provider or configure its environment variable.`,
            );
          }
        }
      }

      const providerResolutionMissing =
        rawProviderId !== null && (sessionProviderId === null || resolvedProvider === null);
      const rawModelId = session.modelId;
      const rawVariantId = session.variantId;
      const missingProviderProvenance =
        sessionProviderId === null && (rawModelId !== null || rawVariantId !== null);
      // A session without an explicit provider cannot borrow the current/global provider to
      // qualify a provider-local model id. Only a stored provider identity may establish that
      // provenance; otherwise model and reasoning metadata are cleared below.
      const expectedProvider = sessionProviderId ?? undefined;
      const sessionModelId = providerResolutionMissing
        ? null
        : validSessionModelId(rawModelId, expectedProvider);
      const invalidModel = rawModelId !== null && sessionModelId === null;
      if (missingProviderProvenance) {
        notify(
          "warning",
          "This session has no saved provider; its model and reasoning settings were cleared.",
        );
      } else if (invalidModel) {
        notify(
          "warning",
          "This session has invalid model metadata; select a model before prompting.",
        );
      }
      const sessionVariant = missingProviderProvenance
        ? undefined
        : validSessionVariant(rawVariantId);
      const invalidVariant =
        !missingProviderProvenance && rawVariantId !== null && sessionVariant === undefined;
      if (invalidVariant) {
        notify("warning", "This session has invalid reasoning metadata; reset to auto.");
      }

      const sessionSecrets = [
        ...new Set([
          ...secretsRef.current,
          ...(resolvedProvider === null
            ? []
            : props.controller.secretsFor(
                resolvedProvider.connection,
                resolvedProvider.credentialValues,
              )),
        ]),
      ];
      const conversation: ConversationEntry[] = session.messages.map((message, index) => ({
        id: `${message.role}-${index}-${now().toString(36)}`,
        role: isMessageRole(message.role) ? message.role : "user",
        source: redactSecrets(message.content, sessionSecrets),
        streaming: false,
        createdAt: now(),
      }));
      dispatch({
        type: "session/load",
        sessionId: session.id,
        title: redactSecrets(session.title, sessionSecrets),
        updatedAt: session.updatedAt,
        conversation,
        ...(sessionProviderId !== null
          ? { model: sessionModelId, variant: sessionVariant ?? "auto" }
          : missingProviderProvenance
            ? { ...(rawModelId === null ? {} : { model: null }), variant: "auto" as const }
            : {}),
      });
      setFormulaView(undefined);
      dispatch({ type: "overlay/close" });
      // Subsequent autosaves continue appending to the loaded session.
      sessionIdRef.current = session.id;
      saveSessionPointer(session.id, generation);
    },
    [blockCommandDuringRun, notify, now, props.controller, saveSessionPointer],
  );

  const runCommand = useCallback(
    (line: string): void => {
      const parsed = parseSlashCommand(line);
      if (parsed === undefined) return;
      // Unknown commands retain their normal diagnostic. For every known command, the allow-list
      // is the single policy gate, including commands selected from the `/commands` overlay.
      const known = SLASH_COMMANDS.some((command) => command.name === parsed.name);
      if (known && activeRun.current !== undefined && !SAFE_DURING_RUN_COMMANDS.has(parsed.name)) {
        notify("warning", ACTIVE_RUN_COMMAND_WARNING);
        return;
      }
      const current = stateRef.current;
      switch (parsed.name) {
        case "/exit":
          // Mark shutdown before aborting: AbortController dispatches its event synchronously, and
          // any resulting provider callback must not add a late "Cancelled." notice during exit.
          shuttingDown.current = true;
          abortActiveRun();
          dispatch({ type: "exit" });
          return;
        case "/help":
          dispatch({ type: "overlay/open", overlay: { kind: "help" } });
          return;
        case "/commands":
          dispatch({ type: "overlay/open", overlay: { kind: "commands", selected: 0 } });
          return;
        case "/clear":
          dispatch({ type: "notice/clear" });
          dispatch({ type: "conversation/clear" });
          return;
        case "/sessions":
          void openSessionsOverlay();
          return;
        case "/new":
          dispatch({ type: "notice/clear" });
          {
            const sessionId = createSessionId();
            const timestamp = new Date(now()).toISOString();
            const generation = sessionGeneration.current + 1;
            sessionGeneration.current = generation;
            sessionIdRef.current = sessionId;
            dispatch({ type: "session/create", sessionId, updatedAt: timestamp });
            // FormulaView is local React state rather than reducer state; clear it explicitly so a
            // previous formula overlay cannot suppress the fresh session's home composer.
            setFormulaView(undefined);
            persistNewSession(sessionId, timestamp, current, generation);
          }
          return;
        case "/provider":
          dispatch({ type: "overlay/open", overlay: { kind: "provider-picker", selected: 0 } });
          return;
        case "/model":
          void openModelOverlay();
          return;
        case "/variant": {
          const variants = availableVariants(selectedDescriptor(current));
          const index = Math.max(0, variants.indexOf(current.variant));
          dispatch({ type: "overlay/open", overlay: { kind: "variant", selected: index } });
          return;
        }
        case "/themes": {
          const names = tuiThemeNames();
          const index = Math.max(0, names.indexOf(current.themeName));
          dispatch({ type: "overlay/open", overlay: { kind: "theme", selected: index } });
          return;
        }
        case "/read":
          if (parsed.argument.length > 0) {
            void stageDocument(parsed.argument);
            return;
          }
          dispatch({ type: "overlay/open", overlay: { kind: "read", value: "" } });
          return;
        case "/source":
          dispatch({ type: "overlay/open", overlay: { kind: "source", offset: 0 } });
          return;
        case "/formula":
          openFormulaOverlay();
          return;
        default:
          notify("error", `Unknown command ${parsed.name}. Use /help.`);
      }
    },
    [
      abortActiveRun,
      notify,
      createSessionId,
      openFormulaOverlay,
      openModelOverlay,
      openSessionsOverlay,
      now,
      persistNewSession,
      stageDocument,
    ],
  );

  const submitComposer = useCallback((): void => {
    const current = stateRef.current;
    const trimmed = current.composer.value.trim();
    if (trimmed.length === 0) return;
    dispatch({ type: "notice/clear" });
    // A run owns the single `activeRun` slot. Submitting a prompt while one is in flight would
    // start a second Harness run and overwrite that slot, orphaning the first run beyond the reach
    // of Ctrl+C. Slash commands stay available because they never start a run.
    if (current.runStatus !== "idle" && !trimmed.startsWith("/")) {
      notify("warning", "A response is in progress. Press Ctrl+X to cancel it first.");
      return;
    }
    const historyValue = trimmed.startsWith("/")
      ? current.composer.value
      : redactSecrets(current.composer.value, secretsRef.current);
    dispatch({ type: "composer/submit", historyValue });
    if (trimmed.startsWith("/")) {
      runCommand(trimmed);
      return;
    }
    void submitPrompt(trimmed);
  }, [runCommand, submitPrompt, notify]);

  // --- Input ---------------------------------------------------------------------------------

  useInput((input, key) => {
    const current = stateRef.current;

    // Ink may pass an SGR report with its leading ESC removed. The parser accepts both forms, so
    // every report is consumed before overlay routing or printable composer input can see it.
    const mouseReport = parseSgrMouseReport(input);
    if (mouseReport !== undefined) {
      if (
        current.overlay.kind === "none" &&
        formulaView === undefined &&
        mouseReport.kind === "scroll"
      ) {
        dispatch({
          type: "scroll/by",
          lines: mouseReport.direction === "up" ? MOUSE_SCROLL_STEP : -MOUSE_SCROLL_STEP,
        });
      }
      return;
    }

    // Ctrl+C belongs to the terminal and is deliberately a no-op in the app. Ctrl+X is the
    // explicit in-app cancellation binding; /exit is the only normal exit command.
    if (key.ctrl && input === "c") return;
    if (key.ctrl && input === "x") {
      if (activeRun.current !== undefined) {
        activeRun.current.abort();
        dispatch({ type: "run/status", status: "cancelling" });
        return;
      }
      return;
    }

    if (formulaView !== undefined) {
      handleFormulaInput(input, key);
      return;
    }

    if (current.overlay.kind !== "none") {
      handleOverlayInput(input, key);
      return;
    }

    if (key.ctrl && input === "l") {
      if (blockCommandDuringRun()) return;
      dispatch({ type: "notice/clear" });
      dispatch({ type: "conversation/clear" });
      return;
    }
    if (key.pageUp) {
      dispatch({ type: "scroll/by", lines: Math.max(1, conversationHeight - 1) });
      return;
    }
    if (key.pageDown) {
      dispatch({ type: "scroll/by", lines: -Math.max(1, conversationHeight - 1) });
      return;
    }
    if (key.home) {
      dispatch({ type: "scroll/oldest" });
      return;
    }
    if (key.end) {
      dispatch({ type: "scroll/follow" });
      return;
    }
    if (key.escape) {
      dispatch({ type: "scroll/follow" });
      return;
    }
    // Ctrl+J inserts a newline; plain Enter submits. This is the terminal-practical split because
    // most terminals cannot distinguish Shift+Enter from Enter.
    if (key.ctrl && input === "j") {
      insertText("\n");
      return;
    }
    if (key.tab) {
      const completed = completeSlashCommand(current.composer.value, current.composer.cursor);
      if (completed.value !== current.composer.value) {
        dispatch({ type: "notice/clear" });
        dispatch({ type: "composer/set", value: completed.value, cursor: completed.cursor });
      }
      return;
    }
    if (key.return) {
      submitComposer();
      return;
    }
    if (key.upArrow) {
      dispatch({ type: "composer/history-previous" });
      return;
    }
    if (key.downArrow) {
      dispatch({ type: "composer/history-next" });
      return;
    }
    if (key.leftArrow) {
      dispatch({
        type: "composer/set",
        value: current.composer.value,
        cursor: current.composer.cursor - 1,
      });
      return;
    }
    if (key.rightArrow) {
      dispatch({
        type: "composer/set",
        value: current.composer.value,
        cursor: current.composer.cursor + 1,
      });
      return;
    }
    if (key.backspace || key.delete) {
      const { value, cursor } = current.composer;
      if (cursor === 0) return;
      dispatch({ type: "notice/clear" });
      dispatch({
        type: "composer/set",
        value: value.slice(0, cursor - 1) + value.slice(cursor),
        cursor: cursor - 1,
      });
      return;
    }
    if (isPrintable(input, key)) insertText(input);
  });

  function insertText(text: string): void {
    const { value, cursor } = stateRef.current.composer;
    dispatch({ type: "notice/clear" });
    dispatch({
      type: "composer/set",
      value: value.slice(0, cursor) + text + value.slice(cursor),
      cursor: cursor + text.length,
    });
  }

  function handleFormulaInput(
    input: string,
    key: Parameters<Parameters<typeof useInput>[0]>[1],
  ): void {
    const view = formulaView;
    if (view === undefined) return;
    const formula = lookupFormula(formulas, view.selectedKey);
    if (formula === undefined) {
      setFormulaView(undefined);
      return;
    }

    if (key.escape) {
      if (view.mode === "edit") {
        setFormulaView({
          ...view,
          mode: "browse",
          showSource: false,
          draft: view.appliedDraft ?? formula.tex,
          cursor: 0,
        });
      } else {
        setFormulaView(undefined);
      }
      return;
    }

    if (view.mode === "browse") {
      if (key.upArrow || input === "k") {
        const previous = previousFormula(formulas, formula);
        if (previous !== undefined) selectFormula(previous);
        return;
      }
      if (key.downArrow || input === "j") {
        const next = nextFormula(formulas, formula);
        if (next !== undefined) selectFormula(next);
        return;
      }
      if (input === "c" && !key.ctrl && !key.meta) {
        void copySelectedFormula(formula);
        return;
      }
      if (input === "e" && !key.ctrl && !key.meta) {
        const draft = view.appliedDraft ?? formula.tex;
        setFormulaView({
          ...view,
          mode: "edit",
          showSource: false,
          draft,
          cursor: formulaCursorOffset(draft, draft.length),
        });
        return;
      }
      if (input === "i" && !key.ctrl && !key.meta) {
        insertSelectedFormula(formula);
        return;
      }
      if (input === "s" && !key.ctrl && !key.meta) {
        setFormulaView({ ...view, showSource: !view.showSource });
      }
      return;
    }

    if (key.return) {
      const draft = boundedFormulaDraft(view.draft);
      setFormulaView({
        ...view,
        mode: "browse",
        showSource: false,
        draft,
        cursor: 0,
        appliedDraft: draft,
      });
      return;
    }
    if (key.leftArrow) {
      setFormulaView({ ...view, cursor: formulaCursorLeft(view.draft, view.cursor) });
      return;
    }
    if (key.rightArrow) {
      setFormulaView({ ...view, cursor: formulaCursorRight(view.draft, view.cursor) });
      return;
    }
    if (key.backspace) {
      const cursor = formulaCursorOffset(view.draft, view.cursor);
      const previous = formulaCursorLeft(view.draft, cursor);
      if (previous === cursor) return;
      const draft = view.draft.slice(0, previous) + view.draft.slice(cursor);
      setFormulaView({ ...view, draft, cursor: previous });
      return;
    }
    if (key.delete) {
      const cursor = formulaCursorOffset(view.draft, view.cursor);
      const next = formulaCursorRight(view.draft, cursor);
      if (next === cursor) return;
      const draft = view.draft.slice(0, cursor) + view.draft.slice(next);
      setFormulaView({ ...view, draft, cursor });
      return;
    }
    if (key.ctrl && input === "j") {
      updateFormulaDraft(view, "\n");
      return;
    }
    if (isPrintable(input, key)) updateFormulaDraft(view, input);
  }

  function selectFormula(formula: FormulaRef): void {
    setFormulaView({
      selectedKey: formula.key,
      selectedSource: formula.source,
      mode: "browse",
      showSource: false,
      draft: formula.tex,
      cursor: 0,
    });
  }

  function updateFormulaDraft(view: FormulaViewState, insertion: string): void {
    const cursor = formulaCursorOffset(view.draft, view.cursor);
    const before = view.draft.slice(0, cursor);
    const candidate = before + insertion + view.draft.slice(cursor);
    const draft = boundedFormulaDraft(candidate);
    const requestedCursor = Math.min(before.length + insertion.length, draft.length);
    setFormulaView({
      ...view,
      draft,
      cursor: formulaCursorOffset(draft, requestedCursor),
    });
  }

  function handleOverlayInput(
    input: string,
    key: Parameters<Parameters<typeof useInput>[0]>[1],
  ): void {
    const current = stateRef.current;
    const overlay = current.overlay;

    if (key.escape) {
      dispatch({ type: "overlay/close" });
      return;
    }

    switch (overlay.kind) {
      case "help":
        if (key.return) dispatch({ type: "overlay/close" });
        return;

      case "source": {
        if (key.return) {
          dispatch({ type: "overlay/close" });
          return;
        }
        // Paging is the whole point of this overlay: a response longer than one page must still be
        // readable to its final line, so every movement key is clamped rather than ignored. The
        // page size is the one the overlay actually draws, so a page key moves exactly one screen.
        const total = sourceRowCount;
        const pageLines = sourceOverlayPageLines(conversationHeight);
        const move = (delta: number): void => {
          dispatch({
            type: "overlay/open",
            overlay: {
              kind: "source",
              offset: clampSourceOffset(overlay.offset + delta, total, pageLines),
            },
          });
        };
        if (key.upArrow) move(-1);
        else if (key.downArrow) move(1);
        else if (key.pageUp) move(-pageLines);
        else if (key.pageDown) move(pageLines);
        else if (key.home) move(-total);
        else if (key.end) move(total);
        return;
      }

      case "commands": {
        const next = moveSelection(overlay.selected, SLASH_COMMANDS.length, key);
        if (next !== undefined) {
          dispatch({ type: "overlay/open", overlay: { kind: "commands", selected: next } });
          return;
        }
        if (key.return) {
          const command = SLASH_COMMANDS[overlay.selected];
          dispatch({ type: "overlay/close" });
          // Selecting `/commands` from inside this overlay would close and immediately reopen it,
          // which reads as a no-op flicker; closing alone is the honest outcome.
          if (command !== undefined && command.name !== "/commands") runCommand(command.name);
        }
        return;
      }

      case "provider-picker": {
        const next = moveSelection(overlay.selected, PROVIDER_CHOICES.length, key);
        if (next !== undefined) {
          dispatch({ type: "overlay/open", overlay: { kind: "provider-picker", selected: next } });
          return;
        }
        if (key.return) {
          const choice = PROVIDER_CHOICES[overlay.selected];
          if (choice === undefined) return;
          dispatch({
            type: "overlay/open",
            overlay: {
              kind: "provider-form",
              form: {
                kind: choice.kind,
                providerId: choice.kind === "openrouter" ? "openrouter" : "",
                baseUrl: "",
                apiKeyEnvironmentVariable:
                  choice.kind === "openrouter" ? "OPENROUTER_API_KEY" : "OPENAI_API_KEY",
                apiKey: "",
                focusedField: 0,
                submitting: false,
              },
            },
          });
        }
        return;
      }

      case "provider-form": {
        const form = overlay.form;
        if (form.submitting) return;
        const fields = formFields(form.kind);
        if (key.tab) {
          const delta = key.shift ? -1 : 1;
          const focusedField = (form.focusedField + delta + fields.length) % fields.length;
          dispatch({
            type: "overlay/open",
            overlay: { kind: "provider-form", form: { ...form, focusedField } },
          });
          return;
        }
        if (key.return) {
          void connect(form);
          return;
        }
        const field = fields[form.focusedField];
        if (field === undefined) return;
        const currentValue = form[field.key];
        if (key.backspace || key.delete) {
          dispatch({
            type: "overlay/open",
            overlay: {
              kind: "provider-form",
              form: { ...form, [field.key]: currentValue.slice(0, -1), error: undefined },
            },
          });
          return;
        }
        if (isPrintable(input, key)) {
          dispatch({
            type: "overlay/open",
            overlay: {
              kind: "provider-form",
              form: { ...form, [field.key]: currentValue + input, error: undefined },
            },
          });
        }
        return;
      }

      case "model": {
        const matches = filterModels(current.catalog, overlay.query);
        const next = moveSelection(overlay.selected, matches.length, key);
        if (next !== undefined) {
          dispatch({
            type: "overlay/open",
            overlay: { kind: "model", query: overlay.query, selected: next },
          });
          return;
        }
        if (key.return) {
          const descriptor = matches[overlay.selected];
          if (descriptor === undefined) return;
          if (descriptor.status === "unavailable") {
            notify("error", "That model is marked unavailable by the provider.");
            return;
          }
          dispatch({ type: "overlay/close" });
          dispatch({ type: "model/select", model: descriptor.canonicalId });
          // The selected model is visible in the sidebar/footer; suppress both routine success
          // chatter and the reducer's informational variant-reset notice.
          dispatch({ type: "notice/clear" });
          void props.controller.saveConfig({ model: descriptor.canonicalId }).catch(() => {});
          return;
        }
        if (key.backspace || key.delete) {
          dispatch({
            type: "overlay/open",
            overlay: { kind: "model", query: overlay.query.slice(0, -1), selected: 0 },
          });
          return;
        }
        if (isPrintable(input, key)) {
          dispatch({
            type: "overlay/open",
            overlay: { kind: "model", query: overlay.query + input, selected: 0 },
          });
        }
        return;
      }

      case "variant": {
        const variants = availableVariants(selectedDescriptor(current));
        const next = moveSelection(overlay.selected, variants.length, key);
        if (next !== undefined) {
          dispatch({ type: "overlay/open", overlay: { kind: "variant", selected: next } });
          return;
        }
        if (key.return) {
          const variant = variants[overlay.selected];
          if (variant === undefined) return;
          dispatch({ type: "overlay/close" });
          dispatch({ type: "variant/select", variant: variant as ReasoningIntent });
          void props.controller.saveConfig({ variant: variant as ReasoningIntent }).catch(() => {});
        }
        return;
      }

      case "theme": {
        const names = tuiThemeNames();
        const next = moveSelection(overlay.selected, names.length, key);
        if (next !== undefined) {
          const name = names[next];
          dispatch({ type: "overlay/open", overlay: { kind: "theme", selected: next } });
          // Applying on move gives an immediate whole-application preview.
          if (name !== undefined && isThemeName(name)) {
            dispatch({ type: "theme/set", name: name as ThemeName });
            void props.controller.saveConfig({ themeName: name }).catch(() => {});
          }
          return;
        }
        if (key.return) dispatch({ type: "overlay/close" });
        return;
      }

      case "sessions": {
        const next = moveSelection(overlay.selected, overlay.sessions.length, key);
        if (next !== undefined) {
          dispatch({
            type: "overlay/open",
            overlay: { kind: "sessions", sessions: overlay.sessions, selected: next },
          });
          return;
        }
        if (key.return) {
          const session = overlay.sessions[overlay.selected];
          if (session === undefined) return;
          void loadSession(session.id);
        }
        return;
      }

      case "read": {
        if (key.return) {
          void stageDocument(overlay.value);
          return;
        }
        if (key.backspace || key.delete) {
          dispatch({
            type: "overlay/open",
            overlay: { kind: "read", value: overlay.value.slice(0, -1) },
          });
          return;
        }
        if (isPrintable(input, key)) {
          dispatch({
            type: "overlay/open",
            overlay: { kind: "read", value: overlay.value + input },
          });
        }
        return;
      }

      case "none":
        return;
    }
  }

  // --- Rendering -----------------------------------------------------------------------------

  const overlayNode = formulaView === undefined ? renderOverlay() : renderFormulaOverlay();
  const background = themeColor(theme, "background");

  return (
    <Box
      flexDirection="column"
      width={terminalWidth}
      height={terminalHeight}
      alignItems="center"
      {...(background === undefined ? {} : { backgroundColor: background })}
    >
      <Box
        flexDirection="row"
        width={terminalWidth}
        height={terminalHeight}
        justifyContent="center"
      >
        <Box flexDirection="column" width={width} height={terminalHeight}>
          {showHeader ? (
            <Header theme={theme} state={state} version={VERSION} width={width} />
          ) : null}
          {isHome ? (
            <Welcome
              theme={theme}
              width={width}
              height={conversationHeight}
              state={state}
              childRows={composerInputRows + homeNoticeRows}
            >
              <Box flexDirection="column" alignSelf="center" width={composerWidth}>
                {homeNoticeRows === 0 ? null : (
                  <Notices theme={theme} notices={state.notices} width={composerWidth} />
                )}
                <Composer
                  theme={theme}
                  composer={state.composer}
                  disabled={state.runStatus !== "idle"}
                  width={composerWidth}
                  maxSuggestionRows={suggestionBudget}
                />
              </Box>
            </Welcome>
          ) : overlayNode === undefined ? (
            conversationHeight > 0 ? (
              <Conversation
                theme={theme}
                entries={state.conversation}
                height={conversationHeight}
                scrollOffset={state.scrollOffset}
                {...(props.graphicsRuntime === undefined
                  ? {}
                  : { graphicsRuntime: props.graphicsRuntime })}
                {...(formulaView === undefined
                  ? {}
                  : { selectedFormulaKey: formulaView.selectedKey })}
                onScrollRangeChange={(maxRows) => dispatch({ type: "scroll/range", maxRows })}
                emptyHint={
                  state.connection === undefined
                    ? "No provider is connected. Use /provider to connect OpenRouter or an OpenAI-compatible endpoint."
                    : state.model === undefined
                      ? "Connected. Use /model to select a model from the live catalog."
                      : "Type a prompt, or / for commands."
                }
              />
            ) : null
          ) : (
            <Box
              {...(formulaView === undefined ? {} : { ref: formulaOverlayRef })}
              flexDirection="column"
              flexGrow={1}
              flexShrink={1}
              minHeight={0}
              height={conversationHeight}
              paddingX={1}
              overflow="hidden"
            >
              {overlayNode}
            </Box>
          )}
          {!isHome && !(overlayOpen && tinyTerminal) ? (
            <Notices theme={theme} notices={state.notices} width={width} />
          ) : null}
          {!isHome && !(overlayOpen && tinyTerminal) ? (
            <Composer
              theme={theme}
              composer={state.composer}
              disabled={state.runStatus !== "idle"}
              width={width}
              maxSuggestionRows={suggestionBudget}
            />
          ) : null}
          {showFooter ? <Footer theme={theme} state={state} width={width} /> : null}
        </Box>
        {showSidebar ? <Sidebar theme={theme} state={state} /> : null}
      </Box>
    </Box>
  );

  function copyFormulaSourceForOverlay(source: string): Promise<void> {
    return copyFormula(source).then((result) => {
      if (result.ok) notify("success", "Formula source copied.");
      else notify("warning", `Formula source was not copied (${result.reason}).`);
    });
  }

  function selectFormulaForEdit(formula: FormulaRef): void {
    const draft = formulaView?.appliedDraft ?? formula.tex;
    setFormulaView({
      selectedKey: formula.key,
      selectedSource: formula.source,
      mode: "edit",
      showSource: false,
      draft,
      cursor: formulaCursorOffset(draft, draft.length),
      ...(formulaView?.appliedDraft === undefined
        ? {}
        : { appliedDraft: formulaView.appliedDraft }),
    });
  }

  function insertFormulaSource(source: string): void {
    if (activeRun.current !== undefined) {
      notify("warning", ACTIVE_RUN_COMMAND_WARNING);
      return;
    }
    const composer = stateRef.current.composer;
    const cursor = Math.min(Math.max(composer.cursor, 0), composer.value.length);
    dispatch({
      type: "composer/set",
      value: composer.value.slice(0, cursor) + source + composer.value.slice(cursor),
      cursor: cursor + source.length,
    });
    setFormulaView(undefined);
  }

  function renderFormulaOverlay(): ReactNode | undefined {
    const view = formulaView;
    const formula = selectedFormula;
    if (view === undefined || formula === undefined) return undefined;
    const previewSource = selectedFormulaPreviewSource ?? formula.source;
    const runtime = props.graphicsRuntime;
    let renderStyle: ReturnType<typeof formulaRenderStyle> | undefined;
    let graphicsSupported = false;
    if (runtime !== undefined) {
      try {
        renderStyle = formulaRenderStyle(theme, runtime.rendererId);
        graphicsSupported = renderStyle !== undefined && runtime.supportsGraphics();
      } catch {
        renderStyle = undefined;
        graphicsSupported = false;
      }
    }
    const localDraftPreview = view.appliedDraft !== undefined && !view.showSource;
    // An absent or unsupported runtime must not be represented as a fake "preview": showing the
    // source directly lets the overlay label it honestly. A supported runtime can still fail while
    // rendering, so FormulaGraphic retains its exact-source fallback under an explicit status.
    const preview =
      view.showSource || !graphicsSupported ? undefined : (
        <FormulaGraphic
          runtime={runtime as FormulaGraphicsRuntime}
          formulaKey={`formula-preview-${formula.ordinal}`}
          exactSource={previewSource}
          innerTex={selectedFormulaDraft ?? formula.tex}
          display={formula.kind === "display"}
          inline={formula.kind !== "display"}
          clipRef={formulaOverlayRef as FormulaGraphicsRefLike}
          {...(renderStyle === undefined ? {} : { renderStyle })}
        />
      );
    const exactSource = view.showSource ? formula.source : previewSource;
    const sourceLabel = view.showSource
      ? undefined
      : localDraftPreview
        ? "Local draft · typeset preview unavailable"
        : !graphicsSupported
          ? "Exact source · typeset preview unavailable"
          : undefined;
    const previewLabel = localDraftPreview
      ? "Local draft preview/fallback · canonical source unchanged"
      : "Typeset preview · exact source fallback";
    if (view.mode === "edit") {
      return (
        <FormulaOverlay
          theme={theme}
          formula={formula}
          position={formula.ordinal + 1}
          count={formulas.length}
          mode="edit"
          draft={view.draft}
          cursor={view.cursor}
          preview={preview}
          previewLabel={previewLabel}
          exactSource={exactSource}
          sourceLabel={sourceLabel}
          localDraft={localDraftPreview}
          width={sourcePanelWidth}
          height={conversationHeight}
          onDraftChange={(draft, cursor) =>
            setFormulaView({ ...view, draft: boundedFormulaDraft(draft), cursor })
          }
          onApply={(draft) => {
            const bounded = boundedFormulaDraft(draft);
            setFormulaView({
              ...view,
              mode: "browse",
              showSource: false,
              draft: bounded,
              cursor: 0,
              appliedDraft: bounded,
            });
          }}
          onCancel={() =>
            setFormulaView({
              ...view,
              mode: "browse",
              showSource: false,
              draft: view.appliedDraft ?? formula.tex,
              cursor: 0,
            })
          }
        />
      );
    }
    return (
      <FormulaOverlay
        theme={theme}
        formula={formula}
        position={formula.ordinal + 1}
        count={formulas.length}
        preview={preview}
        previewLabel={previewLabel}
        exactSource={exactSource}
        sourceLabel={sourceLabel}
        localDraft={localDraftPreview}
        width={sourcePanelWidth}
        height={conversationHeight}
        onPrevious={() => {
          const previous = previousFormula(formulas, formula);
          if (previous !== undefined) selectFormula(previous);
        }}
        onNext={() => {
          const next = nextFormula(formulas, formula);
          if (next !== undefined) selectFormula(next);
        }}
        onCopy={(source) => {
          void copyFormulaSourceForOverlay(source);
        }}
        onEdit={selectFormulaForEdit}
        onInsert={(source) => insertFormulaSource(source)}
        onClose={() => setFormulaView(undefined)}
      />
    );
  }

  function renderOverlay(): ReactNode | undefined {
    switch (state.overlay.kind) {
      case "none":
        return undefined;
      case "help":
        return <HelpOverlay theme={theme} />;
      case "source":
        return (
          <SourceOverlay
            theme={theme}
            source={state.latestAssistantSource}
            offset={state.overlay.offset}
            regionHeight={conversationHeight}
            width={sourcePanelWidth}
          />
        );
      case "commands":
        return <CommandOverlay theme={theme} selected={state.overlay.selected} />;
      case "provider-picker":
        return <ProviderPicker theme={theme} selected={state.overlay.selected} />;
      case "provider-form":
        return (
          <ProviderForm
            theme={theme}
            form={state.overlay.form}
            disclosure={providerDisclosure(state.overlay.form)}
          />
        );
      case "model":
        return (
          <ModelOverlay
            theme={theme}
            catalog={state.catalog}
            query={state.overlay.query}
            selected={state.overlay.selected}
            loading={state.catalogLoading}
            secrets={secrets}
          />
        );
      case "variant":
        return (
          <VariantOverlay
            theme={theme}
            variants={availableVariants(selectedDescriptor(state))}
            current={state.variant}
            selected={state.overlay.selected}
            modelLabel={state.model ?? "no selected model"}
          />
        );
      case "theme":
        return (
          <ThemeOverlay theme={theme} names={tuiThemeNames()} selected={state.overlay.selected} />
        );
      case "sessions":
        return (
          <SessionOverlay
            theme={theme}
            sessions={state.overlay.sessions}
            selected={state.overlay.selected}
          />
        );
      case "read":
        return (
          <ReadOverlay
            theme={theme}
            value={state.overlay.value}
            error={state.overlay.error}
            workspaceRoot={state.workspaceRoot}
          />
        );
    }
  }
}

/** Describes the exact external endpoint the form will contact, so network use is never implicit. */
export function providerDisclosure(form: ProviderFormState): string {
  if (form.kind === "openrouter") {
    return `connecting will contact ${OPENROUTER_DEFAULT_BASE_URL} using the built-in OPENROUTER_API_KEY reference`;
  }
  const raw = form.baseUrl.trim().length > 0 ? form.baseUrl.trim() : "";
  if (raw.length === 0) return "a base URL is required before any request is made";
  try {
    const url = new URL(raw);
    return `connecting will contact ${url.protocol}//${url.host} using the referenced credential`;
  } catch {
    return "the base URL is not a valid absolute URL";
  }
}

function moveSelection(
  selected: number,
  length: number,
  key: Readonly<{ upArrow: boolean; downArrow: boolean }>,
): number | undefined {
  if (length === 0) return undefined;
  if (key.upArrow) return (selected + length - 1) % length;
  if (key.downArrow) return (selected + 1) % length;
  return undefined;
}

function isPrintable(
  input: string,
  key: Readonly<{ ctrl: boolean; meta: boolean; tab: boolean; return: boolean; escape: boolean }>,
): boolean {
  if (input.length === 0) return false;
  if (key.ctrl || key.meta || key.tab || key.return || key.escape) return false;
  for (const character of input) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

function boundedFormulaDraft(value: string): string {
  if (value.length <= MAX_FORMULA_DRAFT_CHARACTERS) return value;
  let end = 0;
  for (const item of formulaGraphemes.segment(value)) {
    const next = item.index + item.segment.length;
    if (next > MAX_FORMULA_DRAFT_CHARACTERS) break;
    end = next;
  }
  return value.slice(0, end);
}

function formulaCursorLeft(value: string, cursor: number): number {
  const safe = formulaCursorOffset(value, cursor);
  if (safe === 0) return 0;
  let previous = 0;
  for (const item of formulaGraphemes.segment(value)) {
    if (item.index >= safe) break;
    previous = item.index;
  }
  return previous;
}

function formulaCursorRight(value: string, cursor: number): number {
  const safe = formulaCursorOffset(value, cursor);
  if (safe >= value.length) return value.length;
  for (const item of formulaGraphemes.segment(value)) {
    if (item.index >= safe) return item.index + item.segment.length;
    const end = item.index + item.segment.length;
    if (safe < end) return end;
  }
  return value.length;
}

const MESSAGE_ROLES: readonly MessageRole[] = ["user", "assistant", "tool", "system"];

/** Guards a persisted session role string before it becomes a conversation entry role. */
function isMessageRole(value: string): value is MessageRole {
  return (MESSAGE_ROLES as readonly string[]).includes(value);
}

/** Guards a persisted provider identity before it enters a connection or notice. */
function validSessionProviderId(value: string | null): string | null {
  if (value === null) return null;
  const parsed = ProviderIdSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Guards a persisted canonical model and prevents cross-provider identity drift. */
function validSessionModelId(
  value: string | null,
  expectedProvider: string | undefined,
): string | null {
  if (value === null || expectedProvider === undefined) return null;
  const parsed = CanonicalModelIdSchema.safeParse(value);
  if (parsed.success) {
    try {
      if (splitCanonicalModelId(parsed.data).providerId !== expectedProvider) return null;
    } catch {
      return null;
    }
    return parsed.data;
  }
  // Legacy session files stored the provider-local model id without its canonical provider prefix.
  if (!ModelIdSchema.safeParse(value).success) return null;
  return `${expectedProvider}:${value}`;
}

/** Guards a persisted reasoning intent; an absent/invalid value falls back to the neutral intent. */
function validSessionVariant(value: string | null): ReasoningIntent | undefined {
  if (value === null) return undefined;
  const parsed = ReasoningIntentSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
