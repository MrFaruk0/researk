import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ModelDescriptor, RunEvent } from "@researk/contracts";
import { render } from "ink-testing-library";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CliHarness } from "../src/types.js";
import { App } from "../src/tui/App.js";
import { TuiController } from "../src/tui/controller.js";
import { createInitialState } from "../src/tui/state.js";
import { type Workspace, openWorkspace } from "../src/workspace.js";

const KEYS = {
  enter: "\r",
  escape: "\u001b",
  up: "\u001b[A",
  down: "\u001b[B",
  tab: "\t",
  shiftTab: "\u001b[Z",
  pageUp: "\u001b[5~",
  pageDown: "\u001b[6~",
  home: "\u001b[H",
  end: "\u001b[F",
  left: "\u001b[D",
  right: "\u001b[C",
  ctrlC: "\u0003",
  ctrlJ: "\n",
  backspace: "\u007f",
};

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupPaths.splice(0).map((value) => rm(value, { recursive: true, force: true })),
  );
});

function descriptor(modelId: string, intents: readonly string[] = []): ModelDescriptor {
  return {
    providerId: "compatible",
    modelId,
    canonicalId: `compatible:${modelId}`,
    displayName: modelId,
    revision: null,
    status: "available",
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

async function makeWorkspace(files: Record<string, string> = {}): Promise<Workspace> {
  const root = await mkdtemp(path.join(tmpdir(), "researk-tui-app-"));
  cleanupPaths.push(root);
  for (const [name, content] of Object.entries(files)) {
    await writeFile(path.join(root, name), content, "utf8");
  }
  return openWorkspace(root);
}

async function mount(
  options: Readonly<{
    harness?: CliHarness;
    catalog?: readonly ModelDescriptor[];
    files?: Record<string, string>;
    onExit?: () => void;
  }> = {},
) {
  const workspace = await makeWorkspace(options.files ?? {});
  const catalog = options.catalog ?? [descriptor("science", ["low", "high"])];
  const harness: CliHarness = options.harness ?? {
    async *run(): AsyncIterable<RunEvent> {
      // no events
    },
    async listModels() {
      return catalog;
    },
  };

  const controller = new TuiController({
    dependencies: { harness },
    env: { TEST_KEY: "synthetic-app-key" },
    workspace,
  });

  const instance = render(
    React.createElement(App, {
      controller,
      initialState: createInitialState({
        workspaceRoot: workspace.root,
        themeName: "dark",
        colorEnabled: false,
        variant: "auto",
      }),
      onExit: options.onExit ?? (() => {}),
    }),
  );

  const settle = async (): Promise<void> => {
    for (let index = 0; index < 6; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 12));
    }
  };

  const type = async (value: string): Promise<void> => {
    instance.stdin.write(value);
    await settle();
  };

  await settle();
  return { ...instance, controller, type, settle };
}

/** Completes the OpenAI-compatible provider form and connects. */
async function connectProvider(app: Awaited<ReturnType<typeof mount>>): Promise<void> {
  await app.type("/provider");
  await app.type(KEYS.enter);
  await app.type(KEYS.down);
  await app.type(KEYS.enter);
  await app.type("local");
  await app.type(KEYS.tab);
  await app.type("https://example.test/v1/");
  await app.type(KEYS.tab);
  await app.type("TEST_KEY");
  await app.type(KEYS.enter);
}

/** Connects and then selects the first catalog model, so prompts can actually be sent. */
async function connectAndSelectModel(app: Awaited<ReturnType<typeof mount>>): Promise<void> {
  await connectProvider(app);
  await app.type("/model");
  await app.type(KEYS.enter);
  await app.type(KEYS.enter);
}

describe("TUI shell", () => {
  it("renders header, footer and the no-provider guidance before any provider exists", async () => {
    const app = await mount();
    const frame = app.lastFrame() ?? "";
    expect(frame).toContain("Researk");
    expect(frame).toContain("/provider");
    expect(frame).toContain("no provider");
    expect(frame).toContain("workspace");
    app.unmount();
  });

  it("shows the workspace and idle status in the footer", async () => {
    const app = await mount();
    const frame = app.lastFrame() ?? "";
    expect(frame).toMatch(/ready/u);
    expect(frame).toMatch(/workspace/u);
    app.unmount();
  });

  it("lists slash commands while typing a slash and filters by prefix", async () => {
    const app = await mount();
    await app.type("/");
    const all = app.lastFrame() ?? "";
    for (const name of ["/provider", "/model", "/variant", "/themes", "/help", "/clear", "/exit"]) {
      expect(all).toContain(name);
    }
    await app.type("mod");
    const filtered = app.lastFrame() ?? "";
    expect(filtered).toContain("/model");
    expect(filtered).not.toContain("/themes");
    app.unmount();
  });

  it("opens the help overlay and documents the newline binding", async () => {
    const app = await mount();
    await app.type("/help");
    await app.type(KEYS.enter);
    const frame = app.lastFrame() ?? "";
    expect(frame).toMatch(/Ctrl\+J/u);
    expect(frame).toMatch(/Ctrl\+C/u);
    expect(frame).toMatch(/PageUp/iu);
    app.unmount();
  });

  it("closes an overlay with Escape", async () => {
    const app = await mount();
    await app.type("/help");
    await app.type(KEYS.enter);
    expect(app.lastFrame() ?? "").toMatch(/Keyboard/iu);
    await app.type(KEYS.escape);
    expect(app.lastFrame() ?? "").not.toMatch(/Keyboard/iu);
    app.unmount();
  });

  it("reports an unknown slash command in the UI instead of sending it", async () => {
    const app = await mount();
    await app.type("/nope");
    await app.type(KEYS.enter);
    expect(app.lastFrame() ?? "").toMatch(/Unknown command/iu);
    app.unmount();
  });
});

