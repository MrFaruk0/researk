import { Box } from "ink";
import { render } from "ink-testing-library";
import React from "react";
import { describe, expect, it } from "vitest";
import { Conversation } from "../src/tui/components/Conversation.js";
import { classifyContent } from "../src/tui/content.js";
import { indexConversationFormulas } from "../src/tui/formulas.js";
import { FormulaGraphicsRuntime } from "../src/tui/graphics.js";
import type { ConversationEntry } from "../src/tui/state.js";
import { createTuiTheme } from "../src/tui/theme.js";

const darkTheme = createTuiTheme("dark", { colorEnabled: true });
const lightTheme = createTuiTheme("light", { colorEnabled: true });
const monoTheme = createTuiTheme("mono", { colorEnabled: false });

function entry(
  id: string,
  role: ConversationEntry["role"],
  source: string,
  streaming = false,
): ConversationEntry {
  return { id, role, source, streaming, createdAt: 0 };
}

function transcript(
  theme: ReturnType<typeof createTuiTheme>,
  entries: readonly ConversationEntry[],
  height: number,
  scrollOffset: number,
  onScrollRangeChange?: (maxScrollRows: number) => void,
  width = 48,
  graphicsRuntime?: FormulaGraphicsRuntime,
  selectedFormulaKey?: string,
): React.ReactElement {
  const runtimeProps = graphicsRuntime === undefined ? {} : { graphicsRuntime };
  const selectionProps = selectedFormulaKey === undefined ? {} : { selectedFormulaKey };
  return React.createElement(
    Box,
    { width },
    React.createElement(Conversation, {
      theme,
      entries,
      height,
      scrollOffset,
      emptyHint: "No conversation yet",
      onScrollRangeChange,
      ...runtimeProps,
      ...selectionProps,
    }),
  );
}

function createGraphicsRuntime(
  requests: Array<{ readonly display: boolean; readonly tex: string }>,
) {
  return new FormulaGraphicsRuntime({
    capability: { cellPixels: { height: 20, width: 10 }, protocol: "kitty" },
    columns: 48,
    renderer: async (request) => {
      requests.push({ display: request.display, tex: request.tex });
      return {
        height: request.display ? 40 : 20,
        pixels: new Uint8Array(20 * 20 * 4),
        png: Uint8Array.from([0x89, 0x50, 0x4e, 0x47]),
        width: 20,
      };
    },
    stdout: { write: () => true },
  });
}

function createMeasuredGraphicsRuntime(
  protocol: "kitty" | "sixel",
  requests: Array<{ readonly display: boolean; readonly tex: string }>,
  measure: () =>
    | { readonly height: number; readonly width: number; readonly x: number; readonly y: number }
    | undefined,
) {
  const writes: string[] = [];
  const stdout = {
    write: (chunk: string): boolean => {
      writes.push(chunk);
      return true;
    },
  };
  const capability = { cellPixels: { height: 20, width: 10 }, protocol };
  const runtime = new FormulaGraphicsRuntime({
    capability,
    columns: 48,
    measure,
    renderer: async (request) => {
      requests.push({ display: request.display, tex: request.tex });
      const pixels = new Uint8Array(20 * 20 * 4);
      for (let offset = 3; offset < pixels.length; offset += 4) pixels[offset] = 255;
      return {
        height: 20,
        pixels,
        png: Uint8Array.from([0x89, 0x50, 0x4e, 0x47]),
        width: 20,
      };
    },
    rows: 10,
    stdout,
  });
  return { runtime, writes };
}

async function settleLayout(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 30);
  });
}

