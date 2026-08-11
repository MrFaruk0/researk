import { describe, expect, it } from "vitest";
import {
  createTerminalCapabilities,
  EXACT_SOURCE_FORMULA_RENDERER,
  type FormulaArtifact,
  renderExactFormulaSource,
  selectFormulaRenderer,
} from "../src/rendering/capabilities.js";

const kittyEvidence = {
  protocol: "kitty",
  reason: "explicit Kitty graphics query response",
  kittyResponse: { id: 31, message: "OK", status: "ok", explicitOk: true },
  da1Parameters: [1, 2, 4],
  cellPixels: { width: 10, height: 20 },
} as const;

const formula: FormulaArtifact = {
  id: "formula-1",
  latex: String.raw`\frac{\alpha}{\beta} + \text{unsupported \LaTeX}`,
  originalLatex: String.raw`\[\frac{\alpha}{\beta} + \text{unsupported \LaTeX}\]`,
};

describe("terminal capabilities and formula renderer selection", () => {
  it("selects Kitty graphics from explicit protocol evidence", () => {
    const capabilities = createTerminalCapabilities(kittyEvidence, {
      isTTY: true,
      interactive: true,
      trueColor: true,
      mouse: true,
    });

    expect(capabilities.kittyGraphics).toBe(true);
    expect(capabilities.sixel).toBe(false);
    expect(capabilities.itermImages).toBe(false);
    expect(capabilities.protocol).toBe("kitty");
    expect(capabilities.evidence?.kittyResponse?.explicitOk).toBe(true);
    expect(selectFormulaRenderer(capabilities).id).toBe("kitty");
  });

  it("normalizes an existing synchronous terminal capability at the selection boundary", () => {
    expect(
      selectFormulaRenderer({
        protocol: "kitty",
        reason: "explicit protocol evidence",
      }).id,
    ).toBe("kitty");
  });

  it("accepts a protocol-neutral capability fixture when its graphics flag is positive", () => {
    expect(
      selectFormulaRenderer({
        kittyGraphics: true,
        sixel: false,
        itermImages: false,
        mouse: false,
        trueColor: false,
      }).id,
    ).toBe("kitty");
  });

  it("represents Sixel and iTerm evidence without process-name checks", () => {
    const sixel = createTerminalCapabilities(
      { protocol: "sixel", reason: "positive Sixel evidence" },
      { isTTY: true },
    );
    const iterm = createTerminalCapabilities(
      { protocol: "iterm2", reason: "trusted iTerm2 protocol evidence" },
      { isTTY: true },
    );

    expect(sixel.sixel).toBe(true);
    expect(sixel.kittyGraphics).toBe(false);
    expect(selectFormulaRenderer(sixel).id).toBe("sixel");
    expect(iterm.itermImages).toBe(true);
    expect(iterm.kittyGraphics).toBe(false);
    expect(selectFormulaRenderer(iterm).id).toBe("iterm2");
  });

  it("uses exact source for ordinary unsupported terminals", () => {
    const capabilities = createTerminalCapabilities({
      protocol: "unsupported",
      reason: "no positively detected graphics protocol",
    });

    expect(selectFormulaRenderer(capabilities)).toBe(EXACT_SOURCE_FORMULA_RENDERER);
    expect(selectFormulaRenderer(capabilities).id).toBe("exact-source");
  });

  it("keeps explicit mouse and true-color signals conservative", () => {
    const capabilities = createTerminalCapabilities(
      { protocol: "unsupported", reason: "ordinary terminal" },
      { isTTY: true, interactive: true, mouse: true, trueColor: true },
    );
    const nonInteractive = createTerminalCapabilities(
      { protocol: "kitty", reason: "probe evidence" },
      { isTTY: true, interactive: false, mouse: true, trueColor: true },
    );
    const implicit = createTerminalCapabilities({ protocol: "unsupported", reason: "unknown" });

    expect(capabilities.mouse).toBe(true);
    expect(capabilities.trueColor).toBe(true);
    expect(nonInteractive.mouse).toBe(false);
    expect(nonInteractive.trueColor).toBe(false);
    expect(implicit.mouse).toBe(false);
    expect(implicit.trueColor).toBe(false);
  });

  it.each([
    ["accessible", { accessible: true }],
    ["non-interactive", { interactive: false }],
    ["non-TTY", { isTTY: false }],
  ] as const)("does not select graphics for %s output", (_label, signals) => {
    const capabilities = createTerminalCapabilities(kittyEvidence, signals);

    expect(capabilities.kittyGraphics).toBe(false);
    expect(selectFormulaRenderer(capabilities).id).toBe("exact-source");
    expect(selectFormulaRenderer(createTerminalCapabilities(kittyEvidence), signals).id).toBe(
      "exact-source",
    );
  });

  it("preserves exact original LaTeX in the fallback", async () => {
    const result = renderExactFormulaSource(formula);
    expect(result.format).toBe("source");
    expect(result.source).toBe(formula.originalLatex);
    expect(result.content).toBe(formula.originalLatex);

    const selected = selectFormulaRenderer(
      createTerminalCapabilities({ protocol: "unsupported", reason: "unsupported" }),
    );
    expect(selected.render).toBeDefined();
    expect(selected.render?.(formula)).toEqual(result);
  });
});