describe("TUI provider configuration", () => {
  it("offers only the two implemented adapters", async () => {
    const app = await mount();
    await app.type("/provider");
    await app.type(KEYS.enter);
    const frame = app.lastFrame() ?? "";
    expect(frame).toMatch(/OpenRouter/u);
    expect(frame).toMatch(/OpenAI-compatible/u);
    expect(frame).not.toMatch(/Anthropic/u);
    app.unmount();
  });

  it("masks the API key inside the in-TUI form", async () => {
    const app = await mount();
    await app.type("/provider");
    await app.type(KEYS.enter);
    await app.type(KEYS.enter);
    // OpenRouter fields are base URL, environment reference, then the secret key.
    await app.type(KEYS.tab);
    await app.type(KEYS.tab);
    await app.type("supersecretvalue");
    const frame = app.lastFrame() ?? "";
    expect(frame).not.toContain("supersecretvalue");
    expect(frame).toContain("\u2022".repeat(16));
    app.unmount();
  });

  it("prefills the OpenRouter default base URL and moves focus with Tab and Shift+Tab", async () => {
    const app = await mount();
    await app.type("/provider");
    await app.type(KEYS.enter);
    await app.type(KEYS.enter);
    expect(app.lastFrame() ?? "").toContain("openrouter.ai");
    await app.type(KEYS.tab);
    await app.type("XX");
    await app.type(KEYS.shiftTab);
    await app.type(KEYS.backspace);
    expect(app.lastFrame() ?? "").toContain("XX");
    app.unmount();
  });

  it("discloses provider network activity in the form", async () => {
    const app = await mount();
    await app.type("/provider");
    await app.type(KEYS.enter);
    await app.type(KEYS.enter);
    expect(app.lastFrame() ?? "").toMatch(/Network: connecting will contact/u);
    app.unmount();
  });

  it("rejects an OpenAI-compatible provider with no base URL and keeps the form open", async () => {
    const app = await mount();
    await app.type("/provider");
    await app.type(KEYS.enter);
    await app.type(KEYS.down);
    await app.type(KEYS.enter);
    // Fill only the provider ID so the missing base URL is the rejection cause.
    await app.type("local-vllm");
    await app.type(KEYS.enter);
    const frame = app.lastFrame() ?? "";
    expect(frame).toMatch(/requires a base URL/u);
    expect(frame).toMatch(/Base URL/u);
    app.unmount();
  });

  it("connects and shows provider and model in the footer", async () => {
    const app = await mount();
    await connectAndSelectModel(app);
    const frame = app.lastFrame() ?? "";
    expect(frame).toContain("local");
    expect(frame).toContain("compatible:science");
    expect(frame).not.toContain("no provider");
    app.unmount();
  });

  it("never renders an entered credential after connecting", async () => {
    const app = await mount();
    await app.type("/provider");
    await app.type(KEYS.enter);
    await app.type(KEYS.down);
    await app.type(KEYS.enter);
    await app.type("local");
    await app.type(KEYS.tab);
    await app.type("https://example.test/v1/");
    await app.type(KEYS.tab);
    await app.type(KEYS.tab);
    await app.type("literal-secret-value");
    await app.type(KEYS.enter);
    const frames = app.frames.join("\n");
    expect(frames).not.toContain("literal-secret-value");
    app.unmount();
  });
});

describe("TUI model, variant and theme overlays", () => {
  it("filters the live catalog by search text", async () => {
    const app = await mount({
      catalog: [descriptor("alpha-model"), descriptor("beta-model")],
    });
    await connectProvider(app);
    await app.type("/model");
    await app.type(KEYS.enter);
    expect(app.lastFrame() ?? "").toContain("beta-model");
    await app.type("alpha");
    const frame = app.lastFrame() ?? "";
    expect(frame).toContain("alpha-model");
    expect(frame).not.toContain("beta-model");
    app.unmount();
  });

  it("selects a model with arrow keys and Enter", async () => {
    const app = await mount({
      catalog: [descriptor("alpha-model"), descriptor("beta-model")],
    });
    await connectProvider(app);
    await app.type("/model");
    await app.type(KEYS.enter);
    await app.type(KEYS.down);
    await app.type(KEYS.enter);
    expect(app.lastFrame() ?? "").toContain("compatible:beta-model");
    app.unmount();
  });

  it("lists only the variants the selected model advertises", async () => {
    const app = await mount({ catalog: [descriptor("science", ["low", "high"])] });
    await connectAndSelectModel(app);
    await app.type("/variant");
    await app.type(KEYS.enter);
    const frame = app.lastFrame() ?? "";
    expect(frame).toContain("auto");
    expect(frame).toContain("low");
    expect(frame).toContain("high");
    expect(frame).not.toContain("minimal");
    app.unmount();
  });

  it("explains when the selected model advertises no reasoning variants", async () => {
    const app = await mount({ catalog: [descriptor("plain", [])] });
    await connectAndSelectModel(app);
    await app.type("/variant");
    await app.type(KEYS.enter);
    expect(app.lastFrame() ?? "").toMatch(/advertised by compatible:plain/u);
    app.unmount();
  });

  it("applies a selected variant to the footer", async () => {
    const app = await mount({ catalog: [descriptor("science", ["low", "high"])] });
    await connectAndSelectModel(app);
    await app.type("/variant");
    await app.type(KEYS.enter);
    await app.type(KEYS.down);
    await app.type(KEYS.enter);
    expect(app.lastFrame() ?? "").toMatch(/low/u);
    app.unmount();
  });

  it("lists themes and applies the selected theme immediately", async () => {
    const app = await mount();
    await app.type("/themes");
    await app.type(KEYS.enter);
    const list = app.lastFrame() ?? "";
    expect(list).toMatch(/Theme/u);
    for (const name of ["system", "dark", "light", "high-contrast", "mono"]) {
      expect(list).toContain(name);
    }
    // Moving the selection applies the theme immediately, so the marker follows the cursor.
    await app.type(KEYS.down);
    expect(app.lastFrame() ?? "").toMatch(/light\s+applied/u);
    await app.type(KEYS.enter);
    expect(app.lastFrame() ?? "").not.toMatch(/Up\/Down preview/u);
    app.unmount();
  });
});