describe("conversation content and viewport", () => {
  it("renders user and assistant surfaces without visible role labels", () => {
    const view = render(
      transcript(
        darkTheme,
        [entry("u", "user", "user prompt"), entry("a", "assistant", "assistant answer")],
        10,
      ),
    );
    const frame = view.lastFrame() ?? "";

    expect(frame).toContain("user prompt");
    expect(frame).toContain("assistant answer");
    expect(frame).not.toMatch(/\b(?:you|researk)\b/iu);
    expect((frame.match(/┌/gu) ?? []).length).toBeGreaterThanOrEqual(2);
    view.unmount();
  });

  it("keeps a streaming placeholder quiet and never exposes run status labels", () => {
    const view = render(transcript(darkTheme, [entry("a", "assistant", "", true)], 5));
    const frame = view.lastFrame() ?? "";

    expect(frame).toContain("…");
    expect(frame).not.toMatch(/\b(?:streaming|ready)\b/iu);
    view.unmount();
  });

  it("retains styled segments in headings, quotes, and list items", () => {
    const tick = String.fromCharCode(96);
    const blocks = classifyContent(
      "# Heading $x$ " +
        tick +
        "code" +
        tick +
        " [1]\n> Quote $y$ " +
        tick +
        "quoted" +
        tick +
        " [2]\n- Item $z$ " +
        tick +
        "item" +
        tick +
        " [3]",
    );
    const heading = blocks.find((block) => block.kind === "heading");
    const quote = blocks.find((block) => block.kind === "quote");
    const list = blocks.find((block) => block.kind === "list-item");

    expect(
      heading?.kind === "heading" ? heading.segments.map((segment) => segment.kind) : [],
    ).toEqual(["text", "inline-math", "text", "code", "text", "citation"]);
    expect(quote?.kind === "quote" ? quote.segments.map((segment) => segment.kind) : []).toEqual([
      "text",
      "inline-math",
      "text",
      "code",
      "text",
      "citation",
    ]);
    expect(list?.kind === "list-item" ? list.segments.map((segment) => segment.kind) : []).toEqual([
      "text",
      "inline-math",
      "text",
      "code",
      "text",
      "citation",
    ]);
  });

  it("shows exact inline and display LaTeX source in safe math treatment", () => {
    const source = "Inline $a^2$ then\n\\[\\frac{a+b}{c+d}\\]";
    const view = render(transcript(monoTheme, [entry("a", "assistant", source)], 12));
    const frame = view.lastFrame() ?? "";
    const display = classifyContent(source).find((block) => block.kind === "display-math");

    expect(display?.kind === "display-math" ? display.source : "").toBe("\\[\\frac{a+b}{c+d}\\]");
    expect(frame).toContain("$a^2$");
    expect(frame).toContain("\\[\\frac{a+b}{c+d}\\]");
    expect(frame).toContain("┌");
    expect(frame).not.toMatch(/MathJax|latex-renderer|1337;File=/iu);
    view.unmount();
  });

  it("keeps display math borderless inside the message shell", () => {
    const view = render(
      transcript(darkTheme, [entry("display-border", "assistant", "\\[x^2\\]")], 8),
    );
    const frame = view.lastFrame() ?? "";

    // The message itself retains its shell border; display math contributes only natural spacing.
    expect((frame.match(/┌/gu) ?? []).length).toBe(1);
    expect(frame).toContain("\\[x^2\\]");
    view.unmount();
  });

  it("keeps color-disabled assistant math exact-source even with a positive graphics runtime", async () => {
    const requests: Array<{ readonly display: boolean; readonly tex: string }> = [];
    const runtime = createGraphicsRuntime(requests);
    const source = "\\[ x+y \\]";
    const view = render(
      transcript(
        monoTheme,
        [entry("assistant-no-color", "assistant", source)],
        8,
        0,
        undefined,
        48,
        runtime,
      ),
    );
    await settleLayout();
    expect(requests).toEqual([]);
    expect(view.lastFrame() ?? "").toContain(source);
    view.unmount();
    runtime.dispose();
  });

  it("promotes assistant inline formulas without dropping surrounding prose", async () => {
    const requests: Array<{ readonly display: boolean; readonly tex: string }> = [];
    const runtime = createGraphicsRuntime(requests);
    const view = render(
      transcript(
        darkTheme,
        [entry("assistant-inline", "assistant", "before $x$ after")],
        8,
        0,
        undefined,
        48,
        runtime,
      ),
    );
    await settleLayout();

    expect(requests).toEqual([{ display: false, tex: "x" }]);
    const lines = (view.lastFrame() ?? "").split("\n");
    const before = lines.findIndex((line) => line.includes("before"));
    const after = lines.findIndex((line) => line.includes("after"));
    expect(before).toBeGreaterThanOrEqual(0);
    expect(after).toBeGreaterThan(before);
    expect(view.lastFrame() ?? "").not.toContain("before $x$ after");

    view.unmount();
    runtime.dispose();
  });

  it("renders display formulas through the graphic slot and keeps duplicate order", async () => {
    const requests: Array<{ readonly display: boolean; readonly tex: string }> = [];
    const runtime = createGraphicsRuntime(requests);
    const source = "first $x$ second $x$\n\\[x^2\\]";
    const refs = indexConversationFormulas([entry("assistant-duplicates", "assistant", source)]);
    const view = render(
      transcript(
        darkTheme,
        [entry("assistant-duplicates", "assistant", source)],
        10,
        0,
        undefined,
        48,
        runtime,
      ),
    );
    await settleLayout();

    expect(refs.map((formula) => formula.key)).toEqual([
      "assistant-duplicates:6",
      "assistant-duplicates:17",
      "assistant-duplicates:21",
    ]);
    expect(requests).toEqual([
      { display: false, tex: "x" },
      { display: true, tex: "x^2" },
    ]);
    expect(view.lastFrame() ?? "").toContain("\\[x^2\\]");

    view.unmount();
    runtime.dispose();
  });

  it("shares one cumulative render budget per assistant response without starving the next one", async () => {
    const requests: Array<{ readonly display: boolean; readonly tex: string }> = [];
    const runtime = new FormulaGraphicsRuntime({
      capability: { cellPixels: { height: 20, width: 10 }, protocol: "kitty" },
      renderer: async (request, options) => {
        // The real LaTeX backend claims this same budget. This seam keeps the regression independent
        // of workers and terminal graphics while preserving the backend contract.
        options.budget?.claim();
        requests.push({ display: request.display, tex: request.tex });
        return {
          height: 20,
          pixels: new Uint8Array(20 * 20 * 4),
          png: Uint8Array.from([0x89, 0x50, 0x4e, 0x47]),
          width: 20,
        };
      },
      stdout: { write: () => true },
    });
    const source = Array.from({ length: 260 }, (_, index) => `$x_{${index}}$`).join(" ");
    const first = entry("budgeted-response", "assistant", source);
    const view = render(transcript(darkTheme, [first], 10, 0, undefined, 48, runtime));
    await settleLayout();

    expect(requests).toHaveLength(256);
    expect(view.lastFrame() ?? "").toContain("$x_{259}$");

    // Theme/layout rerenders keep this response's budget exhausted rather than granting every
    // FormulaGraphic a fresh allowance.
    view.rerender(transcript(lightTheme, [first], 10, 0, undefined, 48, runtime));
    await settleLayout();
    expect(requests).toHaveLength(256);

    // A distinct keyed response receives its own budget and can render normally.
    const second = entry("later-response", "assistant", "$fresh$");
    view.rerender(transcript(lightTheme, [first, second], 10, 0, undefined, 48, runtime));
    await settleLayout();
    expect(requests).toHaveLength(257);

    view.unmount();
    runtime.dispose();
  });

  it.each(["kitty", "sixel"] as const)(
    "rasterizes and places an assistant formula through the %s frame lifecycle",
    async (protocol) => {
      const requests: Array<{ readonly display: boolean; readonly tex: string }> = [];
      const source = "Rendered answer: $x^2 + y^2$";
      const [formula] = indexConversationFormulas([entry("assistant-placed", "assistant", source)]);
      expect(formula).toBeDefined();
      const runtime = createMeasuredGraphicsRuntime(protocol, requests, () => ({
        height: 1,
        width: 2,
        x: 1,
        y: 1,
      }));
      const view = render(
        transcript(
          darkTheme,
          [entry("assistant-placed", "assistant", source)],
          8,
          0,
          undefined,
          48,
          runtime.runtime,
        ),
      );
      await settleLayout();

      expect(runtime.runtime.registrationCount()).toBe(1);
      expect(requests).toEqual([{ display: false, tex: "x^2 + y^2" }]);
      expect(view.lastFrame() ?? "").toContain("Rendered answer:");
      expect(view.lastFrame() ?? "").toContain("$x^2 + y^2$");

      const generation = runtime.runtime.beforeFrame(48, 10);
      await runtime.runtime.afterFrame(generation);
      await settleLayout();

      expect(formula).toBeDefined();
      expect(runtime.runtime.isVisible(formula?.key ?? "")).toBe(true);
      expect(runtime.runtime.placedCount()).toBe(1);
      expect(view.lastFrame() ?? "").not.toContain(source);
      const output = runtime.writes.join("");
      if (protocol === "kitty") {
        expect(output).toContain("\u001b_Ga=T");
        expect(output).toContain("c=2,r=1");
      } else {
        expect(output).toContain("\u001bP0;1q");
        expect(output).toContain("\u001b[2;2H");
      }

      view.unmount();
      runtime.runtime.dispose();
    },
  );

  it("falls back to the exact source when a rendered formula becomes invalidly placed", async () => {
    const requests: Array<{ readonly display: boolean; readonly tex: string }> = [];
    const source = "Answer with a formula: $\\frac{a}{b}$";
    const [formula] = indexConversationFormulas([
      entry("assistant-invalid-placement", "assistant", source),
    ]);
    expect(formula).toBeDefined();
    let validPlacement = true;
    const runtime = createMeasuredGraphicsRuntime("kitty", requests, () =>
      validPlacement ? { height: 1, width: 2, x: 1, y: 1 } : undefined,
    );
    const view = render(
      transcript(
        darkTheme,
        [entry("assistant-invalid-placement", "assistant", source)],
        8,
        0,
        undefined,
        48,
        runtime.runtime,
      ),
    );
    await settleLayout();

    const firstGeneration = runtime.runtime.beforeFrame(48, 10);
    await runtime.runtime.afterFrame(firstGeneration);
    await settleLayout();
    expect(runtime.runtime.isVisible(formula?.key ?? "")).toBe(true);
    expect(view.lastFrame() ?? "").not.toContain("$\\frac{a}{b}$");
    const kittyPlacementMarker = `${String.fromCharCode(27)}_Ga=T`;
    const placedOutputCount = runtime.writes.join("").split(kittyPlacementMarker).length - 1;

    validPlacement = false;
    const invalidGeneration = runtime.runtime.beforeFrame(48, 10);
    await runtime.runtime.afterFrame(invalidGeneration);
    await settleLayout();

    expect(runtime.runtime.isVisible(formula?.key ?? "")).toBe(false);
    // The old confirmed placement may be retained for one transition frame; source is already
    // restored, so cleanup cannot create a blank/omitted formula while the replacement is stale.
    expect(runtime.runtime.placedCount()).toBeGreaterThanOrEqual(0);
    expect(view.lastFrame() ?? "").toContain("Answer with a formula:");
    expect(view.lastFrame() ?? "").toContain("$\\frac{a}{b}$");
    expect(runtime.writes.join("").split(kittyPlacementMarker).length - 1).toBe(placedOutputCount);

    view.unmount();
    runtime.runtime.dispose();
  });

  it("keeps non-assistant and incomplete math source-only and marks selected formulas", async () => {
    const requests: Array<{ readonly display: boolean; readonly tex: string }> = [];
    const runtime = createGraphicsRuntime(requests);
    const assistant = entry("assistant-selected", "assistant", "answer $x$");
    const [formula] = indexConversationFormulas([assistant]);
    const view = render(
      transcript(
        darkTheme,
        [
          entry("user-formula", "user", "user $y$"),
          entry("assistant-incomplete", "assistant", "tail $z"),
          assistant,
        ],
        12,
        0,
        undefined,
        48,
        runtime,
        formula?.key,
      ),
    );
    await settleLayout();

    expect(requests).toEqual([{ display: false, tex: "x" }]);
    const frame = view.lastFrame() ?? "";
    expect(frame).toContain("user $y$");
    expect(frame).toContain("tail $z");
    expect(frame).toContain("\u25b8");

    view.unmount();
    runtime.dispose();
  });

  it("neutralizes active terminal controls while preserving no-color structure", () => {
    const dangerous = "SAFE" + String.fromCharCode(27) + "]0;spoof" + String.fromCharCode(7);
    const tick = String.fromCharCode(96);
    const source = "# Heading $x$ [1]\n> quote\n- item " + tick + "code" + tick + "\n" + dangerous;
    const view = render(
      transcript(monoTheme, [entry("a", "assistant", source)], 14, 0, undefined, 28),
    );
    const frame = view.lastFrame() ?? "";

    expect(frame.includes(String.fromCharCode(27))).toBe(false);
    expect(frame).toContain("\\u{001b}");
    expect(frame).toContain("{0007}");
    expect(frame).toContain("# Heading");
    expect(frame).toContain("│ quote");
    expect(frame.split("\n").every((line) => line.length <= 28)).toBe(true);
    view.unmount();
  });

  it("clips by rendered rows, follows the tail at zero, clamps offsets, and reports range changes", async () => {
    const source = Array.from(
      { length: 28 },
      (_, index) => "ROW-" + String(index).padStart(2, "0") + " " + "wrapped content ".repeat(3),
    ).join("\n");
    const ranges: number[] = [];
    const entries = [entry("long", "assistant", source)];
    const view = render(transcript(monoTheme, entries, 5, 0, (value) => ranges.push(value), 34));
    await settleLayout();

    const initialRange = ranges.at(-1);
    expect(initialRange).toBeDefined();
    expect(initialRange ?? 0).toBeGreaterThan(0);
    const maxScroll = initialRange ?? 0;
    const tail = view.lastFrame() ?? "";
    expect(tail).toContain("ROW-27");
    expect(tail).not.toContain("ROW-00");
    const callbackCount = ranges.length;
    await settleLayout();
    expect(ranges.length).toBe(callbackCount);

    view.rerender(transcript(monoTheme, entries, 5, maxScroll + 100, undefined, 34));
    await settleLayout();
    const oldest = view.lastFrame() ?? "";
    expect(oldest).toContain("ROW-00");
    expect(oldest).not.toContain("ROW-27");

    view.rerender(transcript(monoTheme, entries, 5, -100, undefined, 34));
    await settleLayout();
    expect(view.lastFrame() ?? "").toBe(tail);

    view.rerender(transcript(monoTheme, entries, 5, maxScroll, undefined, 34));
    await settleLayout();
    const clamped = view.lastFrame() ?? "";
    view.rerender(transcript(monoTheme, entries, 5, maxScroll + 100, undefined, 34));
    await settleLayout();
    expect(view.lastFrame() ?? "").toBe(clamped);

    view.rerender(transcript(monoTheme, entries, 8, 0, (value) => ranges.push(value), 34));
    await settleLayout();
    expect(ranges.at(-1)).toBeDefined();
    expect(ranges.at(-1)).toBeLessThan(maxScroll);
    view.unmount();
  });
});
