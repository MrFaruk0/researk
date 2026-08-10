import type { ModelDescriptor } from "@researk/contracts";
import { describe, expect, it } from "vitest";
import {
  completeSlashCommand,
  discoverSlashCommands,
  isKnownSlashCommand,
  parseSlashCommand,
  SLASH_COMMANDS,
} from "../src/tui/commands.js";
import { classifyContent } from "../src/tui/content.js";
import { reduce } from "../src/tui/reducer.js";
import {
  type AppState,
  availableVariants,
  createInitialState,
  MAX_COMMAND_HISTORY,
  MAX_TUI_CONVERSATION_ENTRIES,
  selectedDescriptor,
} from "../src/tui/state.js";
import { createTuiTheme, TUI_THEME_TOKENS, themeColor, tuiThemeNames } from "../src/tui/theme.js";

function baseState(): AppState {
  return createInitialState({
    workspaceRoot: "/workspace",
    themeName: "system",
    colorEnabled: true,
    variant: "auto",
  });
}

function descriptor(
  canonicalId: string,
  intents: readonly string[],
  status: ModelDescriptor["status"] = "available",
): ModelDescriptor {
  const [providerId = "compatible", modelId = "model"] = canonicalId.split(":");
  return {
    providerId,
    modelId,
    canonicalId,
    displayName: canonicalId,
    revision: null,
    status,
    catalogSource: "live",
    capabilities: {
      streaming: true,
      toolCalls: false,
      structuredOutput: false,
      vision: false,
      files: false,
      reasoning: {
        supported: intents.length > 0,
        intents: intents as ModelDescriptor["capabilities"]["reasoning"]["intents"],
        nativeOverride: false,
        mandatory: false,
        supportsMaxTokens: false,
      },
    },
  } as ModelDescriptor;
}

describe("slash command discovery and routing", () => {
  it("offers every command for a bare slash", () => {
    expect(discoverSlashCommands("/").map((command) => command.name)).toEqual(
      SLASH_COMMANDS.map((command) => command.name),
    );
  });

  it("narrows discovery by prefix and is case-insensitive", () => {
    expect(discoverSlashCommands("/pro").map((command) => command.name)).toEqual(["/provider"]);
    expect(discoverSlashCommands("/PRO").map((command) => command.name)).toEqual(["/provider"]);
  });

  it("exposes each required command", () => {
    for (const required of [
      "/provider",
      "/model",
      "/variant",
      "/themes",
      "/sessions",
      "/new",
      "/help",
      "/clear",
      "/exit",
      "/read",
      "/source",
    ]) {
      expect(isKnownSlashCommand(required)).toBe(true);
    }
  });

  it("stops offering discovery once an argument is typed", () => {
    expect(discoverSlashCommands("/read paper.tex")).toEqual([]);
    expect(discoverSlashCommands("plain prompt")).toEqual([]);
  });

  it("splits a command from its argument", () => {
    expect(parseSlashCommand("/read  docs/paper.tex ")).toEqual({
      name: "/read",
      argument: "docs/paper.tex",
    });
    expect(parseSlashCommand("not a command")).toBeUndefined();
  });
});

