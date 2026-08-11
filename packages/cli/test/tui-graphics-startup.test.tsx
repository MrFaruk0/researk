import { Console } from "node:console";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { useApp } from "ink";
import React, { useEffect, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseArguments } from "../src/args.js";
import type { FormulaGraphicsRuntime } from "../src/tui/graphics.js";
import { startTui } from "../src/tui.js";
import type { CliDependencies, CliIo } from "../src/types.js";

const formulaCacheMock = vi.hoisted(() => {
  const store = {
    delete: vi.fn(async () => undefined),
    get: vi.fn(async () => undefined),
    set: vi.fn(async () => undefined),
  };
  return {
    createUserFormulaRasterStore: vi.fn(() => store),
    store,
  };
});

vi.mock("../src/config/formula-cache.js", () => ({
  createUserFormulaRasterStore: formulaCacheMock.createUserFormulaRasterStore,
}));

function raster() {
  return {
    height: 20,
    pixels: new Uint8Array(20 * 20 * 4),
    png: Uint8Array.from([0x89, 0x50, 0x4e, 0x47]),
    width: 20,
  };
}

vi.mock("@researk/latex-renderer", () => ({
  closeManagedLatexRenderer: vi.fn(async () => undefined),
  latexRendererVersion: "test-latex-renderer",
  normalizeLatexRenderStyle: (style: {
    readonly background?: string;
    readonly dpi?: number;
    readonly fontScale?: number;
    readonly foreground?: string;
  }) => ({
    ...(style.background === undefined ? {} : { background: style.background }),
    dpi: style.dpi ?? 96,
    fontScale: style.fontScale ?? 1,
    foreground: style.foreground ?? "#f5f5f5",
  }),
  renderTexToPng: vi.fn(async () => raster()),
}));

vi.mock("../src/config/paths.js", () => ({
  ensureDataDirs: vi.fn(async () => {
    throw new Error("persistence disabled for lifecycle test");
  }),
}));

vi.mock("../src/rendering/terminal-query.js", () => ({
  probeTerminalCapability: vi.fn(async () => ({
    cellPixels: { height: 20, width: 10 },
    protocol: "kitty",
  })),
}));

vi.mock("../src/tui/App.js", async () => {
  const { FormulaGraphic } = await import("../src/tui/graphics.js");

  function LifecycleApp(props: { readonly graphicsRuntime?: FormulaGraphicsRuntime }) {
    const { exit } = useApp();
    const runtime = props.graphicsRuntime;
    const [visible, setVisible] = useState(false);

    useEffect(() => {
      if (runtime === undefined) return undefined;
      return runtime.subscribe(() => setVisible(runtime.isVisible("lifecycle")));
    }, [runtime]);

    useEffect(() => {
      if (visible) {
        const timeout = setTimeout(exit, 20);
        return () => clearTimeout(timeout);
      }
      const timeout = setTimeout(exit, 1_000);
      return () => clearTimeout(timeout);
    }, [exit, visible]);

    if (runtime === undefined) return null;
    return React.createElement(FormulaGraphic, {
      exactSource: "$x$",
      formulaKey: "lifecycle",
      innerTex: "x",
      runtime,
    });
  }

  return { App: LifecycleApp };
});

class TtyOutput extends PassThrough {
  readonly isTTY = true;
  readonly columns = 20;
  readonly rows = 10;
}

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupPaths.splice(0).map((value) => rm(value, { force: true, recursive: true })),
  );
});

describe("startTui graphics lifecycle", () => {
  it("places a raster registered after the current Ink snapshot without input", async () => {
    (console as unknown as { Console: typeof Console }).Console = Console;
    const cwd = await mkdtemp(path.join(tmpdir(), "researk-tui-graphics-lifecycle-"));
    cleanupPaths.push(cwd);

    const stdin = new PassThrough();
    const stdout = new TtyOutput();
    const stderr = new PassThrough();
    const writes: string[] = [];
    stdout.on("data", (chunk: Buffer | string) => writes.push(chunk.toString()));
    const io: CliIo = { isTTY: true, stderr, stdin, stdout };
    const dependencies: CliDependencies = {
      cwd,
      harness: {
        async *run() {},
        async listModels() {
          return [];
        },
      },
    };
    const env = { TERM: "xterm-256color" };

    const result = await startTui(parseArguments([], env), dependencies, io, env);
    expect(result).toBe(0);
    const output = writes.join("");
    const placements = output.match(/a=T/gu) ?? [];
    expect(placements.length).toBeGreaterThan(0);
    expect(placements.length).toBeLessThanOrEqual(2);
  });

  it("passes the per-user formula store to the retained graphics cache", async () => {
    formulaCacheMock.createUserFormulaRasterStore.mockClear();
    formulaCacheMock.store.set.mockClear();
    (console as unknown as { Console: typeof Console }).Console = Console;
    const cwd = await mkdtemp(path.join(tmpdir(), "researk-tui-graphics-cache-"));
    cleanupPaths.push(cwd);

    const stdin = new PassThrough();
    const stdout = new TtyOutput();
    const stderr = new PassThrough();
    const io: CliIo = { isTTY: true, stderr, stdin, stdout };
    const dependencies: CliDependencies = {
      cwd,
      harness: {
        async *run() {},
        async listModels() {
          return [];
        },
      },
    };
    const env = { APPDATA: path.join(cwd, "user-data"), TERM: "xterm-256color" };

    const result = await startTui(parseArguments([], env), dependencies, io, env);

    expect(result).toBe(0);
    expect(formulaCacheMock.createUserFormulaRasterStore).toHaveBeenCalledWith({ env });
    expect(formulaCacheMock.store.set).toHaveBeenCalled();
  });
});
