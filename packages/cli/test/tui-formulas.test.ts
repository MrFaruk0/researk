import { describe, expect, it } from "vitest";
import {
  buildFormulaIndex,
  firstFormula,
  indexConversationFormulas,
  lastFormula,
  lookupFormula,
  MAX_FORMULA_REFS,
  nextFormula,
  previousFormula,
  reconcileFormulaSelection,
  wrapFormulaDraft,
} from "../src/tui/formulas.js";
import type { ConversationEntry } from "../src/tui/state.js";

function entry(
  id: string,
  role: ConversationEntry["role"],
  source: string,
  streaming = false,
): ConversationEntry {
  return { id, role, source, streaming, createdAt: 0 };
}

describe("formula indexing", () => {
  it("keeps exact source and UTF-16 offsets for every supported delimiter", () => {
    const source =
      "α😀 before $x$ / $$y^2$$ / \\(z\\) / \\[w\\] / after\n```math\n\\int_0^1 x dx\n```\n";
    const formulas = indexConversationFormulas([entry("assistant-1", "assistant", source)]);

    expect(formulas).toHaveLength(5);
    expect(formulas.map((formula) => formula.delimiter)).toEqual([
      "$",
      "$$",
      "\\(",
      "\\[",
      "math-fence",
    ]);

    for (const formula of formulas) {
      expect(source.slice(formula.sourceStart, formula.sourceEnd)).toBe(formula.source);
      expect(formula.key).toBe(`assistant-1:${formula.sourceStart}`);
      expect(formula.sourceStart).toBeGreaterThanOrEqual(0);
      expect(formula.sourceEnd).toBeGreaterThan(formula.sourceStart);
      if (formula.texStart !== undefined && formula.texEnd !== undefined) {
        expect(source.slice(formula.texStart, formula.texEnd)).toBe(formula.tex);
      }
    }

    const [inline, display, paren, bracket, fence] = formulas;
    expect(inline).toMatchObject({ kind: "inline", tex: "x", source: "$x$" });
    expect(display).toMatchObject({ kind: "display", tex: "y^2", source: "$$y^2$$" });
    expect(paren).toMatchObject({ kind: "inline", tex: "z", source: "\\(z\\)" });
    expect(bracket).toMatchObject({ kind: "display", tex: "w", source: "\\[w\\]" });
    expect(fence).toMatchObject({
      kind: "display",
      tex: "\\int_0^1 x dx",
      source: "```math\n\\int_0^1 x dx\n```\n",
    });
    expect(inline?.sourceStart).toBe("α😀 before ".length);
    expect(fence?.texStart).toBe(source.indexOf("\\int_0^1"));
    expect(fence?.texEnd).toBe((fence?.texStart ?? 0) + "\\int_0^1 x dx".length);
  });

  it("indexes only assistant math outside code and distinguishes duplicates", () => {
    const formulas = indexConversationFormulas([
      entry("user-1", "user", "$ignored-user$"),
      entry("tool-1", "tool", "$$ignored-tool$$"),
      entry("system-1", "system", "\\(ignored-system\\)"),
      entry("assistant-1", "assistant", "`$code$` and $same$ then $same$"),
      entry("assistant-2", "assistant", "Again $same$"),
    ]);

    expect(formulas.map((formula) => formula.tex)).toEqual(["same", "same", "same"]);
    expect(new Set(formulas.map((formula) => formula.key)).size).toBe(3);
    expect(formulas[0]?.entryId).toBe("assistant-1");
    expect(formulas[1]?.entryId).toBe("assistant-1");
    expect(formulas[2]?.entryId).toBe("assistant-2");
    expect(formulas[0]?.sourceStart).not.toBe(formulas[1]?.sourceStart);
    expect(formulas[0]?.key).not.toBe(formulas[2]?.key);
  });

  it("excludes unmatched delimiters while retaining exact canonical text around them", () => {
    const source = "before $open \\(also open\n```math\nnot closed\n";
    expect(indexConversationFormulas([entry("assistant-1", "assistant", source)])).toEqual([]);
  });

  it("bounds pathological snapshots without changing ordinary ordering", () => {
    const many = Array.from({ length: MAX_FORMULA_REFS + 3 }, (_, index) => `$x${index}$`).join(
      " ",
    );
    const formulas = indexConversationFormulas([entry("assistant-1", "assistant", many)]);
    expect(formulas).toHaveLength(MAX_FORMULA_REFS);
    expect(formulas[0]?.ordinal).toBe(0);
    expect(formulas.at(-1)?.ordinal).toBe(MAX_FORMULA_REFS - 1);

    const old = entry("old", "assistant", "$old$");
    const recent = entry("recent", "assistant", "$recent$");
    const tooManyEntries = Array.from({ length: 401 }, (_, index) =>
      index === 0 ? old : index === 400 ? recent : entry(`e${index}`, "user", "text"),
    );
    expect(indexConversationFormulas(tooManyEntries).map((formula) => formula.entryId)).toEqual([
      "recent",
    ]);
  });
});