describe("slash command Tab completion", () => {
  it("completes a unique prefix to the full command and moves the cursor to its end", () => {
    const result = completeSlashCommand("/pro", 4);
    expect(result).toEqual({ value: "/provider", cursor: 9, command: SLASH_COMMANDS[0] });
  });

  it("is case-insensitive and reports the matched command", () => {
    const result = completeSlashCommand("/PRO", 4);
    expect(result.value).toBe("/provider");
    expect(result.cursor).toBe(9);
    expect(result.command?.name).toBe("/provider");
  });

  it("completes only the text before the cursor and preserves the tail", () => {
    const result = completeSlashCommand("/prople", 4);
    expect(result).toEqual({
      value: "/providerple",
      cursor: 9,
      command: SLASH_COMMANDS[0],
    });
  });

  it("clamps an out-of-range cursor into the input", () => {
    const result = completeSlashCommand("/pro", 99);
    expect(result).toEqual({
      value: "/provider",
      cursor: 9,
      command: SLASH_COMMANDS[0],
    });
    const negative = completeSlashCommand("/pro", -3);
    // A negative cursor is treated as the start, so nothing before the slash completes.
    expect(negative).toEqual({ value: "/pro", cursor: 0 });
    expect(negative.command).toBeUndefined();
  });

  it("leaves an ambiguous prefix untouched because it must not guess", () => {
    // `/` matches every command, and `/c` matches both /commands and /clear, so neither can be
    // completed without guessing which one the user meant.
    const bare = completeSlashCommand("/", 1);
    expect(bare).toEqual({ value: "/", cursor: 1 });
    const ambiguous = completeSlashCommand("/c", 2);
    expect(ambiguous).toEqual({ value: "/c", cursor: 2 });
    expect(ambiguous.command).toBeUndefined();
  });

  it("completes an exact command unchanged", () => {
    const result = completeSlashCommand("/provider", 9);
    expect(result).toEqual({
      value: "/provider",
      cursor: 9,
      command: SLASH_COMMANDS[0],
    });
  });

  it("does nothing for plain prose or a command with an argument", () => {
    // The cursor is clamped to the input length before the no-op check, so an out-of-range cursor
    // reports the clamped position and never changes the text.
    expect(completeSlashCommand("prompt text", 12)).toEqual({ value: "prompt text", cursor: 11 });
    // Space ends the command head, so a cursor at the end of the command is not command text and
    // must not complete into anything.
    expect(completeSlashCommand("/read paper.tex", 15)).toEqual({
      value: "/read paper.tex",
      cursor: 15,
    });
  });
});

describe("provider-driven variants", () => {
  it("derives variants from the selected model capabilities without hardcoding", () => {
    const state: AppState = {
      ...baseState(),
      catalog: [descriptor("compatible:a", ["low", "high"])],
      model: "compatible:a",
    };
    expect(availableVariants(selectedDescriptor(state))).toEqual(["auto", "low", "high"]);
  });

  it("offers only auto when the model advertises no reasoning intents", () => {
    const state: AppState = {
      ...baseState(),
      catalog: [descriptor("compatible:plain", [])],
      model: "compatible:plain",
    };
    expect(availableVariants(selectedDescriptor(state))).toEqual(["auto"]);
  });

  it("resets a variant the newly selected model does not advertise", () => {
    const start: AppState = {
      ...baseState(),
      catalog: [descriptor("compatible:a", ["high"]), descriptor("compatible:b", ["low"])],
      model: "compatible:a",
      variant: "high",
    };
    const next = reduce(start, { type: "model/select", model: "compatible:b" });
    expect(next.variant).toBe("auto");
    expect(next.notices.at(-1)?.message).toContain("does not advertise");
  });

  it("keeps a variant the newly selected model still advertises", () => {
    const start: AppState = {
      ...baseState(),
      catalog: [descriptor("compatible:a", ["high"]), descriptor("compatible:b", ["high"])],
      model: "compatible:a",
      variant: "high",
    };
    expect(reduce(start, { type: "model/select", model: "compatible:b" }).variant).toBe("high");
  });
});