describe("TUI conversation, streaming and cancellation", () => {
  it("streams assistant text into one entry and keeps canonical LaTeX", async () => {
    const latex = String.raw`See \[\frac{a}{b}\] now`;
    const harness: CliHarness = {
      async *run(): AsyncIterable<RunEvent> {
        for (const [index, delta] of [latex.slice(0, 6), latex.slice(6)].entries()) {
          yield {
            schemaVersion: 1,
            runId: "r",
            sequence: index,
            timestamp: "2026-08-08T00:00:00.000Z",
            type: "text_delta",
            delta,
          } as RunEvent;
        }
      },
      async listModels() {
        return [descriptor("science")];
      },
    };

    const app = await mount({ harness });
    await connectAndSelectModel(app);
    await app.type("Explain");
    await app.type(KEYS.enter);
    await app.settle();

    const frame = app.lastFrame() ?? "";
    expect(frame).toContain("Explain");
    expect(frame).toContain(String.raw`\frac{a}{b}`);
    await app.type("/source");
    await app.type(KEYS.enter);
    expect(app.lastFrame() ?? "").toContain(latex);
    app.unmount();
  });

  it("renders a provider error inside the TUI with no stack trace", async () => {
    const harness: CliHarness = {
      async *run(): AsyncIterable<RunEvent> {
        yield {
          schemaVersion: 1,
          runId: "r",
          sequence: 0,
          timestamp: "2026-08-08T00:00:00.000Z",
          type: "error",
          error: { code: "provider_error", message: "upstream refused", retryable: false },
        } as RunEvent;
      },
      async listModels() {
        return [descriptor("science")];
      },
    };

    const app = await mount({ harness });
    await connectAndSelectModel(app);
    await app.type("Explain");
    await app.type(KEYS.enter);
    await app.settle();
    const frame = app.lastFrame() ?? "";
    expect(frame).toContain("upstream refused");
    expect(frame).not.toContain("at Object.");
    expect(frame).not.toMatch(/\.ts:\d+:\d+/u);
    app.unmount();
  });

  it("cancels an active run with Ctrl+C and stays mounted", async () => {
    let observedSignal: AbortSignal | undefined;
    const harness: CliHarness = {
      async *run(_request, options): AsyncIterable<RunEvent> {
        const signal = (options as { signal?: AbortSignal }).signal;
        observedSignal = signal;
        await new Promise<void>((resolve) => {
          signal?.addEventListener("abort", () => resolve());
          setTimeout(resolve, 2000);
        });
        yield {
          schemaVersion: 1,
          runId: "r",
          sequence: 0,
          timestamp: "2026-08-08T00:00:00.000Z",
          type: "cancelled",
        } as RunEvent;
      },
      async listModels() {
        return [descriptor("science")];
      },
    };

    const exit = vi.fn();
    const app = await mount({ harness, onExit: exit });
    await connectAndSelectModel(app);
    await app.type("Explain");
    await app.type(KEYS.enter);
    await app.settle();
    await app.type(KEYS.ctrlC);
    await app.settle();

    // The run is aborted, the app remains mounted, and the status returns to idle.
    expect(observedSignal?.aborted).toBe(true);
    expect(exit).not.toHaveBeenCalled();
    expect(app.lastFrame() ?? "").toMatch(/Cancelled/u);
    expect(app.lastFrame() ?? "").toMatch(/ready/u);
    app.unmount();
  });

  it("exits on Ctrl+C when idle", async () => {
    const exit = vi.fn();
    const app = await mount({ onExit: exit });
    await app.type(KEYS.ctrlC);
    expect(exit).toHaveBeenCalledTimes(1);
    app.unmount();
  });

  it("exits on /exit", async () => {
    const exit = vi.fn();
    const app = await mount({ onExit: exit });
    await app.type("/exit");
    await app.type(KEYS.enter);
    expect(exit).toHaveBeenCalledTimes(1);
    app.unmount();
  });

  it("clears the conversation with /clear", async () => {
    const app = await mount();
    await connectAndSelectModel(app);
    await app.type("remember this line");
    await app.type(KEYS.enter);
    await app.settle();
    expect(app.lastFrame() ?? "").toContain("remember this line");
    await app.type("/clear");
    await app.type(KEYS.enter);
    expect(app.lastFrame() ?? "").not.toContain("remember this line");
    app.unmount();
  });

  it("refuses to send a prompt before a provider is configured", async () => {
    const app = await mount();
    await app.type("hello");
    await app.type(KEYS.enter);
    expect(app.lastFrame() ?? "").toMatch(/\/provider/u);
    app.unmount();
  });

  it("inserts a newline with Ctrl+J instead of submitting", async () => {
    const app = await mount();
    await connectAndSelectModel(app);
    await app.type("first");
    await app.type(KEYS.ctrlJ);
    await app.type("second");
    const frame = app.lastFrame() ?? "";
    expect(frame).toContain("first");
    expect(frame).toContain("second");
    app.unmount();
  });

  it("recalls the previous prompt with the up arrow", async () => {
    const app = await mount();
    await connectAndSelectModel(app);
    await app.type("earlier prompt");
    await app.type(KEYS.enter);
    await app.settle();
    await app.type(KEYS.up);
    expect(app.lastFrame() ?? "").toContain("earlier prompt");
    app.unmount();
  });

  it("scrolls back with PageUp and resumes following with PageDown", async () => {
    const app = await mount();
    await connectAndSelectModel(app);
    for (const value of ["one", "two", "three", "four", "five", "six", "seven", "eight"]) {
      await app.type(value);
      await app.type(KEYS.enter);
    }
    await app.settle();
    await app.type(KEYS.pageUp);
    // Scrolling away from the live tail surfaces the newer-message indicator.
    expect(app.lastFrame() ?? "").toMatch(/newer message\(s\)/u);
    await app.type(KEYS.pageDown);
    await app.type(KEYS.pageDown);
    expect(app.lastFrame() ?? "").not.toMatch(/newer message\(s\)/u);
    app.unmount();
  });

  it("keeps the oldest message visible when PageUp is held past the transcript", async () => {
    const app = await mount();
    await connectAndSelectModel(app);
    for (const value of ["alpha", "beta", "gamma"]) {
      await app.type(value);
      await app.type(KEYS.enter);
    }
    await app.settle();
    // Far more PageUps than there are retained entries.
    for (let index = 0; index < 30; index += 1) await app.type(KEYS.pageUp);
    const frame = app.lastFrame() ?? "";
    // Scrollback is clamped, so the transcript never becomes an empty region that also claims
    // nothing is hidden above it.
    expect(frame).toContain("alpha");
    expect(frame).toMatch(/newer message\(s\)/u);
    app.unmount();
    // Thirty simulated keypresses each settle real timers, so this needs more than the 5s default.
  }, 20_000);

  it("draws the composer cursor at the actual cursor offset", async () => {
    const app = await mount();
    await app.type("abc");
    expect(app.lastFrame() ?? "").toContain("abc\u2588");
    await app.type(KEYS.left);
    // Left arrow must move the visible block, not just the internal offset.
    expect(app.lastFrame() ?? "").toContain("ab\u2588c");
    await app.type(KEYS.right);
    expect(app.lastFrame() ?? "").toContain("abc\u2588");
    app.unmount();
  });
});

