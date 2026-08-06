export interface TextRenderEvent {
  readonly type: "text";
  readonly source: string;
}

export interface CodeRenderEvent {
  readonly type: "code";
  readonly source: string;
}

export interface MathRenderEvent {
  readonly type: "math";
  readonly kind: "inline" | "display";
  readonly source: string;
  readonly tex: string;
  readonly delimiter: "$" | "$$" | "\\(" | "\\[" | "math-fence";
}

export type MarkdownRenderEvent = TextRenderEvent | CodeRenderEvent | MathRenderEvent;

export class IncrementalMarkdownMathParser {
  readonly #decoder = new TextDecoder();
  #pending = "";
  #finished = false;
  #atLineStart = true;
  #lineIndent = 0;
  #trailingBackslashes = 0;

  push(chunk: string | Uint8Array): readonly MarkdownRenderEvent[] {
    if (this.#finished) {
      throw new Error("Cannot push after the parser is finished");
    }
    this.#pending +=
      typeof chunk === "string"
        ? this.#decoder.decode() + chunk
        : this.#decoder.decode(chunk, { stream: true });
    return this.#drain(false);
  }

  finish(): readonly MarkdownRenderEvent[] {
    if (this.#finished) {
      return [];
    }
    this.#finished = true;
    this.#pending += this.#decoder.decode();
    return this.#drain(true);
  }

  #drain(final: boolean): MarkdownRenderEvent[] {
    const events: MarkdownRenderEvent[] = [];

    while (this.#pending.length > 0) {
      const fence = this.#readFence(final);
      if (fence === "wait") {
        break;
      }
      if (fence !== undefined) {
        events.push(fence.event);
        this.#consume(fence.length);
        continue;
      }

      const inlineCode = this.#readInlineCode(final);
      if (inlineCode === "wait") {
        break;
      }
      if (inlineCode !== undefined) {
        events.push({ type: "code", source: inlineCode.source });
        this.#consume(inlineCode.source.length);
        continue;
      }

      const math = this.#readMath(final);
      if (math === "wait") {
        break;
      }
      if (math !== undefined) {
        events.push(math);
        this.#consume(math.source.length);
        continue;
      }

      const first = this.#firstCodePoint(final);
      if (first === undefined) {
        break;
      }
      events.push({ type: "text", source: first });
      this.#consume(first.length);
    }