describe("semantic theme tokens", () => {
  it("offers the complete built-in theme list", () => {
    expect(tuiThemeNames()).toEqual([
      "system",
      "dark",
      "light",
      "high-contrast",
      "mono",
      "nord",
      "dracula",
      "solarized-dark",
      "gruvbox",
      "tokyo-night",
      "catppuccin",
      "rose-pine",
      "everforest",
    ]);
  });

  it("resolves content colors and optional surfaces for every theme", () => {
    const inheritableTokens = new Set([
      "background",
      "surface",
      "surfaceMuted",
      "userSurface",
      "assistantSurface",
    ]);
    for (const name of tuiThemeNames()) {
      const theme = createTuiTheme(name, { colorEnabled: true });
      for (const token of TUI_THEME_TOKENS) {
        const color = themeColor(theme, token);
        if (inheritableTokens.has(token)) {
          expect(color === undefined || typeof color === "string", `${name}.${token}`).toBe(true);
        } else {
          expect(color, `${name}.${token}`).toBeTypeOf("string");
        }
      }
    }
  });

  it("creates the colorful palettes with dedicated content colors", () => {
    for (const name of ["tokyo-night", "catppuccin", "rose-pine", "everforest"] as const) {
      const theme = createTuiTheme(name, { colorEnabled: true });
      expect(theme.palette.surface, `${name}.surface`).toBeTypeOf("string");
      expect(theme.palette.surfaceMuted, `${name}.surfaceMuted`).toBeTypeOf("string");
      expect(themeColor(theme, "math"), `${name}.math`).toBeTypeOf("string");
      expect(themeColor(theme, "code"), `${name}.code`).toBeTypeOf("string");
      expect(themeColor(theme, "citation"), `${name}.citation`).toBeTypeOf("string");
    }
  });

  it("suppresses every colour when colour is disabled", () => {
    const theme = createTuiTheme("dark", { colorEnabled: false });
    for (const token of TUI_THEME_TOKENS) {
      expect(themeColor(theme, token)).toBeUndefined();
    }
  });

  it("changes the whole palette when the theme changes", () => {
    const light = createTuiTheme("light", { colorEnabled: true });
    const dark = createTuiTheme("dark", { colorEnabled: true });
    expect(themeColor(light, "foreground")).not.toBe(themeColor(dark, "foreground"));
    expect(themeColor(light, "accent")).not.toBe(themeColor(dark, "accent"));
  });
});

describe("conversation state", () => {
  it("derives the newest completed assistant source from restored initial history", () => {
    const state = createInitialState({
      workspaceRoot: "/workspace",
      themeName: "system",
      colorEnabled: true,
      variant: "auto",
      conversation: [
        { id: "a-old", role: "assistant", source: "older", streaming: false, createdAt: 0 },
        { id: "tool", role: "tool", source: "tool output", streaming: false, createdAt: 0 },
        { id: "a-empty", role: "assistant", source: "", streaming: false, createdAt: 0 },
        {
          id: "a-streaming",
          role: "assistant",
          source: "partial placeholder",
          streaming: true,
          createdAt: 0,
        },
        { id: "system", role: "system", source: "metadata", streaming: false, createdAt: 0 },
      ],
    });
    expect(state.latestAssistantSource).toBe("");
  });

  it("streams deltas into one assistant entry in place", () => {
    let state = reduce(baseState(), {
      type: "conversation/append",
      entry: { id: "a1", role: "assistant", source: "", streaming: true, createdAt: 0 },
    });
    for (const delta of ["Hel", "lo ", "world"]) {
      state = reduce(state, { type: "conversation/append-delta", id: "a1", delta });
    }
    expect(state.conversation).toHaveLength(1);
    expect(state.conversation[0]?.source).toBe("Hello world");
  });

  it("retains canonical LaTeX exactly across chunked deltas", () => {
    const latex = String.raw`Result: \[\frac{\alpha_1}{\beta^2}\] and $E=mc^2$.`;
    let state = reduce(baseState(), {
      type: "conversation/append",
      entry: { id: "a1", role: "assistant", source: "", streaming: true, createdAt: 0 },
    });
    for (const character of latex) {
      state = reduce(state, { type: "conversation/append-delta", id: "a1", delta: character });
    }
    state = reduce(state, { type: "conversation/finish", id: "a1" });
    expect(state.conversation[0]?.source).toBe(latex);
    expect(state.latestAssistantSource).toBe(latex);
  });

  it("bounds retained conversation entries", () => {
    let state = baseState();
    for (let index = 0; index < MAX_TUI_CONVERSATION_ENTRIES + 25; index += 1) {
      state = reduce(state, {
        type: "conversation/append",
        entry: {
          id: `m${index}`,
          role: "user",
          source: `message ${index}`,
          streaming: false,
          createdAt: 0,
        },
      });
    }
    expect(state.conversation).toHaveLength(MAX_TUI_CONVERSATION_ENTRIES);
    expect(state.conversation.at(-1)?.id).toBe(`m${MAX_TUI_CONVERSATION_ENTRIES + 24}`);
  });

  it("clears the conversation and the retained source", () => {
    let state = reduce(baseState(), {
      type: "conversation/append",
      entry: { id: "a1", role: "assistant", source: "text", streaming: false, createdAt: 0 },
    });
    state = reduce(state, { type: "conversation/finish", id: "a1" });
    state = reduce(state, { type: "conversation/clear" });
    expect(state.conversation).toEqual([]);
    expect(state.latestAssistantSource).toBeUndefined();
  });
});