describe("TUI workspace reading", () => {
  it("stages a workspace document with /read and shows it in the footer", async () => {
    const app = await mount({ files: { "paper.tex": String.raw`\section{Method}` } });
    await connectAndSelectModel(app);
    await app.type("/read paper.tex");
    await app.type(KEYS.enter);
    await app.settle();
    const frame = app.lastFrame() ?? "";
    expect(frame).toContain("paper.tex");
    app.unmount();
  });

  it("reports a traversal attempt as a TUI error", async () => {
    const app = await mount();
    await connectAndSelectModel(app);
    await app.type("/read ../escape.md");
    await app.type(KEYS.enter);
    await app.settle();
    expect(app.lastFrame() ?? "").toMatch(/traversal|outside/iu);
    app.unmount();
  });

  it("neutralizes terminal escapes contained in a workspace document", async () => {
    const app = await mount({ files: { "evil.md": "safe \u001b]0;title\u0007 text" } });
    await connectAndSelectModel(app);
    await app.type("/read evil.md");
    await app.type(KEYS.enter);
    await app.settle();
    expect(app.lastFrame() ?? "").not.toContain("\u001b]0;");
    app.unmount();
  });
});

describe("TUI run lifecycle", () => {
  /** Mounts an already-connected app whose runs block until the returned gate is released. */
  async function mountGated() {
    const workspace = await makeWorkspace();
    let starts = 0;
    const aborted: boolean[] = [];
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const harness: CliHarness = {
      async *run(_request, options): AsyncIterable<RunEvent> {
        const index = starts;
        starts += 1;
        aborted[index] = false;
        options?.signal?.addEventListener("abort", () => {
          aborted[index] = true;
        });
        await gate;
      },
      async listModels() {
        return [descriptor("science")];
      },
    };
    const controller = new TuiController({ dependencies: { harness }, env: {}, workspace });
    const instance = render(
      React.createElement(App, {
        controller,
        initialState: createInitialState({
          workspaceRoot: workspace.root,
          themeName: "dark",
          colorEnabled: false,
          connection: {
            providerId: "compatible",
            baseUrl: "https://example.test/v1/",
            apiKeyEnvironmentVariable: "TEST_KEY",
            kind: "compatible",
          },
          model: "compatible:science",
          variant: "auto",
        }),
        onExit: () => {},
      }),
    );
    const settle = async (): Promise<void> => {
      for (let index = 0; index < 6; index += 1) {
        await new Promise((resolve) => setTimeout(resolve, 12));
      }
    };
    const type = async (value: string): Promise<void> => {
      instance.stdin.write(value);
      await settle();
    };
    await settle();
    return {
      ...instance,
      type,
      settle,
      runCount: () => starts,
      aborted: () => [...aborted],
      release: () => release?.(),
    };
  }

  it("refuses to start a second run while one is still streaming", async () => {
    const app = await mountGated();
    await app.type("first");
    await app.type(KEYS.enter);
    expect(app.runCount()).toBe(1);

    await app.type("second");
    await app.type(KEYS.enter);
    // A second Harness run would overwrite the single active-run slot and orphan the first,
    // leaving it beyond the reach of Ctrl+C.
    expect(app.runCount()).toBe(1);
    expect(app.lastFrame() ?? "").toMatch(/still streaming/iu);

    app.release();
    await app.settle();
    app.unmount();
  });

  it("cancels the one in-flight run with Ctrl+C", async () => {
    const app = await mountGated();
    await app.type("first");
    await app.type(KEYS.enter);
    await app.type("second");
    await app.type(KEYS.enter);
    await app.type(KEYS.ctrlC);

    // The single started run is the one that actually receives the abort.
    expect(app.runCount()).toBe(1);
    expect(app.aborted()).toEqual([true]);

    app.release();
    await app.settle();
    app.unmount();
  });

  it("still accepts slash commands while a run is streaming", async () => {
    const app = await mountGated();
    await app.type("first");
    await app.type(KEYS.enter);
    await app.type("/help");
    await app.type(KEYS.enter);
    // Commands never start a run, so they stay available during streaming.
    expect(app.lastFrame() ?? "").toMatch(/Keyboard|Keys/iu);
    app.release();
    await app.settle();
    app.unmount();
  });
});

