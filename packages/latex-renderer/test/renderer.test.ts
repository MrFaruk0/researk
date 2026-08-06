import { describe, expect, it } from "vitest";
import { LatexSvgRenderError, latexSvgRendererLimits, renderTexToSvg } from "../src/index.js";

describe("renderTexToSvg", () => {
  it("renders a real MathJax SVG artifact in memory", () => {
    const result = renderTexToSvg({
      tex: "\\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}",
    });

    expect(result).toMatchObject({
      display: true,
      renderer: "mathjax-4.1.3",
      tex: "\\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}",
    });
    expect(result.svg).toMatch(/^<svg\b/u);
    expect(result.svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(result.svg).toContain('role="img"');
    expect(result.svg).toContain("<path");
    expect(result.svg).not.toContain("<mjx-container");
    expect(result.svg).not.toMatch(/<(?:script|foreignObject)\b/iu);
    expect(result.svg).not.toMatch(/\b(?:href|xlink:href)=/iu);
  });

  it("does not enable extension loading or active links through TeX input", () => {
    const result = renderTexToSvg({
      display: false,
      tex: "\\href{https://example.invalid}{x}",
    });

    expect(result.display).toBe(false);
    expect(result.svg).not.toMatch(/\b(?:href|xlink:href)=/iu);
    expect(result.svg).not.toMatch(/<(?:script|foreignObject)\b/iu);
  });

  it("rejects empty, unbalanced, over-nested, and oversized input before rendering", () => {
    expect(() => renderTexToSvg({ tex: "" })).toThrow(LatexSvgRenderError);
    expect(() => renderTexToSvg({ tex: "{x" })).toThrow(LatexSvgRenderError);

    const excessiveNesting = `${"{".repeat(latexSvgRendererLimits.maximumBraceNesting + 1)}x${"}".repeat(
      latexSvgRendererLimits.maximumBraceNesting + 1,
    )}`;
    expect(() => renderTexToSvg({ tex: excessiveNesting })).toThrow(
      expect.objectContaining({ code: "input_limit" }),
    );

    expect(() =>
      renderTexToSvg({ tex: "x".repeat(latexSvgRendererLimits.maximumInputBytes + 1) }),
    ).toThrow(expect.objectContaining({ code: "input_limit" }));
  });
});