describe("formula navigation and insertion", () => {
  const formulas = indexConversationFormulas([
    entry("assistant-1", "assistant", "$a$ then $$b$$ then \\(c\\)"),
  ]);

  it("supports lookup and ordered first/last/next/previous selection", () => {
    const [a, b, c] = formulas;
    expect(firstFormula(formulas)).toBe(a);
    expect(lastFormula(formulas)).toBe(c);
    expect(lookupFormula(formulas, b?.key)).toBe(b);
    expect(lookupFormula(formulas, b)).toBe(b);
    expect(nextFormula(formulas, undefined)).toBe(a);
    expect(nextFormula(formulas, a)).toBe(b);
    expect(nextFormula(formulas, c)).toBe(c);
    expect(previousFormula(formulas, undefined)).toBe(c);
    expect(previousFormula(formulas, c)).toBe(b);
    expect(previousFormula(formulas, a)).toBe(a);
  });

  it("reconciles a stale ref by former ordinal and clamps to the new range", () => {
    const [a, b, c] = formulas;
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(c).toBeDefined();
    if (a === undefined || b === undefined || c === undefined) return;

    const rebuilt = indexConversationFormulas([
      entry("assistant-1", "assistant", "$new-a$ then $$new-b$$"),
    ]);
    expect(reconcileFormulaSelection(rebuilt, b)).toBe(rebuilt[1]);
    expect(reconcileFormulaSelection(rebuilt, c)).toBe(rebuilt[1]);
    expect(reconcileFormulaSelection(rebuilt, "missing-key")).toBe(rebuilt[0]);
  });

  it("wraps edited TeX with the selected delimiter and preserves valid fences", () => {
    const [a, b, c] = formulas;
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(c).toBeDefined();
    if (a === undefined || b === undefined || c === undefined) return;

    expect(wrapFormulaDraft(a, "A+B")).toBe("$A+B$");
    expect(wrapFormulaDraft(b, "B^2")).toBe("$$B^2$$");
    expect(wrapFormulaDraft(c, "\\frac{1}{2}")).toBe("\\(\\frac{1}{2}\\)");

    const fenceSource = "```math\nold tex\n```\n";
    const [fence] = indexConversationFormulas([entry("assistant-fence", "assistant", fenceSource)]);
    expect(fence).toBeDefined();
    if (fence === undefined) return;
    expect(wrapFormulaDraft(fence, "new tex")).toBe("```math\nnew tex\n```\n");

    // A draft line that would close the original fence falls back to a longer safe fence rather
    // than creating a malformed or truncated fenced block.
    expect(wrapFormulaDraft(fence, "new\n```\ntex")).toBe("````math\nnew\n```\ntex\n````\n");

    const emptyFence = "```math\n```\n";
    const [empty] = indexConversationFormulas([
      entry("assistant-empty-fence", "assistant", emptyFence),
    ]);
    expect(empty).toBeDefined();
    if (empty === undefined) return;
    expect(wrapFormulaDraft(empty, "new")).toBe("```math\nnew\n```\n");
  });

  it("falls back to an unambiguous fenced block for every conflicting delimiter", () => {
    const source = "safe $inline$ $$display$$ \\(paren\\) \\[bracket\\]\n```math\nold\n```\n";
    const [dollar, display, paren, bracket, fence] = indexConversationFormulas([
      entry("assistant-all", "assistant", source),
    ]);
    expect(dollar).toBeDefined();
    expect(display).toBeDefined();
    expect(paren).toBeDefined();
    expect(bracket).toBeDefined();
    expect(fence).toBeDefined();
    if (
      dollar === undefined ||
      display === undefined ||
      paren === undefined ||
      bracket === undefined ||
      fence === undefined
    ) {
      return;
    }

    const cases = [
      [dollar, "a$b with ` and ~"],
      [display, "a$$b with ``` and ~~~~"],
      [paren, "a\\)b with ` and ~"],
      [bracket, "a\\]b with `` and ~~"],
      [fence, "line\n```\n~~~~\nend"],
    ] as const;

    for (const [formula, draft] of cases) {
      const wrapped = wrapFormulaDraft(formula, draft);
      const opening = /^(\u0060+)math\n/u.exec(wrapped);
      expect(opening).not.toBeNull();
      const marker = opening?.[1] ?? "";
      const runs = [...draft.matchAll(/\u0060+/gu)].map((match) => match[0].length);
      expect(marker.length).toBeGreaterThan(Math.max(0, ...runs));

      const indexed = indexConversationFormulas([entry("wrapped", "assistant", wrapped)]);
      expect(indexed).toHaveLength(1);
      expect(indexed[0]?.tex).toBe(draft);
    }
  });

  it("preserves original wrappers for conflict-free drafts, including embedded fence characters", () => {
    const source = "safe $inline$ $$display$$ \\(paren\\) \\[bracket\\]\n```math\nold\n```\n";
    const [dollar, display, paren, bracket, fence] = indexConversationFormulas([
      entry("assistant-safe", "assistant", source),
    ]);
    expect(dollar).toBeDefined();
    expect(display).toBeDefined();
    expect(paren).toBeDefined();
    expect(bracket).toBeDefined();
    expect(fence).toBeDefined();
    if (
      dollar === undefined ||
      display === undefined ||
      paren === undefined ||
      bracket === undefined ||
      fence === undefined
    ) {
      return;
    }

    const draft = "embedded `backticks` and ~tildes~";
    expect(wrapFormulaDraft(dollar, draft)).toBe(`$${draft}$`);
    expect(wrapFormulaDraft(display, draft)).toBe(`$$${draft}$$`);
    expect(wrapFormulaDraft(paren, draft)).toBe(`\\(${draft}\\)`);
    expect(wrapFormulaDraft(bracket, draft)).toBe(`\\[${draft}\\]`);
    expect(wrapFormulaDraft(fence, draft)).toBe(`\`\`\`math\n${draft}\n\`\`\`\n`);

    for (const formula of [dollar, display, paren, bracket, fence]) {
      const wrapped = wrapFormulaDraft(formula, draft);
      const indexed = indexConversationFormulas([entry("wrapped-safe", "assistant", wrapped)]);
      expect(indexed).toHaveLength(1);
      expect(indexed[0]?.tex).toBe(draft);
    }
  });

  it("round-trips multiline drafts and a trailing carriage return through safe fences", () => {
    const [formula] = indexConversationFormulas([entry("assistant-dollar", "assistant", "$x$")]);
    expect(formula).toBeDefined();
    if (formula === undefined) return;

    for (const draft of ["line one\nline two with $ closer", "ends with CR\r"]) {
      const wrapped = wrapFormulaDraft(formula, draft);
      const indexed = indexConversationFormulas([entry("wrapped", "assistant", wrapped)]);
      expect(indexed).toHaveLength(1);
      expect(indexed[0]?.tex).toBe(draft);
    }
  });

  it("uses a safe fence for a tilde-delimited source when its closing run conflicts", () => {
    const source = "~~~math\nold\n~~~\n";
    const [formula] = indexConversationFormulas([entry("assistant-tilde", "assistant", source)]);
    expect(formula).toBeDefined();
    if (formula === undefined) return;

    const draft = "line\n~~~~\nwith `ticks`";
    const wrapped = wrapFormulaDraft(formula, draft);
    expect(wrapped.startsWith("```math\n")).toBe(true);
    const indexed = indexConversationFormulas([entry("wrapped-tilde", "assistant", wrapped)]);
    expect(indexed).toHaveLength(1);
    expect(indexed[0]?.tex).toBe(draft);
  });

  it("does not alter the original ref while wrapping", () => {
    const [formula] = formulas;
    expect(formula).toBeDefined();
    if (formula === undefined) return;
    const before = { ...formula };
    wrapFormulaDraft(formula, "changed");
    expect(formula).toEqual(before);
  });
});

describe("formula index aliases", () => {
  it("keeps the builder alias equivalent to the primary helper", () => {
    const conversation = [entry("assistant-1", "assistant", "$x$")];
    expect(buildFormulaIndex(conversation)).toEqual(indexConversationFormulas(conversation));
  });
});