describe("TUI command discovery", () => {
  it("opens the browsable command overlay with /commands", async () => {
    const app = await mount();
    await app.type("/commands");
    await app.type(KEYS.enter);
    const frame = app.lastFrame() ?? "";
    expect(frame).toMatch(/Commands/u);
    expect(frame).toContain("/provider");
    expect(frame).toMatch(/Enter run/u);
    app.unmount();
  });

  it("runs the highlighted command from the overlay", async () => {
    const app = await mount();
    await app.type("/commands");
    await app.type(KEYS.enter);
    // The first entry is /provider, so Enter opens the provider picker.
    await app.type(KEYS.enter);
    expect(app.lastFrame() ?? "").toMatch(/Connect a provider/iu);
    app.unmount();
  });

  it("lists /commands in discovery and in the help overlay", async () => {
    const app = await mount();
    await app.type("/comm");
    expect(app.lastFrame() ?? "").toContain("/commands");
    await app.type(KEYS.escape);
    app.unmount();
  });
});

describe("TUI pre-stream run failures", () => {
  /**
   * Mounts a connected app whose Harness construction fails, which is the exact shape of the
   * defect: `runChat` had failure-prone setup before its `try`, so a rejection escaped into an
   * `await` the component assumed always resolved.
   */
  async function mountFailingSetup(
    failure: () => Promise<never> | never,
    options: Readonly<{ env?: Record<string, string> }> = {},
  ) {
    const workspace = await makeWorkspace();
    const controller = new TuiController({
      dependencies: { createHarness: failure },
      env: options.env ?? {},
      workspace,
    });
    const instance = render(
      React.createElement(App, {
        controller,
        initialState: createInitialState({
          workspaceRoot: workspace.root,
          themeName: "dark",
          colorEnabled: false,
          connection: {
            providerId: "compatible",
            baseUrl: "https://example.test/v1/",
            apiKeyEnvironmentVariable: "TEST_KEY",
            kind: "compatible",
          },
          model: "compatible:science",
          variant: "auto",
        }),
        onExit: () => {},
      }),
    );
    const settle = async (): Promise<void> => {
      for (let index = 0; index < 6; index += 1) {
        await new Promise((resolve) => setTimeout(resolve, 12));
      }
    };
    const type = async (value: string): Promise<void> => {
      instance.stdin.write(value);
      await settle();
    };
    await settle();
    return { ...instance, type, settle };
  }

  it("returns to idle and reports the failure when createHarness rejects", async () => {
    const app = await mountFailingSetup(() => Promise.reject(new Error("provider unreachable")));
    await app.type("Explain");
    await app.type(KEYS.enter);
    await app.settle();

    const frame = app.lastFrame() ?? "";
    // The failure is visible in the TUI rather than silently swallowed by the alternate screen.
    expect(frame).toContain("provider unreachable");
    // Status returned to idle, so the composer is usable again instead of permanently disabled.
    expect(frame).toMatch(/ready/u);
    expect(frame).not.toMatch(/Streaming\u2026/u);
    app.unmount();
  });

  it("removes the streaming placeholder when a run fails before any text", async () => {
    const app = await mountFailingSetup(() => Promise.reject(new Error("provider unreachable")));
    await app.type("Explain");
    await app.type(KEYS.enter);
    await app.settle();

    const frame = app.lastFrame() ?? "";
    // The prompt is kept, but no empty assistant bubble is left behind claiming a silent answer.
    expect(frame).toContain("Explain");
    expect(frame).not.toMatch(/researk\s+\u2026/u);
    app.unmount();
  });

  it("stays usable after a pre-stream failure and accepts the next action", async () => {
    const app = await mountFailingSetup(() => Promise.reject(new Error("provider unreachable")));
    await app.type("Explain");
    await app.type(KEYS.enter);
    await app.settle();

    // The run-ownership slot was released, so a following prompt is not refused as "still
    // streaming" and a following command still routes normally.
    await app.type("second attempt");
    await app.type(KEYS.enter);
    await app.settle();
    expect(app.lastFrame() ?? "").not.toMatch(/still streaming/iu);

    await app.type("/help");
    await app.type(KEYS.enter);
    expect(app.lastFrame() ?? "").toMatch(/Keys/iu);
    app.unmount();
  });

  it("exits on Ctrl+C after a pre-stream failure instead of trying to cancel", async () => {
    const exit = vi.fn();
    const workspace = await makeWorkspace();
    const controller = new TuiController({
      dependencies: { createHarness: () => Promise.reject(new Error("provider unreachable")) },
      env: {},
      workspace,
    });
    const instance = render(
      React.createElement(App, {
        controller,
        initialState: createInitialState({
          workspaceRoot: workspace.root,
          themeName: "dark",
          colorEnabled: false,
          connection: {
            providerId: "compatible",
            baseUrl: "https://example.test/v1/",
            apiKeyEnvironmentVariable: "TEST_KEY",
            kind: "compatible",
          },
          model: "compatible:science",
          variant: "auto",
        }),
        onExit: exit,
      }),
    );
    const settle = async (): Promise<void> => {
      for (let index = 0; index < 6; index += 1) {
        await new Promise((resolve) => setTimeout(resolve, 12));
      }
    };
    await settle();
    instance.stdin.write("Explain");
    await settle();
    instance.stdin.write(KEYS.enter);
    await settle();

    // A stranded `activeRun` would make Ctrl+C abort a dead run forever instead of exiting.
    instance.stdin.write(KEYS.ctrlC);
    await settle();
    expect(exit).toHaveBeenCalledTimes(1);
    instance.unmount();
  });

  it("redacts a credential that appears in a pre-stream failure", async () => {
    const secret = "synthetic-setup-failure-key-64";
    const app = await mountFailingSetup(() => Promise.reject(new Error(`refused key ${secret}`)), {
      env: { TEST_KEY: secret },
    });
    await app.type("Explain");
    await app.type(KEYS.enter);
    await app.settle();

    const frames = app.frames.join("\n");
    expect(frames).not.toContain(secret);
    expect(app.lastFrame() ?? "").toContain("[REDACTED]");
    app.unmount();
  });

  it("keeps a partial response when a run fails after some text arrived", async () => {
    const harness: CliHarness = {
      async *run(): AsyncIterable<RunEvent> {
        yield {
          schemaVersion: 1,
          runId: "r",
          sequence: 0,
          timestamp: "2026-08-08T00:00:00.000Z",
          type: "text_delta",
          delta: "partial answer",
        } as RunEvent;
        throw new Error("stream died");
      },
      async listModels() {
        return [descriptor("science")];
      },
    };
    const app = await mount({ harness });
    await connectAndSelectModel(app);
    await app.type("Explain");
    await app.type(KEYS.enter);
    await app.settle();

    const frame = app.lastFrame() ?? "";
    // Text that did arrive is real content and is finished rather than discarded.
    expect(frame).toContain("partial answer");
    expect(frame).toContain("stream died");
    expect(frame).toMatch(/ready/u);
    app.unmount();
  });
});