describe("session metadata", () => {
  it("starts every session untitled and unbound to a persisted session", () => {
    const state = baseState();
    expect(state.sessionId).toBeUndefined();
    expect(state.sessionTitle).toBe("New session");
    expect(state.sessionUpdatedAt).toBeUndefined();
  });

  it("loads a session with its metadata and replaces the conversation", () => {
    const state = reduce(baseState(), {
      type: "conversation/append",
      entry: { id: "a1", role: "assistant", source: "old", streaming: false, createdAt: 0 },
    });
    const loaded = reduce(state, {
      type: "session/load",
      sessionId: "session-abc",
      title: "My research",
      updatedAt: "2026-08-10T12:00:00.000Z",
      conversation: [
        { id: "u1", role: "user", source: "new question", streaming: false, createdAt: 0 },
      ],
    });
    expect(loaded.sessionId).toBe("session-abc");
    expect(loaded.sessionTitle).toBe("My research");
    expect(loaded.sessionUpdatedAt).toBe("2026-08-10T12:00:00.000Z");
    expect(loaded.conversation).toHaveLength(1);
    expect(loaded.conversation[0]?.source).toBe("new question");
    // A replaced conversation must not retain the previous assistant source.
    expect(loaded.latestAssistantSource).toBeUndefined();
    expect(loaded.scrollOffset).toBe(0);
  });

  it("bounds an over-large loaded conversation to the retained window", () => {
    const loaded = reduce(baseState(), {
      type: "session/load",
      sessionId: "session-big",
      title: "Big session",
      updatedAt: "2026-08-10T12:00:00.000Z",
      conversation: Array.from({ length: MAX_TUI_CONVERSATION_ENTRIES + 25 }, (_value, index) => ({
        id: `m${index}`,
        role: "user" as const,
        source: `message ${index}`,
        streaming: false,
        createdAt: 0,
      })),
    });
    expect(loaded.conversation).toHaveLength(MAX_TUI_CONVERSATION_ENTRIES);
    expect(loaded.conversation.at(-1)?.id).toBe(`m${MAX_TUI_CONVERSATION_ENTRIES + 24}`);
  });

  it("derives the latest completed assistant source after bounding loaded history", () => {
    const loaded = reduce(baseState(), {
      type: "session/load",
      sessionId: "session-source",
      title: "Source session",
      updatedAt: "2026-08-10T12:00:00.000Z",
      conversation: [
        { id: "trimmed", role: "assistant", source: "trimmed", streaming: false, createdAt: 0 },
        ...Array.from({ length: MAX_TUI_CONVERSATION_ENTRIES }, (_value, index) => ({
          id: `u${index}`,
          role: "user" as const,
          source: `question ${index}`,
          streaming: false,
          createdAt: 0,
        })),
        {
          id: "latest",
          role: "assistant" as const,
          source: "retained canonical source",
          streaming: false,
          createdAt: 0,
        },
        {
          id: "tool-tail",
          role: "tool" as const,
          source: "tool output",
          streaming: false,
          createdAt: 0,
        },
        {
          id: "stream-tail",
          role: "assistant" as const,
          source: "unfinished",
          streaming: true,
          createdAt: 0,
        },
      ],
    });
    expect(loaded.conversation).toHaveLength(MAX_TUI_CONVERSATION_ENTRIES);
    expect(loaded.conversation[0]?.id).toBe("u3");
    expect(loaded.conversation.at(-1)?.id).toBe("stream-tail");
    expect(loaded.latestAssistantSource).toBe("retained canonical source");
  });

  it("updates only the session title in place", () => {
    const state = reduce(baseState(), {
      type: "session/load",
      sessionId: "session-abc",
      title: "Original",
      updatedAt: "2026-08-10T12:00:00.000Z",
      conversation: [{ id: "u1", role: "user", source: "keep me", streaming: false, createdAt: 0 }],
    });
    const renamed = reduce(state, { type: "session/title", title: "Renamed" });
    expect(renamed.sessionTitle).toBe("Renamed");
    expect(renamed.sessionId).toBe("session-abc");
    expect(renamed.sessionUpdatedAt).toBe("2026-08-10T12:00:00.000Z");
    expect(renamed.conversation[0]?.source).toBe("keep me");
  });

  it("creates a new session that resets metadata and clears the conversation", () => {
    let state = reduce(baseState(), {
      type: "session/load",
      sessionId: "session-abc",
      title: "My research",
      updatedAt: "2026-08-10T12:00:00.000Z",
      conversation: [{ id: "u1", role: "user", source: "old", streaming: false, createdAt: 0 }],
    });
    state = reduce(state, { type: "session/create" });
    expect(state.sessionId).toBeUndefined();
    expect(state.sessionTitle).toBe("New session");
    expect(state.sessionUpdatedAt).toBeUndefined();
    expect(state.conversation).toEqual([]);
    expect(state.latestAssistantSource).toBeUndefined();
  });
});

