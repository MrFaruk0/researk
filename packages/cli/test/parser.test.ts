import { describe, expect, it } from "vitest";
import {
  IncrementalMarkdownMathParser,
  type MarkdownRenderEvent,
  parseMarkdownMath,
} from "../src/rendering/parser.js";
import {
  ExactSourceMathRenderer,
  GRAPHICS_CAPABILITY,
  MathJaxSvgMathRenderer,
  renderExactSource,
  renderTerminalPresentation,
} from "../src/rendering/renderer.js";
import {
  escapeUnsafeTerminalControls,
  hasTerminalEscape,
  neutralizeCarriageReturnsForDisplay,
} from "../src/safety.js";
import { createTheme } from "../src/theme.js";

function parseBytes(chunks: readonly Uint8Array[]): readonly MarkdownRenderEvent[] {
  const parser = new IncrementalMarkdownMathParser();
  const events: MarkdownRenderEvent[] = [];
  for (const chunk of chunks) {
    events.push(...parser.push(chunk));
  }
  events.push(...parser.finish());
  return events;
}

function sourceOf(events: readonly MarkdownRenderEvent[]): string {
  return events.map((event) => event.source).join("");
}

describe("incremental Markdown and math parser", () => {
  const fixtures = [
    "Text $x^2 + y^2$ end.",
    "Display $$\\frac{a}{b}$$ and \\(z_1\\).",
    "Unicode α before \\[\\sum_{i=1}^n i\\] after.",
    "`code $not_math$` then $math$",
    "```ts\nconst price = '$5';\n```\n$outside$",
    "```math\n\\int_0^1 x\\,dx\n```\n",
  ] as const;

  for (const fixture of fixtures) {
    it(`is independent of every byte split for ${JSON.stringify(fixture)}`, () => {
      const bytes = new TextEncoder().encode(fixture);
      const expected = parseMarkdownMath(fixture);

      for (let split = 0; split <= bytes.length; split += 1) {
        expect(parseBytes([bytes.slice(0, split), bytes.slice(split)])).toEqual(expected);
      }

      expect(parseBytes(Array.from(bytes, (byte) => Uint8Array.of(byte)))).toEqual(expected);
      expect(sourceOf(expected)).toBe(fixture);
    });
  }

  it("recognizes supported math delimiters", () => {
    const events = parseMarkdownMath("$a$ $$b$$ \\(c\\) \\[d\\]");
    expect(events.filter((event) => event.type === "math")).toEqual([
      expect.objectContaining({ kind: "inline", tex: "a", delimiter: "$" }),
      expect.objectContaining({ kind: "display", tex: "b", delimiter: "$$" }),
      expect.objectContaining({ kind: "inline", tex: "c", delimiter: "\\(" }),
      expect.objectContaining({ kind: "display", tex: "d", delimiter: "\\[" }),
    ]);
  });

  it("does not interpret currency, escaped delimiters, or code as math", () => {
    const source = "The fees are $5.00 and $10.00. \\$escaped$ `code $x$`\n```tex\n$y$\n```";
    const events = parseMarkdownMath(source);
    expect(events.some((event) => event.type === "math")).toBe(false);
    expect(sourceOf(events)).toBe(source);
  });

  it("returns unmatched delimiters as exact text", () => {
    for (const source of ["before $unclosed", "before \\(unclosed", "before $$unclosed"] as const) {
      const events = parseMarkdownMath(source);
      expect(events.some((event) => event.type === "math")).toBe(false);
      expect(sourceOf(events)).toBe(source);
    }
  });

  it("renders every event through the exact-source fallback", async () => {
    const source = "Result: $$E = mc^2$$.";
    await expect(
      renderExactSource(parseMarkdownMath(source), new ExactSourceMathRenderer()),
    ).resolves.toBe(source);
    expect(GRAPHICS_CAPABILITY).toMatchObject({
      mathJaxSvg: true,
      resvg: true,
      kitty: false,
      iterm2: true,
    });
  });

  it("offers the local bounded MathJax backend without replacing source fallback", async () => {
    const event = parseMarkdownMath("\\[\\frac{a}{b}\\]").find(
      (candidate) => candidate.type === "math",
    );
    expect(event?.type).toBe("math");
    if (event?.type !== "math") return;

    const artifact = await new MathJaxSvgMathRenderer().render(event);
    expect(artifact.format).toBe("svg");
    expect(artifact.content).toMatch(/^<svg\b/u);
    expect(artifact.content).not.toMatch(/<(?:script|foreignObject)\b/iu);
    await expect(new ExactSourceMathRenderer().render(event)).resolves.toEqual({
      format: "source",
      content: event.source,
    });
  });

  it("styles Markdown and math only in interactive themed presentation", () => {
    const source = "# Result\n\n$E=mc^2$\n";
    const events = parseMarkdownMath(source);
    const theme = createTheme("dark", { isTTY: true, env: {} });
    const rendered = renderTerminalPresentation(events, { theme, interactive: true });

    expect(rendered).toContain("\u001b[");
    expect(rendered).toContain("E=mc^2");
    expect(renderTerminalPresentation(events, { theme, interactive: false })).toBe(source);
    expect(renderTerminalPresentation(events, { theme, interactive: true, accessible: true })).toBe(
      source,
    );
  });
});

describe("terminal control safety", () => {
  it("makes terminal controls visible without removing ordinary whitespace", () => {
    const unsafe = "safe\u001b]0;owned\u0007\nnext\tcell";
    const escaped = escapeUnsafeTerminalControls(unsafe);
    expect(hasTerminalEscape(escaped)).toBe(false);
    expect(escaped).toBe("safe\\u{001b}]0;owned\\u{0007}\nnext\tcell");
  });

  it("keeps carriage returns for the one-shot parser but neutralizes them for display", () => {
    const spoof = "SAFE-PREFIX\rSPOOFED";

    // The shared escape must preserve U+000D: the one-shot path feeds its output to the
    // incremental parser, which relies on a trailing `\r` to normalize CRLF fenced-block lines.
    expect(escapeUnsafeTerminalControls(spoof)).toBe(spoof);

    // The display projection removes the cursor motion, so the prefix cannot be overwritten.
    const shown = neutralizeCarriageReturnsForDisplay(escapeUnsafeTerminalControls(spoof));
    expect(shown).toBe("SAFE-PREFIX\\u{000d}SPOOFED");
    expect(shown).not.toContain("\r");
  });

  it("treats a CRLF as a line ending rather than a cursor move when projecting for display", () => {
    // Collapsing to `\n` matches what a terminal already shows and keeps line structure intact,
    // while tabs survive as layout.
    expect(neutralizeCarriageReturnsForDisplay("a\r\nb\tc\rd")).toBe("a\nb\tc\\u{000d}d");
  });
});