describe("TUI canonical source overlay", () => {
  /** Streams one assistant response and returns the mounted app showing it. */
  async function mountWithResponse(text: string) {
    const harness: CliHarness = {
      async *run(): AsyncIterable<RunEvent> {
        yield {
          schemaVersion: 1,
          runId: "r",
          sequence: 0,
          timestamp: "2026-08-08T00:00:00.000Z",
          type: "text_delta",
          delta: text,
        } as RunEvent;
      },
      async listModels() {
        return [descriptor("science")];
      },
    };
    const app = await mount({ harness });
    await connectAndSelectModel(app);
    await app.type("Explain");
    await app.type(KEYS.enter);
    await app.settle();
    return app;
  }

  /** A response long enough to require paging, with identifiable first and final lines. */
  function longSource(lineCount: number): string {
    return Array.from({ length: lineCount }, (_value, index) =>
      index === lineCount - 1 ? "FINAL-LINE-MARKER" : `line-${index + 1}`,
    ).join("\n");
  }

  /** The overlay's own report of which lines it is showing, e.g. `lines 49-52 of 260`. */
  function sourceRange(frame: string): string | undefined {
    return /lines \d+\u2013\d+ of \d+/u.exec(frame)?.[0];
  }

  /**
   * Presses PageDown until the reported range stops changing, and returns how many pages moved.
   *
   * The page size comes from the rendered region rather than a constant, so this is the only way to
   * assert reachability without hardcoding a height. The bound is a safety net against a
   * non-advancing regression, not an expected count: it fails as an assertion rather than hanging.
   */
  async function pageToEnd(app: Awaited<ReturnType<typeof mount>>): Promise<number> {
    let previous = sourceRange(app.lastFrame() ?? "");
    for (let pages = 1; pages <= 300; pages += 1) {
      await app.type(KEYS.pageDown);
      const current = sourceRange(app.lastFrame() ?? "");
      if (current === previous) return pages - 1;
      previous = current;
    }
    throw new Error("PageDown never settled on a final page");
  }

  it("reports the visible range and total for a response longer than one page", async () => {
    const app = await mountWithResponse(longSource(260));
    await app.type("/source");
    await app.type(KEYS.enter);
    const frame = app.lastFrame() ?? "";
    // The overlay states exactly what is shown, so truncation is never implied to be the whole.
    expect(frame).toMatch(/lines 1\u2013\d+ of 260/u);
    expect(frame).toContain("line-1");
    app.unmount();
  });

  it("reaches the final line of a >200-line response with End", async () => {
    const app = await mountWithResponse(longSource(260));
    await app.type("/source");
    await app.type(KEYS.enter);
    // The previous overlay hard-truncated at 200 lines, so line 260 was unreachable entirely.
    expect(app.lastFrame() ?? "").not.toContain("FINAL-LINE-MARKER");
    await app.type(KEYS.end);
    const frame = app.lastFrame() ?? "";
    expect(frame).toContain("FINAL-LINE-MARKER");
    expect(frame).toMatch(/of 260/u);
    expect(frame).toMatch(/end/u);
    app.unmount();
  });

  it("reaches the final line by paging with PageDown", async () => {
    const app = await mountWithResponse(longSource(260));
    await app.type("/source");
    await app.type(KEYS.enter);
    expect(app.lastFrame() ?? "").not.toContain("FINAL-LINE-MARKER");
    // The page size is derived from the terminal region, so a fixed press count would prove
    // nothing about reachability. Paging until the reported range stops advancing is the real
    // invariant: every press moves the window, and the sequence terminates only at the last page.
    const pages = await pageToEnd(app);
    // More than one page was genuinely traversed, so this is paging rather than a single jump.
    expect(pages).toBeGreaterThan(1);
    const frame = app.lastFrame() ?? "";
    expect(frame).toContain("FINAL-LINE-MARKER");
    expect(frame).toMatch(/of 260/u);
    expect(frame).toMatch(/end/u);
    app.unmount();
    // Each simulated keypress settles real timers, so paging the whole source needs more than the
    // 5s default.
  }, 120_000);

  it("moves by single lines and returns to the top with Home", async () => {
    const app = await mountWithResponse(longSource(260));
    await app.type("/source");
    await app.type(KEYS.enter);
    await app.type(KEYS.down);
    await app.type(KEYS.down);
    expect(app.lastFrame() ?? "").toMatch(/lines 3\u2013/u);
    await app.type(KEYS.up);
    expect(app.lastFrame() ?? "").toMatch(/lines 2\u2013/u);
    await app.type(KEYS.home);
    expect(app.lastFrame() ?? "").toMatch(/lines 1\u2013/u);
    app.unmount();
  });

  it("clamps paging at both ends so the view never runs off the source", async () => {
    const app = await mountWithResponse(longSource(260));
    await app.type("/source");
    await app.type(KEYS.enter);
    // Far more upward movement than there is source above the first line.
    for (let index = 0; index < 10; index += 1) await app.type(KEYS.up);
    expect(app.lastFrame() ?? "").toMatch(/lines 1\u2013/u);
    // And past the end, which must settle on the last page rather than blanking the view. Extra
    // presses after the range stops advancing prove the clamp holds rather than wrapping.
    await pageToEnd(app);
    const settled = app.lastFrame() ?? "";
    await app.type(KEYS.pageDown);
    await app.type(KEYS.pageDown);
    const frame = app.lastFrame() ?? "";
    expect(sourceRange(frame)).toBe(sourceRange(settled));
    expect(frame).toContain("FINAL-LINE-MARKER");
    expect(frame).toMatch(/of 260/u);
    app.unmount();
  }, 120_000);

  it("shows a short response without paging affordances", async () => {
    const app = await mountWithResponse("only one line");
    await app.type("/source");
    await app.type(KEYS.enter);
    const frame = app.lastFrame() ?? "";
    expect(frame).toContain("only one line");
    expect(frame).toMatch(/lines 1\u20131 of 1/u);
    expect(frame).toContain("Esc close");
    app.unmount();
  });

  it("preserves canonical LaTeX exactly in a long paged response", async () => {
    const latex = String.raw`\[\frac{\alpha}{\beta}\]`;
    const lines = Array.from({ length: 240 }, (_value, index) => `line-${index + 1}`);
    lines[239] = latex;
    const app = await mountWithResponse(lines.join("\n"));
    await app.type("/source");
    await app.type(KEYS.enter);
    await app.type(KEYS.end);
    // Paging changes only which lines are shown, never their bytes.
    expect(app.lastFrame() ?? "").toContain(latex);
    app.unmount();
  });

  it("never renders an active control sequence from the source overlay", async () => {
    const app = await mountWithResponse(`before\u001b]0;pwned\u0007\u0001after`);
    await app.type("/source");
    await app.type(KEYS.enter);
    const frame = app.lastFrame() ?? "";
    // The projection is applied at the rendering boundary, so the escape is visible, not active.
    expect(frame).toContain("\\u{001b}");
    expect(frame).not.toContain("\u001b]0;");
    app.unmount();
  });

  it("neutralizes a bare carriage return so a response cannot overwrite a drawn line", async () => {
    const app = await mountWithResponse("SAFE-PREFIX\rSPOOFED");
    await app.type("/source");
    await app.type(KEYS.enter);
    const frame = app.lastFrame() ?? "";

    // A carriage return returns the cursor to column zero, so `SPOOFED` would overwrite
    // `SAFE-PREFIX` and the user would be shown text the response never actually stood behind.
    // Neutralizing it at the rendering boundary keeps both halves visible and inert.
    expect(frame).not.toContain("\r");
    expect(frame).toContain("SAFE-PREFIX");
    expect(frame).toContain("SPOOFED");
    expect(frame).toContain("\\u{000d}");
    // The projection is display-only: the canonical bytes are still what `/source` pages over, so
    // both halves remain retained and reachable rather than collapsed into the spoofed line.
    expect(frame).toContain("SAFE-PREFIX\\u{000d}SPOOFED");
    expect(app.frames.every((value) => !value.includes("\r"))).toBe(true);
    app.unmount();
  });

  it("keeps newlines and tabs as layout while neutralizing carriage returns", async () => {
    const app = await mountWithResponse("alpha\r\nbeta\tgamma\rdelta");
    await app.type("/source");
    await app.type(KEYS.enter);
    const frame = app.lastFrame() ?? "";

    // `\r\n` is a line ending, so it stays a line break rather than becoming a visible escape, and
    // the tab still separates cells. Only the cursor-repositioning carriage return is escaped.
    expect(frame).not.toContain("\r");
    // `alpha` and `beta` land on separate lines because the CRLF stayed a line ending.
    expect(frame).toMatch(/of 2/u);
    expect(frame).toContain("alpha");
    expect(frame).toContain("beta\tgamma\\u{000d}");
    app.unmount();
  });

  it("never reveals a credential through the source overlay", async () => {
    const secret = "synthetic-source-overlay-key-99";
    const harness: CliHarness = {
      async *run(): AsyncIterable<RunEvent> {
        yield {
          schemaVersion: 1,
          runId: "r",
          sequence: 0,
          timestamp: "2026-08-08T00:00:00.000Z",
          type: "text_delta",
          delta: `the key is ${secret} exactly`,
        } as RunEvent;
      },
      async listModels() {
        return [descriptor("science")];
      },
    };
    const app = await mount({ harness });
    await connectAndSelectModel(app);
    await app.type("Explain");
    await app.type(KEYS.enter);
    await app.settle();
    await app.type("/source");
    await app.type(KEYS.enter);

    // The env credential is redacted before it is ever retained, so the overlay cannot reveal it.
    const frame = app.lastFrame() ?? "";
    expect(frame).not.toContain("synthetic-app-key");
    expect(app.frames.join("\n")).not.toContain("synthetic-app-key");
    app.unmount();
  });

  it("closes with Escape and reopens at the top", async () => {
    const app = await mountWithResponse(longSource(260));
    await app.type("/source");
    await app.type(KEYS.enter);
    await app.type(KEYS.end);
    expect(app.lastFrame() ?? "").toContain("FINAL-LINE-MARKER");
    await app.type(KEYS.escape);
    expect(app.lastFrame() ?? "").not.toMatch(/Canonical source/u);
    await app.type("/source");
    await app.type(KEYS.enter);
    expect(app.lastFrame() ?? "").toMatch(/lines 1\u2013/u);
    app.unmount();
  });
});

