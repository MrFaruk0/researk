import { EventEmitter } from "node:events";
import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import { createTerminalCapabilities } from "../src/rendering/capabilities.js";
import { FormulaRasterCache, type FormulaRasterRenderer } from "../src/tui/formula-renderer.js";
import {
  FormulaGraphic,
  type FormulaGraphicsCapability,
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
  const pixels = new Uint8Array(width * height * 4);
  // Sixel P2=1 leaves zero-alpha pixels unset, so fixtures that exercise placement need at least
  // one visible source pixel rather than relying on the former opaque background plane.
  for (let offset = 3; offset < pixels.length; offset += 4) pixels[offset] = 255;
  return {
    height,
    pixels,
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
    capability: {
      protocol,
      ...(protocol === "kitty" ? { cellPixels: { height: 20, width: 10 } } : {}),
      ...extra,
    },
    measure: () => metrics,
    rows: 10,
    stdout,
    columns: 20,
  });
  return { ref, runtime, stdout };
}

describe("FormulaGraphicsRuntime", () => {
  it("uses central capability selection and fails closed for accessible output", () => {
    const runtime = new FormulaGraphicsRuntime({
      capability: createTerminalCapabilities(
        { protocol: "kitty", reason: "probe" },
        { accessible: true, isTTY: true, interactive: true },
      ),
      stdout: new FakeStdout(),
    });
    expect(runtime.rendererId).toBe("exact-source");
    expect(runtime.supportsGraphics()).toBe(false);
    runtime.dispose();
  });

  it("keeps iTerm2 exact-source in the live overlay until a placement seam exists", () => {
    const runtime = new FormulaGraphicsRuntime({
      capability: { cellPixels: { height: 20, width: 10 }, protocol: "iterm2" },
      stdout: new FakeStdout(),
    });
    expect(runtime.rendererId).toBe("iterm2");
    expect(runtime.supportsGraphics()).toBe(false);
    runtime.dispose();
  });

  it("updates validated style without remounting and separates cache pixels", async () => {
    const styles: Array<unknown> = [];
    const renderer: FormulaRasterRenderer = async (request) => {
      styles.push(request.style);
      return raster();
    };
    const runtime = new FormulaGraphicsRuntime({
      capability: { cellPixels: { height: 20, width: 10 }, protocol: "kitty" },
      renderer,
      stdout: new FakeStdout(),
    });

    await expect(runtime.renderFormula({ display: true, tex: "x" })).resolves.toMatchObject({
      ok: true,
    });
    const revision = runtime.styleRevision;
    expect(runtime.setStyle({ foreground: "#ffffff", fontScale: 1, dpi: 96 })).toBe(true);
    expect(runtime.styleRevision).toBe(revision + 1);
    await expect(runtime.renderFormula({ display: true, tex: "x" })).resolves.toMatchObject({
      ok: true,
    });
    expect(styles).toHaveLength(2);
    expect(styles[0]).not.toEqual(styles[1]);
    runtime.dispose();
  });

  it("rerenders a mounted formula when the runtime style changes", async () => {
    const styles: Array<unknown> = [];
    const runtime = new FormulaGraphicsRuntime({
      capability: { cellPixels: { height: 20, width: 10 }, protocol: "kitty" },
      renderer: async (request) => {
        styles.push(request.style);
        return raster();
      },
      stdout: new FakeStdout(),
    });
    const view = render(
      <FormulaGraphic exactSource="$x$" formulaKey="style-change" innerTex="x" runtime={runtime} />,
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(styles).toHaveLength(1);

    expect(runtime.setStyle({ dpi: 144, foreground: "#ffffff" })).toBe(true);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(styles).toHaveLength(2);
    expect(styles[0]).not.toEqual(styles[1]);

    view.unmount();
    runtime.dispose();
  });

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

  it.each([
    undefined,
    { height: 20, width: 0 },
    { height: 20, width: Number.NaN },
    { height: Number.POSITIVE_INFINITY, width: 10 },
    { height: 20, width: -1 },
  ])("requires measured Kitty cell pixels for graphics (%j)", (cellPixels) => {
    const stdout = new FakeStdout();
    const runtime = new FormulaGraphicsRuntime({
      capability: {
        ...(cellPixels === undefined ? {} : { cellPixels }),
        protocol: "kitty",
      } as FormulaGraphicsCapability,
      stdout,
    });
    const source = "$x$";
    const view = render(
      <FormulaGraphic
        exactSource={source}
        formulaKey="kitty-metrics"
        innerTex="x"
        runtime={runtime}
      />,
    );
    expect(runtime.supportsGraphics()).toBe(false);
    expect(view.lastFrame()).toContain(source);
    expect(stdout.writes).toEqual([]);
    view.unmount();
    runtime.dispose();
  });

  it("measures bounded Kitty slots and replaces an old ID before cleaning it", async () => {
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
    // The confirmed image remains visible until its replacement is accepted.
    expect(stdout.writes.length).toBe(writesBefore);
    await runtime.afterFrame(second);
    expect(stdout.writes.length).toBe(writesBefore + 2);
    expect(stdout.writes[writesBefore]).toContain("a=T");
    expect(stdout.writes[writesBefore + 1]).toContain("a=d,d=I,i=1");
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

  it("checks the complete raster cell footprint at clip boundaries", async () => {
    const { ref, runtime, stdout } = setup("kitty");
    expect(
      runtime.register({
        clipMetrics: { height: 3, width: 4, x: 0, y: 0 },
        key: "footprint-outside",
        // The source box ends exactly at the right clip edge, but the 2-cell raster does not.
        metrics: { height: 1, width: 1, x: 3, y: 2 },
        raster: raster(),
        ref,
      }),
    ).toBe(true);
    expect(
      runtime.register({
        clipMetrics: { height: 3, width: 4, x: 0, y: 0 },
        key: "footprint-edge",
        // The full 2x1-cell reservation ends exactly on both clip edges and is eligible.
        metrics: { height: 1, width: 1, x: 2, y: 2 },
        raster: raster(),
        ref: {} as Parameters<NonNullable<FormulaGraphicsRuntime["register"]>>[0],
      }),
    ).toBe(true);
    expect(
      runtime.register({
        clipMetrics: { height: 4, width: 4, x: 0, y: 0 },
        key: "footprint-outside-vertical",
        // A one-row source box fits, while this two-row raster crosses the clip bottom edge.
        metrics: { height: 1, width: 1, x: 2, y: 3 },
        raster: raster(20, 40),
        ref: {} as Parameters<NonNullable<FormulaGraphicsRuntime["register"]>>[0],
      }),
    ).toBe(true);

    const generation = runtime.beforeFrame(20, 10);
    await runtime.afterFrame(generation);
    expect(runtime.isVisible("footprint-outside")).toBe(false);
    expect(runtime.isVisible("footprint-outside-vertical")).toBe(false);
    expect(runtime.isVisible("footprint-edge")).toBe(true);
    expect(stdout.writes).toHaveLength(1);
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
    // An omitted semantic style leaves the Sixel background unknown; the runtime must not invent
    // the former dark canvas or draw a white plane behind the visible raster.
    expect(output).toContain("#0;2;2;2;2");
    expect(output).not.toContain("#0;2;12;13;17");
    expect(output).not.toContain("\u001b[?80h");
    expect(output.indexOf("\u001b[?80l")).toBeLessThan(output.indexOf("\u001b[2;2H"));
    expect(output.lastIndexOf("\u001b[?80l")).toBeGreaterThan(output.indexOf("\u001b\\"));
    runtime.dispose();
  });

  it("orders a Sixel clear and replacement in one write", async () => {
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
    expect(stdout.writes.length).toBe(writesBeforeCleanup);
    await runtime.afterFrame(second);
    expect(stdout.writes.length).toBe(writesBeforeCleanup + 1);
    const replacement = stdout.writes.at(-1) ?? "";
    expect(replacement).toContain("\u001b[s\u001b[2;2H  \u001b[3;2H  \u001b[u");
    expect(replacement.indexOf("\u001b[s")).toBeLessThan(replacement.indexOf("\u001bP0;1q"));
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
      capability: { cellPixels: { height: 20, width: 10 }, protocol: "kitty" },
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
    "retains a blocked %s placement until drain and then redraws safely",
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
      expect(stdout.writes.length).toBe(1);

      stdout.blocked = false;
      stdout.emit("drain");
      await pending;
      await runtime.afterFrame(second);
      expect(stdout.writes.length).toBe(protocol === "kitty" ? 3 : 2);
      if (protocol === "kitty") {
        expect(stdout.writes[1]).toContain("a=T");
        expect(stdout.writes[2]).toContain("a=d,d=I,i=1");
      } else {
        expect(stdout.writes[1]?.indexOf("\u001bP0;1q")).toBeGreaterThan(0);
      }
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
      capability: { cellPixels: { height: 20, width: 10 }, protocol: "kitty" },
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
      capability: { cellPixels: { height: 20, width: 10 }, protocol: "kitty" },
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

  it("keeps the confirmed graphic while a replacement is blocked, then drains it safely", async () => {
    const stdout = new FakeStdout();
    const runtime = new FormulaGraphicsRuntime({
      capability: { cellPixels: { height: 20, width: 10 }, protocol: "kitty" },
      measure: () => ({ height: 1, width: 2, x: 1, y: 1 }),
      renderer: async () => raster(),
      rows: 10,
      stdout,
      columns: 20,
    });
    const source = "$x$";
    const view = render(
      <FormulaGraphic
        exactSource={source}
        formulaKey="blocked-retained"
        innerTex="x"
        runtime={runtime}
      />,
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const first = runtime.beforeFrame(20, 10);
    await runtime.afterFrame(first);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(runtime.isVisible("blocked-retained")).toBe(true);
    expect(view.lastFrame()).not.toContain(source);

    stdout.blocked = true;
    const second = runtime.beforeFrame(24, 10);
    const pending = runtime.afterFrame(second);
    await Promise.resolve();
    // The old confirmed placement remains tracked/visible while the replacement waits for drain.
    expect(runtime.placedCount()).toBeGreaterThan(0);
    expect(runtime.isVisible("blocked-retained")).toBe(true);
    expect(view.lastFrame()).not.toContain(source);

    stdout.blocked = false;
    stdout.emit("drain");
    await pending;
    expect(runtime.isVisible("blocked-retained")).toBe(true);
    expect(runtime.placedCount()).toBe(1);
    view.unmount();
    runtime.dispose();
  });

  it("does not unregister a formula when placement visibility rerenders the component", async () => {
    const stdout = new FakeStdout();
    const cache = new FormulaRasterCache(vi.fn<FormulaRasterRenderer>(async () => raster()));
    const runtime = new FormulaGraphicsRuntime({
      cache,
      capability: { cellPixels: { height: 20, width: 10 }, protocol: "kitty" },
      stdout,
      columns: 20,
      rows: 10,
    });
    const view = render(
      <FormulaGraphic
        exactSource="$x$"
        formulaKey="react-visible"
        innerTex="x"
        runtime={runtime}
      />,
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const generation = runtime.beforeFrame(20, 10);
    await runtime.afterFrame(generation);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(runtime.placedCount()).toBe(1);
    expect(runtime.registrationCount()).toBe(1);
    expect(runtime.isVisible("react-visible")).toBe(true);
    view.unmount();
    runtime.dispose();
  });

  it("retains successful visibility through a redraw without notification oscillation", async () => {
    const { ref, runtime } = setup("kitty");
    expect(
      runtime.register({
        key: "stable",
        metrics: { height: 1, width: 2, x: 1, y: 1 },
        raster: raster(),
        ref,
      }),
    ).toBe(true);
    let notifications = 0;
    const unsubscribe = runtime.subscribe(() => {
      notifications += 1;
    });
    const first = runtime.beforeFrame(20, 10);
    await runtime.afterFrame(first);
    expect(runtime.isVisible("stable")).toBe(true);
    const afterPlacementNotifications = notifications;

    const redraw = runtime.beforeFrame(20, 10);
    expect(runtime.isVisible("stable")).toBe(true);
    expect(notifications).toBe(afterPlacementNotifications);
    await runtime.afterFrame(redraw);
    expect(runtime.isVisible("stable")).toBe(true);
    expect(notifications).toBe(afterPlacementNotifications);
    unsubscribe();
    runtime.dispose();
  });

  it("restores exact-source visibility when Ink flush is false or rejected", async () => {
    const { ref, runtime } = setup("kitty");
    expect(
      runtime.register({
        key: "flush-fallback",
        metrics: { height: 1, width: 2, x: 1, y: 1 },
        raster: raster(),
        ref,
      }),
    ).toBe(true);
    const first = runtime.beforeFrame(20, 10);
    await runtime.afterFrame(first);
    expect(runtime.isVisible("flush-fallback")).toBe(true);

    const skipped = runtime.beforeFrame(20, 10);
    await runtime.afterFrame(skipped, false);
    expect(runtime.isVisible("flush-fallback")).toBe(false);

    const rejected = runtime.beforeFrame(20, 10);
    await runtime.afterFrame(rejected, Promise.reject(new Error("Ink flush failed")));
    expect(runtime.isVisible("flush-fallback")).toBe(false);
    runtime.dispose();
  });
});