    return events;
  }

  #readFence(
    final: boolean,
  ):
    | { readonly event: CodeRenderEvent | MathRenderEvent; readonly length: number }
    | "wait"
    | undefined {
    if (!this.#atLineStart || this.#lineIndent > 3) {
      return undefined;
    }

    const marker = this.#pending[0];
    if (marker !== "`" && marker !== "~") {
      return undefined;
    }

    const markerLength = countRun(this.#pending, 0, marker);
    if (markerLength < 3) {
      return !final && markerLength === this.#pending.length ? "wait" : undefined;
    }

    const openingLineEnd = this.#pending.indexOf("\n", markerLength);
    if (openingLineEnd < 0) {
      return final ? undefined : "wait";
    }

    const info = this.#pending.slice(markerLength, openingLineEnd).trim().toLowerCase();
    let lineStart = openingLineEnd + 1;
    while (lineStart < this.#pending.length) {
      const lineEnd = this.#pending.indexOf("\n", lineStart);
      const end = lineEnd < 0 ? this.#pending.length : lineEnd;
      const line = this.#pending.slice(lineStart, end).replace(/\r$/u, "");
      const match = /^( {0,3})(`+|~+)[ \t]*$/u.exec(line);
      if (match !== null && match[2]?.[0] === marker && match[2].length >= markerLength) {
        if (lineEnd < 0 && !final) {
          return "wait";
        }
        const sourceEnd = lineEnd < 0 ? end : lineEnd + 1;
        const source = this.#pending.slice(0, sourceEnd);
        if (info === "math") {
          const rawTex = this.#pending.slice(openingLineEnd + 1, lineStart);
          return {
            event: {
              type: "math",
              kind: "display",
              source,
              tex: rawTex.replace(/\r?\n$/u, ""),
              delimiter: "math-fence",
            },
            length: sourceEnd,
          };
        }
        return { event: { type: "code", source }, length: sourceEnd };
      }
      if (lineEnd < 0) {
        break;
      }
      lineStart = lineEnd + 1;
    }

    return final ? undefined : "wait";
  }

  #readInlineCode(final: boolean): { readonly source: string } | "wait" | undefined {
    if (this.#pending[0] !== "`") {
      return undefined;
    }
    const openingLength = countRun(this.#pending, 0, "`");
    if (!final && openingLength === this.#pending.length) {
      return "wait";
    }

    let cursor = openingLength;
    while (cursor < this.#pending.length) {
      const found = this.#pending.indexOf("`", cursor);
      if (found < 0) {
        return final ? undefined : "wait";
      }
      const length = countRun(this.#pending, found, "`");
      if (length === openingLength) {
        return { source: this.#pending.slice(0, found + length) };
      }
      cursor = found + length;
    }
    return final ? undefined : "wait";
  }

  #readMath(final: boolean): MathRenderEvent | "wait" | undefined {
    if (this.#pending.startsWith("$$") && this.#trailingBackslashes % 2 === 0) {
      const close = findUnescaped(this.#pending, "$$", 2);
      if (close < 0) {
        return final ? undefined : "wait";
      }
      const source = this.#pending.slice(0, close + 2);
      return { type: "math", kind: "display", source, tex: source.slice(2, -2), delimiter: "$$" };
    }

    if (this.#pending[0] === "$" && this.#trailingBackslashes % 2 === 0) {
      if (this.#pending.length === 1) {
        return final ? undefined : "wait";
      }
      if (/^\$\d+(?:[.,]\d+)*(?=\s|[.,;:!?)]|$)/u.test(this.#pending)) {
        return undefined;
      }
      if (/\s/u.test(this.#pending[1] ?? "")) {
        return undefined;
      }
      let cursor = 1;
      while (cursor < this.#pending.length) {
        const close = this.#pending.indexOf("$", cursor);
        if (close < 0) {
          return final ? undefined : "wait";
        }
        const previous = this.#pending[close - 1] ?? "";
        const next = this.#pending[close + 1];
        if (!isEscaped(this.#pending, close) && !/\s/u.test(previous)) {
          if (next === undefined && !final) {
            return "wait";
          }
          if (next === undefined || !/\d/u.test(next)) {
            const source = this.#pending.slice(0, close + 1);
            return {
              type: "math",
              kind: "inline",
              source,
              tex: source.slice(1, -1),
              delimiter: "$",
            };
          }
        }
        cursor = close + 1;
      }
      return final ? undefined : "wait";
    }

    if (
      (this.#pending.startsWith("\\(") || this.#pending.startsWith("\\[")) &&
      this.#trailingBackslashes % 2 === 0
    ) {
      const display = this.#pending[1] === "[";
      const closer = display ? "\\]" : "\\)";
      const close = findUnescaped(this.#pending, closer, 2);
      if (close < 0) {
        return final ? undefined : "wait";
      }
      const source = this.#pending.slice(0, close + 2);
      return {
        type: "math",
        kind: display ? "display" : "inline",
        source,
        tex: source.slice(2, -2),
        delimiter: display ? "\\[" : "\\(",
      };
    }

    if (!final && (this.#pending === "\\" || this.#pending === "$")) {
      return "wait";
    }
    return undefined;
  }

  #firstCodePoint(final: boolean): string | undefined {
    const first = this.#pending.charCodeAt(0);
    if (!final && this.#pending.length === 1 && first >= 0xd800 && first <= 0xdbff) {
      return undefined;
    }
    const point = this.#pending.codePointAt(0);
    return point === undefined ? undefined : String.fromCodePoint(point);
  }

  #consume(length: number): void {
    const consumed = this.#pending.slice(0, length);
    this.#pending = this.#pending.slice(length);
    for (const character of consumed) {
      if (character === "\n") {
        this.#atLineStart = true;
        this.#lineIndent = 0;
      } else if (this.#atLineStart && character === " " && this.#lineIndent < 4) {
        this.#lineIndent += 1;
      } else {
        this.#atLineStart = false;
      }
      this.#trailingBackslashes = character === "\\" ? this.#trailingBackslashes + 1 : 0;
    }
  }
}

export function parseMarkdownMath(source: string): readonly MarkdownRenderEvent[] {
  const parser = new IncrementalMarkdownMathParser();
  return [...parser.push(source), ...parser.finish()];
}

function countRun(source: string, start: number, character: string): number {
  let cursor = start;
  while (source[cursor] === character) {
    cursor += 1;
  }
  return cursor - start;
}

function isEscaped(source: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && source[cursor] === "\\"; cursor -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

function findUnescaped(source: string, token: string, start: number): number {
  let cursor = start;
  while (cursor < source.length) {
    const found = source.indexOf(token, cursor);
    if (found < 0) {
      return -1;
    }
    if (!isEscaped(source, found)) {
      return found;
    }
    cursor = found + token.length;
  }
  return -1;
}