describe("composer history and rendered-row scrolling", () => {
  it("recalls submitted entries with up and returns to the live draft with down", () => {
    let state = baseState();
    for (const value of ["first", "second"]) {
      state = reduce(state, { type: "composer/set", value, cursor: value.length });
      state = reduce(state, { type: "composer/submit" });
    }
    state = reduce(state, { type: "composer/set", value: "draft", cursor: 5 });
    state = reduce(state, { type: "composer/history-previous" });
    expect(state.composer.value).toBe("second");
    state = reduce(state, { type: "composer/history-previous" });
    expect(state.composer.value).toBe("first");
    state = reduce(state, { type: "composer/history-next" });
    expect(state.composer.value).toBe("second");
    state = reduce(state, { type: "composer/history-next" });
    expect(state.composer.value).toBe("draft");
  });

  it("bounds command history", () => {
    let state = baseState();
    for (let index = 0; index < MAX_COMMAND_HISTORY + 10; index += 1) {
      state = reduce(state, { type: "composer/set", value: `cmd${index}`, cursor: 0 });
      state = reduce(state, { type: "composer/submit" });
    }
    expect(state.composer.history).toHaveLength(MAX_COMMAND_HISTORY);
  });

  it("recalls the redacted history value supplied for a submitted prompt", () => {
    let state = reduce(baseState(), {
      type: "composer/set",
      value: "prompt synthetic-secret",
      cursor: "prompt synthetic-secret".length,
    });
    state = reduce(state, {
      type: "composer/submit",
      historyValue: "prompt [REDACTED]",
    });
    state = reduce(state, { type: "composer/history-previous" });
    expect(state.composer.value).toBe("prompt [REDACTED]");
    expect(state.composer.value).not.toContain("synthetic-secret");
  });

  it("clears stale model and catalog state while a provider is connecting", () => {
    const connection = {
      providerId: "compatible",
      baseUrl: "https://example.test/v1/",
      apiKeyEnvironmentVariable: "TEST_KEY",
      kind: "compatible" as const,
    };
    const start: AppState = {
      ...baseState(),
      connection,
      connectionStatus: "connected",
      catalog: [descriptor("compatible:old", ["high"])],
      model: "compatible:old",
      variant: "high",
    };
    const connecting = reduce(start, { type: "connection/connecting", connection });
    expect(connecting.connectionStatus).toBe("connecting");
    expect(connecting.model).toBeUndefined();
    expect(connecting.variant).toBe("auto");
    expect(connecting.catalog).toEqual([]);
    expect(connecting.catalogLoading).toBe(true);
  });

  it("initializes and normalizes the measured rendered-row range", () => {
    let state = baseState();
    expect(state.scrollOffset).toBe(0);
    expect(state.scrollMax).toBe(0);
    state = reduce(state, { type: "scroll/range", maxRows: 7.8 });
    expect(state.scrollMax).toBe(7);
    expect(state.scrollOffset).toBe(0);
    state = reduce(state, { type: "scroll/range", maxRows: Number.NaN });
    expect(state.scrollMax).toBe(0);
    state = reduce(state, { type: "scroll/range", maxRows: -10 });
    expect(state.scrollMax).toBe(0);
  });

  it("pages by rendered rows in both directions and clamps to the measured range", () => {
    let state = reduce(baseState(), { type: "scroll/range", maxRows: 8 });
    state = reduce(state, { type: "scroll/by", lines: 3 });
    expect(state.scrollOffset).toBe(3);
    state = reduce(state, { type: "scroll/by", lines: -1.8 });
    expect(state.scrollOffset).toBe(2);
    state = reduce(state, { type: "scroll/by", lines: Number.POSITIVE_INFINITY });
    expect(state.scrollOffset).toBe(2);
    state = reduce(state, { type: "scroll/by", lines: 500 });
    expect(state.scrollOffset).toBe(8);
    state = reduce(state, { type: "scroll/by", lines: -500 });
    expect(state.scrollOffset).toBe(0);
  });

  it("follows the tail and can jump to the oldest rendered row", () => {
    let state = reduce(baseState(), { type: "scroll/range", maxRows: 4 });
    state = reduce(state, { type: "scroll/oldest" });
    expect(state.scrollOffset).toBe(4);
    state = reduce(state, { type: "scroll/follow" });
    expect(state.scrollOffset).toBe(0);
  });

  it("keeps the same visible content anchored as the measured range changes", () => {
    let state = reduce(baseState(), { type: "scroll/range", maxRows: 10 });
    state = reduce(state, { type: "scroll/by", lines: 4 });
    state = reduce(state, { type: "scroll/range", maxRows: 16 });
    expect(state.scrollOffset).toBe(10);
    state = reduce(state, { type: "scroll/range", maxRows: 7 });
    expect(state.scrollOffset).toBe(1);
    state = reduce(state, { type: "scroll/range", maxRows: 20 });
    expect(state.scrollOffset).toBe(14);
    state = reduce(state, { type: "scroll/follow" });
    state = reduce(state, { type: "scroll/range", maxRows: 30 });
    expect(state.scrollOffset).toBe(0);
  });

  it("does not reset manual scroll for deltas, while a new entry follows the prompt", () => {
    let state = reduce(baseState(), { type: "scroll/range", maxRows: 12 });
    state = reduce(state, { type: "scroll/by", lines: 5 });
    state = reduce(state, {
      type: "conversation/append",
      entry: { id: "a1", role: "assistant", source: "partial", streaming: true, createdAt: 0 },
    });
    expect(state.scrollOffset).toBe(0);
    state = reduce(state, { type: "scroll/by", lines: 5 });
    state = reduce(state, { type: "conversation/append-delta", id: "a1", delta: " text" });
    expect(state.scrollOffset).toBe(5);
    state = reduce(state, {
      type: "conversation/append",
      entry: { id: "u1", role: "user", source: "new prompt", streaming: false, createdAt: 0 },
    });
    expect(state.scrollOffset).toBe(0);
  });

  it("lets measured geometry, rather than entry count, govern removal and resets clear paths", () => {
    let state = reduce(baseState(), { type: "scroll/range", maxRows: 12 });
    state = reduce(state, { type: "scroll/by", lines: 5 });
    state = reduce(state, {
      type: "conversation/append",
      entry: { id: "u1", role: "user", source: "prompt", streaming: false, createdAt: 0 },
    });
    state = reduce(state, { type: "scroll/by", lines: 5 });
    state = reduce(state, { type: "conversation/remove", id: "u1" });
    expect(state.scrollOffset).toBe(5);
    expect(state.scrollMax).toBe(12);

    state = reduce(state, { type: "conversation/clear" });
    expect(state.scrollOffset).toBe(0);
    expect(state.scrollMax).toBe(0);
    state = reduce(state, { type: "scroll/range", maxRows: 9 });
    state = reduce(state, {
      type: "session/load",
      sessionId: "s1",
      title: "Loaded",
      updatedAt: "2026-08-10T12:00:00.000Z",
      conversation: [],
    });
    expect(state.scrollOffset).toBe(0);
    expect(state.scrollMax).toBe(0);
    state = reduce(state, { type: "scroll/range", maxRows: 9 });
    state = reduce(state, { type: "session/create" });
    expect(state.scrollOffset).toBe(0);
    expect(state.scrollMax).toBe(0);
  });
});

