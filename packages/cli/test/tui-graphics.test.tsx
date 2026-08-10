import { EventEmitter } from "node:events";
import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import { FormulaRasterCache, type FormulaRasterRenderer } from "../src/tui/formula-renderer.js";
import {
  FormulaGraphic,
  type FormulaGraphicsMetrics,
  FormulaGraphicsRuntime,
} from "../src/tui/graphics.js";

class FakeStdout extends EventEmitter {
  readonly writes: string[] = [];
  blocked = false;

  write(chunk: string): boolean {
    this.writes.push(chunk);
    return !this.blocked;
  }
}

function raster(width = 20, height = 20) {
  return {
    height,
    pixels: new Uint8Array(width * height * 4),
    png: Uint8Array.from([0x89, 0x50, 0x4e, 0x47]),
    width,
  };
}

function setup(
  protocol: "kitty" | "sixel",
  metrics: FormulaGraphicsMetrics = { height: 1, width: 2, x: 1, y: 1 },
  extra: Readonly<Record<string, unknown>> = {},
) {
  const stdout = new FakeStdout();
  const renderer: FormulaRasterRenderer = async () => raster();
  const cache = new FormulaRasterCache(renderer);
  const ref = {} as Parameters<NonNullable<FormulaGraphicsRuntime["register"]>>[0];
  const runtime = new FormulaGraphicsRuntime({
    cache,
    capability: { protocol, ...extra },
    measure: () => metrics,
    rows: 10,
    stdout,
    columns: 20,
  });
  return { ref, runtime, stdout };
}

