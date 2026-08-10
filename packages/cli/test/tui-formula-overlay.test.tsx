import { Text } from "ink";
import { render as inkRender } from "ink-testing-library";
import type React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { indexConversationFormulas } from "../src/tui/formulas.js";
import {
  FormulaOverlay,
  formulaCursorOffset,
  formulaCursorText,
  formulaInputText,
} from "../src/tui/overlays/FormulaOverlay.js";
import type { ConversationEntry } from "../src/tui/state.js";
import { createTuiTheme } from "../src/tui/theme.js";

const theme = createTuiTheme("dark", { colorEnabled: false });
const mounted = new Set<ReturnType<typeof inkRender>>();

function entry(id: string, source: string): ConversationEntry {
  return { id, role: "assistant", source, streaming: false, createdAt: 0 };
}

function formula() {
  const [ref] = indexConversationFormulas([entry("assistant-1", "Answer: $x^2$.")]);
  if (ref === undefined) throw new Error("test formula was not indexed");
  return ref;
}

function render(element: React.ReactElement): ReturnType<typeof inkRender> {
  const instance = inkRender(element);
  mounted.add(instance);
  return instance;
}

afterEach(() => {
  for (const instance of mounted) instance.unmount();
  mounted.clear();
});

describe("formula overlay", () => {
  it("projects unsafe draft text safely and keeps the cursor visible", () => {
    expect(formulaCursorOffset("a😀b", 2)).toBe(3);
    expect(formulaInputText("a\u001b[31m", 1)).toContain("a█\\u{001b}[31m");
    expect(formulaCursorText("", 0)).toBe("█");
  });

  it("renders browse title/count, safe source fallback, and action hints", () => {
    const ref = formula();
    const view = render(
      <FormulaOverlay theme={theme} formula={ref} position={1} count={3} width={70} />,
    );
    const frame = view.lastFrame() ?? "";
    expect(frame).toContain("Formula 1 of 3");
    expect(frame).toContain("Exact source");
    expect(frame).toContain("$x^2$");
    expect(frame).toContain("c copy source");
    expect(frame).toContain("e edit/rerender");
    expect(frame).toContain("i insert");
    expect(frame).toContain("s source");
    expect(frame).toContain("Esc close");
  });

  it("never sends a raw terminal escape from formula source to Ink", () => {
    const [ref] = indexConversationFormulas([entry("assistant-unsafe", "Answer: $x\u001b[31m$")]);
    expect(ref).toBeDefined();
    if (ref === undefined) return;
    const view = render(<FormulaOverlay theme={theme} formula={ref} />);
    const frame = view.lastFrame() ?? "";
    expect(frame).toContain("\\u{001b}[31m");
    expect(frame).not.toContain("\u001b");
  });

  it("renders edit mode with a local cursor and rerender preview slot", () => {
    const ref = formula();
    const view = render(
      <FormulaOverlay
        theme={theme}
        mode="edit"
        formula={ref}
        draft="x+1"
        cursor={2}
        preview={<Text>rendered draft</Text>}
        width={70}
      />,
    );
    const frame = view.lastFrame() ?? "";
    expect(frame).toContain("Local draft");
    expect(frame).toContain("x+█1");
    expect(frame).toContain("rendered draft");
    expect(frame).toContain("Typeset preview · exact source fallback");
    expect(frame).toContain("Ctrl+J newline");
    expect(frame).toContain("Enter apply/rerender");
    expect(frame).toContain("Esc cancel");
    expect(frame).toContain("assistant source unchanged");
  });

  it("clips to a tiny bounded region without producing invalid dimensions", () => {
    const view = render(
      <FormulaOverlay theme={theme} formula={formula()} width={Number.NaN} height={2} />,
    );
    const frame = view.lastFrame() ?? "";
    expect(frame.split("\n")).toHaveLength(2);
    expect(frame).not.toContain("NaN");
  });

  it("labels unsupported rendering as exact source instead of preview", () => {
    const ref = formula();
    const view = render(
      <FormulaOverlay
        theme={theme}
        formula={ref}
        width={70}
        sourceLabel="Exact source · typeset preview unavailable"
      />,
    );
    const frame = view.lastFrame() ?? "";
    expect(frame).toContain("Exact source · typeset preview unavailable");
    expect(frame).toContain("$x^2$");
    expect(frame).not.toContain("Preview");
  });

  it.each([1, 2, 3, 4, 5])("keeps browse controls and source usable at height %i", (height) => {
    const view = render(
      <FormulaOverlay
        theme={theme}
        formula={formula()}
        width={70}
        height={height}
        sourceLabel="Exact source · typeset preview unavailable"
      />,
    );
    const frame = view.lastFrame() ?? "";
    expect(frame.split("\n")).toHaveLength(height);
    expect(frame).toContain("Esc close");
    expect(frame).toContain("$x^2$");
  });

  it.each([1, 2, 3, 4])(
    "makes every browse operation discoverable at compact height %i",
    (height) => {
      const view = render(
        <FormulaOverlay theme={theme} formula={formula()} width={70} height={height} />,
      );
      const frame = view.lastFrame() ?? "";
      expect(frame).toContain("$x^2$");
      expect(frame).toContain("↑↓/jk");
      expect(frame).toContain("c copy");
      expect(frame).toContain("e edit");
      expect(frame).toContain("i insert");
      expect(frame).toContain("s source");
      expect(frame).toContain("Esc close");
    },
  );

  it.each([1, 2, 3, 4, 5])("keeps edit controls and draft usable at height %i", (height) => {
    const view = render(
      <FormulaOverlay
        theme={theme}
        mode="edit"
        formula={formula()}
        draft="x+1"
        cursor={2}
        width={70}
        height={height}
        sourceLabel="Exact source · typeset preview unavailable"
      />,
    );
    const frame = view.lastFrame() ?? "";
    expect(frame.split("\n")).toHaveLength(height);
    expect(frame).toContain("Esc cancel");
    expect(frame).toContain("x+1");
  });

  it.each([1, 2, 3, 4])(
    "makes every edit operation discoverable at compact height %i",
    (height) => {
      const view = render(
        <FormulaOverlay
          theme={theme}
          mode="edit"
          formula={formula()}
          draft="x+1"
          cursor={2}
          width={70}
          height={height}
          sourceLabel="Exact source · typeset preview unavailable"
        />,
      );
      const frame = view.lastFrame() ?? "";
      expect(frame).toContain("x+1");
      expect(frame).toContain("←→");
      expect(frame).toContain("Backspace/Del");
      expect(frame).toContain("Ctrl+J");
      expect(frame).toContain("Enter apply");
      expect(frame).toContain("Esc cancel");
    },
  );

  it("labels a local draft preview and fallback without calling either exact source", () => {
    const ref = formula();
    const preview = render(
      <FormulaOverlay
        theme={theme}
        formula={ref}
        localDraft
        exactSource="$x+1$"
        preview={<Text>rendered local draft</Text>}
        width={70}
      />,
    );
    const previewFrame = preview.lastFrame() ?? "";
    expect(previewFrame).toContain("Local draft preview/fallback");
    expect(previewFrame).not.toContain("Exact source");

    const fallback = render(
      <FormulaOverlay theme={theme} formula={ref} localDraft exactSource="$x+1$" width={70} />,
    );
    const fallbackFrame = fallback.lastFrame() ?? "";
    expect(fallbackFrame).toContain("Local draft · typeset preview unavailable");
    expect(fallbackFrame).not.toContain("Exact source");
  });
});