describe("external activity and notices", () => {
  const catalogActivity = {
    kind: "catalog" as const,
    destination: "OpenRouter catalog",
    documentCount: 0,
  };

  it("sets and clears ephemeral external activity without changing contracts", () => {
    let state = reduce(baseState(), { type: "external/set", activity: catalogActivity });
    expect(state.externalActivity).toEqual(catalogActivity);
    state = reduce(state, { type: "external/clear" });
    expect(state.externalActivity).toBeUndefined();
  });

  it("clears catalog activity on connection/catalog completion and prompt activity on idle", () => {
    let state = reduce(baseState(), { type: "external/set", activity: catalogActivity });
    state = reduce(state, { type: "catalog/loaded", catalog: [] });
    expect(state.externalActivity).toBeUndefined();

    state = reduce(state, { type: "external/set", activity: catalogActivity });
    state = reduce(state, { type: "connection/failed", message: "unavailable" });
    expect(state.externalActivity).toBeUndefined();

    state = reduce(state, { type: "external/set", activity: catalogActivity });
    state = reduce(state, {
      type: "connection/connected",
      connection: {
        providerId: "openrouter",
        apiKeyEnvironmentVariable: "OPENROUTER_API_KEY",
        kind: "openrouter",
      },
      catalog: [],
      credentialValues: {},
    });
    expect(state.externalActivity).toBeUndefined();

    state = reduce(state, {
      type: "external/set",
      activity: { kind: "prompt", destination: "provider endpoint", documentCount: 2 },
    });
    state = reduce(state, { type: "run/status", status: "streaming" });
    expect(state.externalActivity?.kind).toBe("prompt");
    state = reduce(state, { type: "run/status", status: "idle" });
    expect(state.externalActivity).toBeUndefined();
  });

  it("clears all notices when a new attempt starts", () => {
    let state = reduce(baseState(), {
      type: "notice/push",
      notice: { id: "n1", level: "error", message: "try again", createdAt: 0 },
    });
    state = reduce(state, { type: "notice/clear" });
    expect(state.notices).toEqual([]);
  });
});