describe("FormulaGraphicsRuntime", () => {
  it("keeps unsupported formula output source-only and neutralizes controls", () => {
    const stdout = new FakeStdout();
    const runtime = new FormulaGraphicsRuntime({
      capability: { protocol: "unsupported" },
      stdout,
    });
    const { lastFrame } = render(
      <FormulaGraphic
        exactSource={"$x\u001b]2;spoof\u0007$"}
        formulaKey="safe-key"
        innerTex="x"
        runtime={runtime}
      />,
    );
    expect(lastFrame()).toContain("\\u{001b}");
    expect(stdout.writes).toEqual([]);
    runtime.dispose();
  });

  it("measures bounded Kitty slots, emits numeric metadata, and cleans old IDs first", async () => {
    const { ref, runtime, stdout } = setup("kitty");
    const formula = raster();
    expect(
      runtime.register({
        key: "entry:0",
        metrics: { height: 1, width: 2, x: 1, y: 1 },
        raster: formula,
        ref,
      }),
    ).toBe(true);

    const first = runtime.beforeFrame(20, 10);
    await runtime.afterFrame(first);
    expect(stdout.writes.join("")).toContain("\u001b[2;2H");
    expect(stdout.writes.join("")).toContain("c=2,r=1,C=1");
    expect(stdout.writes.join("")).not.toContain("entry:0");

    const writesBefore = stdout.writes.length;
    const second = runtime.beforeFrame(20, 10);
    expect(stdout.writes.length).toBeGreaterThan(writesBefore);
    expect(stdout.writes[writesBefore]).toContain("a=d,d=I,i=1");
    await runtime.afterFrame(second);
    runtime.dispose();
  });

  it("rejects clipped and bottom-row formulas without emitting graphics", async () => {
    const { ref, runtime, stdout } = setup("kitty");
    expect(
      runtime.register({
        key: "bottom",
        metrics: { height: 1, width: 2, x: 1, y: 9 },
        raster: raster(),
        ref,
      }),
    ).toBe(true);
    const generation = runtime.beforeFrame(20, 10);
    await runtime.afterFrame(generation);
    expect(runtime.isVisible("bottom")).toBe(false);
    expect(stdout.writes).toEqual([]);
    runtime.dispose();
  });

  it("requires proven cell metrics for Sixel and emits DECSDM/CUP/DCS", async () => {
    const { ref, runtime, stdout } = setup("sixel", undefined, {
      cellPixels: { height: 20, width: 10 },
    });
    expect(
      runtime.register({
        key: "sixel",
        metrics: { height: 1, width: 2, x: 1, y: 1 },
        raster: raster(),
        ref,
      }),
    ).toBe(true);
    const generation = runtime.beforeFrame(20, 10);
    await runtime.afterFrame(generation);
    const output = stdout.writes.join("");
    expect(output).toContain("\u001b[?80l");
    expect(output).toContain("\u001b[2;2H");
    expect(output).toContain("\u001bP0;1q");
    expect(output).not.toContain("\u001b[?80h");
    expect(output.indexOf("\u001b[?80l")).toBeLessThan(output.indexOf("\u001b[2;2H"));
    expect(output.lastIndexOf("\u001b[?80l")).toBeGreaterThan(output.indexOf("\u001b\\"));
    runtime.dispose();
  });

  it("clears a Sixel rectangle row-by-row synchronously before the next image", async () => {
    const { ref, runtime, stdout } = setup(
      "sixel",
      { height: 2, width: 2, x: 1, y: 1 },
      { cellPixels: { height: 20, width: 10 } },
    );
    expect(
      runtime.register({
        key: "sixel-rectangle",
        metrics: { height: 2, width: 2, x: 1, y: 1 },
        raster: raster(20, 40),
        ref,
      }),
    ).toBe(true);
    const first = runtime.beforeFrame(20, 10);
    await runtime.afterFrame(first);
    const image = stdout.writes.at(-1);
    expect(image).toContain("\u001bP0;1q");

    const writesBeforeCleanup = stdout.writes.length;
    const second = runtime.beforeFrame(20, 10);
    expect(stdout.writes.length).toBe(writesBeforeCleanup + 1);
    const cleanup = stdout.writes[writesBeforeCleanup];
    expect(cleanup).toBe("\u001b[s\u001b[2;2H  \u001b[3;2H  \u001b[u");
    await runtime.afterFrame(second);
    expect(stdout.writes.length).toBe(writesBeforeCleanup + 2);
    expect(stdout.writes.at(-1)).toContain("\u001bP0;1q");
    runtime.dispose();
  });

  it("writes disposal cleanup before returning and fails closed on cleanup errors", async () => {
    const { ref, runtime, stdout } = setup("kitty");
    expect(
      runtime.register({
        key: "dispose",
        metrics: { height: 1, width: 2, x: 1, y: 1 },
        raster: raster(),
        ref,
      }),
    ).toBe(true);
    const generation = runtime.beforeFrame(20, 10);
    await runtime.afterFrame(generation);
    const writesBeforeDispose = stdout.writes.length;
    runtime.dispose();
    expect(stdout.writes.length).toBe(writesBeforeDispose + 1);
    expect(stdout.writes.at(-1)).toContain("a=d,d=I,i=1");

    const failing = new FakeStdout();
    failing.write = (): boolean => {
      throw new Error("closed");
    };
    const failedRuntime = new FormulaGraphicsRuntime({
      capability: { protocol: "kitty" },
      stdout: failing,
      columns: 20,
      rows: 10,
    });
    expect(
      failedRuntime.register({
        key: "failed",
        metrics: { height: 1, width: 2, x: 1, y: 1 },
        raster: raster(),
        ref: {} as Parameters<NonNullable<FormulaGraphicsRuntime["register"]>>[0],
      }),
    ).toBe(true);
    const failedGeneration = failedRuntime.beforeFrame(20, 10);
    await failedRuntime.afterFrame(failedGeneration);
    expect(() => failedRuntime.dispose()).not.toThrow();
  });

  it.each(["kitty", "sixel"] as const)(
    "tracks a blocked %s placement before drain and cleans it before resize redraw",
    async (protocol) => {
      const extra = protocol === "sixel" ? { cellPixels: { height: 20, width: 10 } } : {};
      const { ref, runtime, stdout } = setup(protocol, { height: 1, width: 2, x: 1, y: 1 }, extra);
      stdout.blocked = true;
      expect(
        runtime.register({
          key: "blocked",
          metrics: { height: 1, width: 2, x: 1, y: 1 },
          raster: raster(),
          ref,
        }),
      ).toBe(true);

      const first = runtime.beforeFrame(20, 10);
      const pending = runtime.afterFrame(first);
      await Promise.resolve();
      expect(stdout.writes.length).toBe(1);

      const second = runtime.beforeFrame(24, 10);
      expect(stdout.writes.length).toBe(2);
      expect(stdout.writes[1]).toContain(protocol === "kitty" ? "a=d,d=I,i=1" : "\u001b[s");

      stdout.blocked = false;
      stdout.emit("drain");
      await pending;
      await runtime.afterFrame(second);
      expect(stdout.writes.length).toBe(3);
      runtime.dispose();
    },
  );

  it("tracks a blocked placement through dispose and never emits a stale redraw", async () => {
    const { ref, runtime, stdout } = setup("kitty");
    stdout.blocked = true;
    expect(
      runtime.register({
        key: "dispose-blocked",
        metrics: { height: 1, width: 2, x: 1, y: 1 },
        raster: raster(),
        ref,
      }),
    ).toBe(true);
    const generation = runtime.beforeFrame(20, 10);
    const pending = runtime.afterFrame(generation);
    await Promise.resolve();
    expect(stdout.writes.length).toBe(1);
    runtime.dispose();
    expect(stdout.writes.length).toBe(2);
    expect(stdout.writes[1]).toContain("a=d,d=I,i=1");
    stdout.blocked = false;
    stdout.emit("drain");
    await pending;
    expect(stdout.writes.length).toBe(2);
  });

  it("marks formulas visible only after successful placement and keeps later failures as source", async () => {
    const { ref, runtime, stdout } = setup("kitty");
    const badRef = {} as Parameters<NonNullable<FormulaGraphicsRuntime["register"]>>[0];
    expect(
      runtime.register({
        key: "good",
        metrics: { height: 1, width: 2, x: 1, y: 1 },
        raster: raster(),
        ref,
      }),
    ).toBe(true);
    expect(
      runtime.register({
        key: "bad",
        metrics: { height: 1, width: 2, x: 5, y: 1 },
        raster: { ...raster(), png: new Uint8Array() },
        ref: badRef,
      }),
    ).toBe(true);
    const generation = runtime.beforeFrame(20, 10);
    expect(runtime.isVisible("good")).toBe(false);
    expect(runtime.isVisible("bad")).toBe(false);
    await runtime.afterFrame(generation);
    expect(runtime.isVisible("good")).toBe(true);
    expect(runtime.isVisible("bad")).toBe(false);
    expect(stdout.writes.length).toBe(1);
    runtime.dispose();
  });

  it("keeps all formulas source-fallback on a stale generation, then redraws the current one", async () => {
    const { ref, runtime, stdout } = setup("kitty");
    stdout.blocked = true;
    expect(
      runtime.register({
        key: "first",
        metrics: { height: 1, width: 2, x: 1, y: 1 },
        raster: raster(),
        ref,
      }),
    ).toBe(true);
    expect(
      runtime.register({
        key: "later",
        metrics: { height: 1, width: 2, x: 5, y: 1 },
        raster: raster(),
        ref: {} as Parameters<NonNullable<FormulaGraphicsRuntime["register"]>>[0],
      }),
    ).toBe(true);
    const stale = runtime.afterFrame(runtime.beforeFrame(20, 10));
    const current = runtime.beforeFrame(24, 10);
    expect(runtime.isVisible("first")).toBe(false);
    expect(runtime.isVisible("later")).toBe(false);
    stdout.blocked = false;
    stdout.emit("drain");
    await stale;
    await runtime.afterFrame(current);
    expect(runtime.isVisible("first")).toBe(true);
    expect(runtime.isVisible("later")).toBe(true);
    runtime.dispose();
  });

  it.each([
    undefined,
    { height: 0, width: 2, x: 1, y: 1 },
    { height: 1, width: 0, x: 1, y: 1 },
    { height: 1, width: 2, x: -1, y: 1 },
    { height: 1, width: 2, x: Number.NaN, y: 1 },
  ])("rejects invalid measured metrics without placing at origin (%j)", async (metrics) => {
    const stdout = new FakeStdout();
    const runtime = new FormulaGraphicsRuntime({
      capability: { protocol: "kitty" },
      measure: () => metrics,
      stdout,
      columns: 20,
      rows: 10,
    });
    expect(
      runtime.register({
        key: "invalid-metrics",
        raster: raster(),
        ref: {} as Parameters<NonNullable<FormulaGraphicsRuntime["register"]>>[0],
      }),
    ).toBe(true);
    const generation = runtime.beforeFrame(20, 10);
    await runtime.afterFrame(generation);
    expect(runtime.isVisible("invalid-metrics")).toBe(false);
    expect(stdout.writes).toEqual([]);
    runtime.dispose();
  });

  it("keeps an exact source fully readable while a successful raster is pending placement", async () => {
    const stdout = new FakeStdout();
    const source = `$${"x".repeat(80)}$`;
    const cache = new FormulaRasterCache(vi.fn<FormulaRasterRenderer>(async () => raster()));
    const runtime = new FormulaGraphicsRuntime({
      cache,
      capability: { protocol: "kitty" },
      stdout,
      columns: 20,
      rows: 10,
    });
    const view = render(
      <FormulaGraphic exactSource={source} formulaKey="pending" innerTex="x" runtime={runtime} />,
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(view.lastFrame()).toContain(source);
    runtime.dispose();
    view.unmount();
  });
});
