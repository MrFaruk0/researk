import { describe, expect, it } from "vitest";
import {
  IncrementalMarkdownMathParser,
  type MarkdownRenderEvent,
  parseMarkdownMath,
} from "../src/rendering/parser.js";
import {
  ExactSourceMathRenderer,
  GRAPHICS_CAPABILITY,
  renderExactSource,
} from "../src/rendering/renderer.js";
import { escapeUnsafeTerminalControls, hasTerminalEscape } from "../src/safety.js";

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
      mathJaxSvg: false,
      resvg: false,
      kitty: false,
      iterm2: false,
    });
  });
});

describe("terminal control safety", () => {
  it("makes terminal controls visible without removing ordinary whitespace", () => {
    const unsafe = "safe\u001b]0;owned\u0007\nnext\tcell";
    const escaped = escapeUnsafeTerminalControls(unsafe);
    expect(hasTerminalEscape(escaped)).toBe(false);
    expect(escaped).toBe("safe\\u{001b}]0;owned\\u{0007}\nnext\tcell");
  });
});