describe("content classification", () => {
  it("separates display math into its own block and preserves the source", () => {
    const blocks = classifyContent("Before $$x^2$$ after");
    const math = blocks.find((block) => block.kind === "display-math");
    expect(math).toBeDefined();
    expect(math?.kind === "display-math" ? math.source : "").toBe("$$x^2$$");
  });

  it("classifies inline math, code, headings, lists, quotes, and citations", () => {
    const blocks = classifyContent(
      ["# Title", "- item one", "> quoted", "text $a+b$ and `code` [12]"].join("\n"),
    );
    expect(blocks.some((block) => block.kind === "heading")).toBe(true);
    expect(blocks.some((block) => block.kind === "list-item")).toBe(true);
    expect(blocks.some((block) => block.kind === "quote")).toBe(true);
    const paragraph = blocks.find((block) => block.kind === "paragraph");
    const kinds =
      paragraph?.kind === "paragraph" ? paragraph.segments.map((segment) => segment.kind) : [];
    expect(kinds).toContain("inline-math");
    expect(kinds).toContain("code");
    expect(kinds).toContain("citation");
  });

  it("keeps fenced code content and language", () => {
    const blocks = classifyContent("```python\nprint(1)\n```");
    const code = blocks.find((block) => block.kind === "code-block");
    expect(code?.kind === "code-block" ? code.language : "").toBe("python");
    expect(code?.kind === "code-block" ? code.lines : []).toEqual(["print(1)"]);
  });

  it("never emits a terminal graphics or escape sequence", () => {
    const blocks = classifyContent(String.raw`\[E=mc^2\] and $$a$$ plus \(b\)`);
    const serialized = JSON.stringify(blocks);
    expect(serialized).not.toContain("\u001b");
    expect(serialized).not.toContain("1337;File=");
  });
});
