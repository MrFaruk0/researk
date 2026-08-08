import type { ChatMessage, ReasoningIntent } from "@researk/contracts";
import { Box, useApp, useInput, useStdout } from "ink";
import { type ReactNode, useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import { VERSION } from "../help.js";
import { redactSecrets, safeErrorMessage, safeTerminalText } from "../safety.js";
import { isThemeName, type ThemeName } from "../theme.js";
import { parseSlashCommand, SLASH_COMMANDS } from "./commands.js";
import { Composer } from "./components/Composer.js";
import { Conversation } from "./components/Conversation.js";
import { Footer } from "./components/Footer.js";
import { Header } from "./components/Header.js";
import { Notices } from "./components/Notices.js";
import type { ChatOutcome, ControllerEvent, TuiController } from "./controller.js";
import { OPENROUTER_DEFAULT_BASE_URL } from "./controller.js";
import {
  clampSourceOffset,
  CommandOverlay,
  HelpOverlay,
  ReadOverlay,
  sourceLines,
  SourceOverlay,
  sourceOverlayPageLines,
} from "./overlays/InfoOverlays.js";
import { filterModels, ModelOverlay } from "./overlays/ModelOverlay.js";
import {
  formFields,
  PROVIDER_CHOICES,
  ProviderForm,
  ProviderPicker,
} from "./overlays/ProviderOverlay.js";
import { ThemeOverlay, VariantOverlay } from "./overlays/SelectOverlays.js";
import { reduce } from "./reducer.js";
import {
  type AppState,
  availableVariants,
  MAX_CHAT_MESSAGE_CHARACTERS,
  MAX_TUI_HISTORY_MESSAGES,
  type ProviderFormState,
  selectedDescriptor,
} from "./state.js";
import { createTuiTheme, tuiThemeNames } from "./theme.js";

export interface AppProps {
  readonly controller: TuiController;
  readonly initialState: AppState;
  /** Injected for tests so notice identities and timings stay deterministic. */
  readonly now?: () => number;
  /** Overrides Ink's own exit so the exit path can be observed in tests. */
  readonly onExit?: () => void;
}

let noticeCounter = 0;

export function App(props: AppProps): ReactNode {
  const [state, dispatch] = useReducer(reduce, props.initialState);
  const { exit } = useApp();
  const { stdout } = useStdout();
  const now = props.now ?? Date.now;

  const activeRun = useRef<AbortController | undefined>(undefined);
  /** Increments per connection attempt so a superseded reply cannot overwrite a newer connection. */
  const connectGeneration = useRef(0);
  const stateRef = useRef(state);
  stateRef.current = state;

  const theme = useMemo(
    () => createTuiTheme(state.themeName, { colorEnabled: state.colorEnabled }),
    [state.themeName, state.colorEnabled],
  );

  const width = Math.max(40, stdout.columns ?? 80);
  const height = Math.max(10, stdout.rows ?? 24);
  // The conversation and any overlay share one fixed region. Both the key handler and the renderer
  // need this height, so it is derived once here rather than recomputed at each use.
  const conversationHeight = Math.max(3, height - 12);

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

  useEffect(() => {
    if (!state.exiting) return;
    if (props.onExit === undefined) exit();
    else props.onExit();
  }, [state.exiting, exit, props.onExit]);

  // --- Actions -------------------------------------------------------------------------------

  const connect = useCallback(
    async (form: ProviderFormState): Promise<void> => {
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

      const credentialValues =
        form.apiKey.length === 0
          ? state.credentialValues
          : { ...state.credentialValues, [connection.apiKeyEnvironmentVariable]: form.apiKey };

      dispatch({
        type: "overlay/open",
        overlay: { kind: "provider-form", form: { ...form, submitting: true, error: undefined } },
      });
      dispatch({ type: "connection/connecting", connection });
      notify(
        "info",
        `[external] Contacting ${props.controller.describeConnection(connection)} to retrieve its model catalog. No workspace documents are sent.`,
      );

      // Catalog retrieval is slow enough that a user can start a second connection before the
      // first one answers. Each attempt claims a generation, and only the newest one is allowed to
      // write a result, so a late reply from a superseded endpoint cannot replace the connection,
      // catalog, or credentials the user actually chose.
      connectGeneration.current += 1;
      const generation = connectGeneration.current;

      try {
        const catalog = await props.controller.connect(connection, credentialValues);
        if (generation !== connectGeneration.current) return;
        dispatch({ type: "connection/connected", connection, catalog, credentialValues });
        dispatch({ type: "overlay/close" });
        notify(
          "success",
          `Connected to ${props.controller.describeConnection(connection)} with ${catalog.length} model(s). Use /model to select one.`,
        );
      } catch (error) {
        if (generation !== connectGeneration.current) return;
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
    [props.controller, state.credentialValues, notify],
  );

  const submitPrompt = useCallback(
    async (prompt: string): Promise<void> => {
      const current = stateRef.current;
      // Defence in depth: the single-run invariant is enforced at the call site, but this is the
      // function that actually claims `activeRun`, so it re-checks before overwriting the slot.
      if (activeRun.current !== undefined) return;
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
      dispatch({ type: "documents/consume" });
      dispatch({ type: "run/status", status: "starting" });
      notify(
        "info",
        `[external] Sending ${documents.length === 0 ? "your prompt" : `your prompt and ${documents.length} staged document(s)`} to ${props.controller.describeConnection(current.connection)}.`,
      );

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
                notify("info", `model ${event.canonicalId} \u00b7 variant ${event.variant}`);
                break;
              case "diagnostic":
                notify(event.level === "error" ? "error" : "warning", event.message);
                break;
              case "tool":
                notify("info", event.message);
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
        notify("error", safeErrorMessage(error, secretsRef.current));
      } finally {
        activeRun.current = undefined;
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
      }

      if (outcome !== undefined && outcome.text.length > MAX_CHAT_MESSAGE_CHARACTERS) {
        notify("warning", "This exchange exceeds the retained message size limit.");
      }
    },
    [props.controller, notify, now],
  );

  const stageDocument = useCallback(
    async (request: string): Promise<void> => {
      try {
        const document = await props.controller.stageDocument(
          request,
          stateRef.current.stagedDocuments,
        );
        dispatch({ type: "documents/stage", document });
        dispatch({ type: "overlay/close" });
        notify(
          "success",
          `Staged ${document.relativePath} (${document.byteLength.toLocaleString("en-US")} bytes). It stays local until your next prompt.`,
        );
      } catch (error) {
        dispatch({
          type: "overlay/open",
          overlay: { kind: "read", value: request, error: safeErrorMessage(error) },
        });
      }
    },
    [props.controller, notify],
  );

  const openModelOverlay = useCallback(async (): Promise<void> => {
    const current = stateRef.current;
    if (current.connection === undefined) {
      notify("error", "Connect a provider first with /provider.");
      return;
    }
    dispatch({ type: "overlay/open", overlay: { kind: "model", query: "", selected: 0 } });
    if (current.catalog.length > 0) return;
    dispatch({ type: "catalog/loading", loading: true });
    notify(
      "info",
      `[external] Retrieving the model catalog from ${props.controller.describeConnection(current.connection)}.`,
    );
    try {
      const catalog = await props.controller.refreshCatalog(
        current.connection,
        current.credentialValues,
      );
      dispatch({ type: "catalog/loaded", catalog });
    } catch (error) {
      dispatch({ type: "catalog/loading", loading: false });
      notify("error", safeErrorMessage(error, secrets));
    }
  }, [props.controller, notify, secrets]);

  const runCommand = useCallback(
    (line: string): void => {
      const parsed = parseSlashCommand(line);
      if (parsed === undefined) return;
      const current = stateRef.current;
      switch (parsed.name) {
        case "/exit":
          dispatch({ type: "exit" });
          return;
        case "/help":
          dispatch({ type: "overlay/open", overlay: { kind: "help" } });
          return;
        case "/commands":
          dispatch({ type: "overlay/open", overlay: { kind: "commands", selected: 0 } });
          return;
        case "/clear":
          dispatch({ type: "conversation/clear" });
          notify("info", "Conversation cleared.");
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
        default:
          notify("error", `Unknown command ${parsed.name}. Use /help.`);
      }
    },
    [notify, openModelOverlay, stageDocument],
  );

  const submitComposer = useCallback((): void => {
    const current = stateRef.current;
    const trimmed = current.composer.value.trim();
    if (trimmed.length === 0) return;
    // A run owns the single `activeRun` slot. Submitting a prompt while one is in flight would
    // start a second Harness run and overwrite that slot, orphaning the first run beyond the reach
    // of Ctrl+C. Slash commands stay available because they never start a run.
    if (current.runStatus !== "idle" && !trimmed.startsWith("/")) {
      notify("warning", "A response is still streaming. Press Ctrl+C to cancel it first.");
      return;
    }
    dispatch({ type: "composer/submit" });
    if (trimmed.startsWith("/")) {
      runCommand(trimmed);
      return;
    }
    void submitPrompt(trimmed);
  }, [runCommand, submitPrompt, notify]);

  // --- Input ---------------------------------------------------------------------------------

  useInput((input, key) => {
    const current = stateRef.current;

    // Ctrl+C cancels an active run and keeps the app mounted; when idle it exits.
    if (key.ctrl && input === "c") {
      if (activeRun.current !== undefined) {
        activeRun.current.abort();
        dispatch({ type: "run/status", status: "cancelling" });
        return;
      }
      dispatch({ type: "exit" });
      return;
    }

    if (current.overlay.kind !== "none") {
      handleOverlayInput(input, key);
      return;
    }

    if (key.ctrl && input === "l") {
      dispatch({ type: "conversation/clear" });
      return;
    }
    if (key.pageUp) {
      dispatch({ type: "scroll/by", lines: 1 });
      return;
    }
    if (key.pageDown) {
      if (current.scrollOffset === 0) dispatch({ type: "scroll/follow" });
      else dispatch({ type: "scroll/by", lines: -1 });
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
    dispatch({
      type: "composer/set",
      value: value.slice(0, cursor) + text + value.slice(cursor),
      cursor: cursor + text.length,
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
        const total = sourceLines(current.latestAssistantSource ?? "").length;
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
          notify("success", `Selected ${safeTerminalText(descriptor.canonicalId, secrets)}.`);
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
          notify("success", `Variant set to ${variant}.`);
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
          }
          return;
        }
        if (key.return) dispatch({ type: "overlay/close" });
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

  const overlayNode = renderOverlay();

  return (
    <Box flexDirection="column" width={width} height={height}>
      <Header theme={theme} state={state} version={VERSION} width={width} />
      {overlayNode === undefined ? (
        <Conversation
          theme={theme}
          entries={state.conversation}
          height={conversationHeight}
          scrollOffset={state.scrollOffset}
          emptyHint={
            state.connection === undefined
              ? "No provider is connected. Use /provider to connect OpenRouter or an OpenAI-compatible endpoint."
              : state.model === undefined
                ? "Connected. Use /model to select a model from the live catalog."
                : "Ready. Type a prompt, or / for commands."
          }
        />
      ) : (
        <Box
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
      <Notices theme={theme} notices={state.notices} width={width} />
      <Composer
        theme={theme}
        composer={state.composer}
        disabled={state.runStatus !== "idle"}
        width={width}
      />
      <Footer theme={theme} state={state} width={width} />
    </Box>
  );

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
  const raw =
    form.baseUrl.trim().length > 0
      ? form.baseUrl.trim()
      : form.kind === "openrouter"
        ? OPENROUTER_DEFAULT_BASE_URL
        : "";
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