describe("TUI canonical source retention", () => {
  it("retains the user's own LaTeX unchanged rather than a neutralized rewrite", async () => {
    const app = await mount();
    await connectAndSelectModel(app);
    const prompt = String.raw`Check \[\sum_{i=1}^{n} x_i\] please`;
    await app.type(prompt);
    await app.type(KEYS.enter);
    await app.settle();
    // The composer stores what was typed, so a researcher's LaTeX is not silently transformed.
    expect(app.lastFrame() ?? "").toContain(String.raw`\sum_{i=1}^{n} x_i`);
    app.unmount();
  });

  it("never renders an active control sequence typed into the composer", async () => {
    const app = await mount({ files: { "evil.md": "x" } });
    await connectAndSelectModel(app);
    await app.type("before");
    await app.type(KEYS.enter);
    await app.settle();
    const frames = app.frames.join("\n");
    // Composer input is filtered to printable text, and anything retained is projected on render.
    expect(frames).not.toContain("\u001b]0;");
    app.unmount();
  });
});

/**
 * The three source-and-safety obligations interact, so they are asserted together on one response
 * rather than only in isolation. ADR 0006 requires canonical Markdown and LaTeX to survive for a
 * future export, while the threat model forbids retaining a credential and forbids an active
 * terminal control reaching the terminal. A fix for any one of them that broke another - escaping
 * at the canonical boundary, redacting only whole chunks, or rendering `source` directly - would
 * pass the isolated tests and fail here.
 */
