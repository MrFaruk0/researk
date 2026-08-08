import type { ModelDescriptor } from "@researk/contracts";
import { describe, expect, it } from "vitest";
import {
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
import { createTuiTheme, themeColor, TUI_THEME_TOKENS, tuiThemeNames } from "../src/tui/theme.js";

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
  it("resolves every documented token for every theme", () => {
    for (const name of tuiThemeNames()) {
      const theme = createTuiTheme(name, { colorEnabled: true });
      for (const token of TUI_THEME_TOKENS) {
        if (token === "background") continue;
        expect(themeColor(theme, token), `${name}.${token}`).toBeTypeOf("string");
      }
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

describe("composer history and scrolling", () => {
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

  it("never scrolls past the newest message and can resume following", () => {
    // Scrollback is bounded by the retained transcript, so an empty conversation has nothing to
    // scroll back through.
    let state = reduce(baseState(), { type: "scroll/by", lines: 3 });
    expect(state.scrollOffset).toBe(0);

    // With four retained entries, at most three can be scrolled away from the newest.
    let populated = baseState();
    for (const id of ["a", "b", "c", "d"]) {
      populated = reduce(populated, {
        type: "conversation/append",
        entry: { id, role: "user", source: id, streaming: false, createdAt: 0 },
      });
    }
    state = reduce(populated, { type: "scroll/by", lines: 3 });
    expect(state.scrollOffset).toBe(3);
    state = reduce(state, { type: "scroll/by", lines: -10 });
    expect(state.scrollOffset).toBe(0);
    state = reduce(state, { type: "scroll/by", lines: 2 });
    state = reduce(state, { type: "scroll/follow" });
    expect(state.scrollOffset).toBe(0);
  });

  it("clamps scrollback so the oldest retained message stays reachable", () => {
    let state = baseState();
    for (const id of ["a", "b", "c"]) {
      state = reduce(state, {
        type: "conversation/append",
        entry: { id, role: "user", source: id, streaming: false, createdAt: 0 },
      });
    }
    state = reduce(state, { type: "scroll/by", lines: 500 });
    // Without the clamp the offset would run far past the transcript and blank the view.
    expect(state.scrollOffset).toBe(2);
  });

  it("returns to following when a new message arrives", () => {
    let state = reduce(baseState(), { type: "scroll/by", lines: 4 });
    state = reduce(state, {
      type: "conversation/append",
      entry: { id: "u1", role: "user", source: "hi", streaming: false, createdAt: 0 },
    });
    expect(state.scrollOffset).toBe(0);
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