describe("TUI source and safety invariants combined", () => {
  const SECRET = "synthetic-combined-invariant-key-5c31";
  const LATEX = String.raw`\[\frac{\alpha}{\beta_{1}} \\ \sum_{i=1}^{n} x_i\]`;
  const INLINE = "$E=mc^2$";

  /**
   * One response carrying ordinary LaTeX, a credential deliberately split so no single chunk
   * contains it, and raw terminal control bytes. The split points are inside the secret, which is
   * exactly the case a per-chunk redactor reconstructs on screen.
   */
  function combinedHarness(): CliHarness {
    const chunks = [
      `Result ${LATEX} with `,
      `key=${SECRET.slice(0, 12)}`,
      `${SECRET.slice(12, 26)}`,
      `${SECRET.slice(26)} and \u001b]0;pwned\u0007`,
      `\u0001 tail ${INLINE}`,
    ];
    return {
      async *run(): AsyncIterable<RunEvent> {
        for (const [index, delta] of chunks.entries()) {
          yield {
            schemaVersion: 1,
            runId: "r",
            sequence: index,
            timestamp: "2026-08-08T00:00:00.000Z",
            type: "text_delta",
            delta,
          } as RunEvent;
        }
      },
      async listModels() {
        return [descriptor("science")];
      },
    };
  }

  /** Mounts with the credential configured as the referenced environment value and streams once. */
  async function mountCombined() {
    const workspace = await makeWorkspace();
    const controller = new TuiController({
      dependencies: { harness: combinedHarness() },
      env: { TEST_KEY: SECRET },
      workspace,
    });
    const instance = render(
      React.createElement(App, {
        controller,
        initialState: createInitialState({
          workspaceRoot: workspace.root,
          themeName: "dark",
          colorEnabled: false,
          connection: {
            providerId: "compatible",
            baseUrl: "https://example.test/v1/",
            apiKeyEnvironmentVariable: "TEST_KEY",
            kind: "compatible",
          },
          model: "compatible:science",
          variant: "auto",
        }),
        onExit: () => {},
      }),
    );
    const settle = async (): Promise<void> => {
      for (let index = 0; index < 6; index += 1) {
        await new Promise((resolve) => setTimeout(resolve, 12));
      }
    };
    const type = async (value: string): Promise<void> => {
      instance.stdin.write(value);
      await settle();
    };
    await settle();
    await type("Explain");
    await type(KEYS.enter);
    await settle();
    return { ...instance, type, settle };
  }

  it("keeps exact LaTeX, drops the split secret, and leaves controls inert in one response", async () => {
    const app = await mountCombined();
    await app.type("/source");
    await app.type(KEYS.enter);
    const frame = app.lastFrame() ?? "";
    const frames = app.frames.join("\n");

    // Canonical: every backslash, brace, subscript, and delimiter survives byte-for-byte, so the
    // LaTeX a researcher would copy or export is exactly what the model produced.
    expect(frame).toContain(LATEX);
    expect(frame).toContain(INLINE);

    // Retention: the credential is never in a retained frame, in any intermediate frame, or in a
    // partial form long enough to be useful, even though no single chunk contained it.
    expect(frames).not.toContain(SECRET);
    expect(frames).not.toContain(SECRET.slice(0, 26));
    expect(frames).not.toContain(SECRET.slice(12));
    expect(frame).toContain("key=[REDACTED]");

    // Inert: the OSC title sequence and the bare C0 byte are visible escapes, so nothing can
    // retitle the window, move the cursor, or corrupt Ink's retained frame.
    expect(frames).not.toContain("\u001b]0;");
    expect(frames).not.toContain("\u0007");
    expect(frame).toContain("\\u{001b}]0;pwned\\u{0007}");
    expect(frame).toContain("\\u{0001}");
    app.unmount();
  });

  it("applies the same three invariants to the conversation view, not only to /source", async () => {
    const app = await mountCombined();
    // The conversation is the default view, so the projection must hold there too; `/source` is
    // not the only path a response reaches the terminal by.
    const frame = app.lastFrame() ?? "";
    expect(frame).not.toContain(SECRET);
    expect(frame).not.toContain("\u001b]0;");
    expect(frame).toContain("[REDACTED]");
    app.unmount();
  });
});
