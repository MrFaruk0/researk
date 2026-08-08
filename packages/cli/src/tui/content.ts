import { parseMarkdownMath } from "../rendering/parser.js";

export type ContentSegmentKind = "text" | "code" | "inline-math" | "citation";

export interface ContentSegment {
  readonly kind: ContentSegmentKind;
  readonly text: string;
}

export type ContentBlock =
  | { readonly kind: "paragraph"; readonly segments: readonly ContentSegment[] }
  | { readonly kind: "heading"; readonly level: number; readonly text: string }
  | { readonly kind: "list-item"; readonly marker: string; readonly text: string }
  | { readonly kind: "quote"; readonly text: string }
  | { readonly kind: "code-block"; readonly language: string; readonly lines: readonly string[] }
  | { readonly kind: "display-math"; readonly source: string; readonly tex: string }
  | { readonly kind: "blank" };

/**
 * Classifies canonical assistant source into presentation blocks for the TUI.
 *
 * The canonical text is never rewritten: every block carries the exact substring it came from, so
 * `/source` and Harness state remain byte-identical. Display math is separated into its own block so
 * it can be shown on its own lines, and no terminal graphics protocol is emitted, which keeps Ink's
 * retained layout intact.
 */
export function classifyContent(source: string): readonly ContentBlock[] {
  const events = parseMarkdownMath(source);
  const blocks: ContentBlock[] = [];
  // Line-oriented buffer of inline segments belonging to the current logical line.
  let line: ContentSegment[] = [];

  const flushLine = (): void => {
    if (line.length === 0) return;
    const segments = line;
    line = [];
    blocks.push(...classifyLine(segments));
  };

  for (const event of events) {
    if (event.type === "math" && event.kind === "display") {
      flushLine();
      blocks.push({ kind: "display-math", source: event.source, tex: event.tex });
      continue;
    }
    if (event.type === "math") {
      line.push({ kind: "inline-math", text: event.source });
      continue;
    }
    if (event.type === "code") {
      const fenced = readFencedCode(event.source);
      if (fenced !== undefined) {
        flushLine();
        blocks.push(fenced);
        continue;
      }
      line.push({ kind: "code", text: event.source });
      continue;
    }
    // Text events arrive one code point at a time from the incremental parser.
    if (event.source === "\n") {
      flushLine();
      blocks.push({ kind: "blank" });
      continue;
    }
    if (event.source === "\r") continue;
    const last = line.at(-1);
    if (last !== undefined && last.kind === "text") {
      line[line.length - 1] = { kind: "text", text: last.text + event.source };
    } else {
      line.push({ kind: "text", text: event.source });
    }
  }
  flushLine();
  return collapseTrailingBlanks(blocks);
}

function classifyLine(segments: readonly ContentSegment[]): readonly ContentBlock[] {
  const first = segments[0];
  if (first !== undefined && first.kind === "text") {
    const heading = /^(#{1,6})\s+(.*)$/u.exec(first.text);
    if (heading !== null && segments.length === 1) {
      return [{ kind: "heading", level: heading[1]?.length ?? 1, text: heading[2] ?? "" }];
    }
    const quote = /^>\s?(.*)$/u.exec(first.text);
    if (quote !== null && segments.length === 1) {
      return [{ kind: "quote", text: quote[1] ?? "" }];
    }
    const list = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/u.exec(first.text);
    if (list !== null) {
      const rest = [
        { kind: "text" as const, text: list[3] ?? "" },
        ...segments.slice(1),
      ] satisfies ContentSegment[];
      return [
        {
          kind: "list-item",
          marker: `${list[1] ?? ""}${list[2] ?? "-"}`,
          text: rest.map((segment) => segment.text).join(""),
        },
      ];
    }
  }
  return [{ kind: "paragraph", segments: withCitations(segments) }];
}

/**
 * Marks bracketed numeric or author-year references so citations can be styled distinctly. The text
 * is preserved exactly; only the segment boundaries change.
 */
function withCitations(segments: readonly ContentSegment[]): readonly ContentSegment[] {
  const result: ContentSegment[] = [];
  for (const segment of segments) {
    if (segment.kind !== "text") {
      result.push(segment);
      continue;
    }
    const pattern = /\[(?:\d+(?:\s*[,-]\s*\d+)*|[^\]\n]{1,80}?,\s*\d{4}[a-z]?)\]/gu;
    let cursor = 0;
    for (const match of segment.text.matchAll(pattern)) {
      const index = match.index;
      if (index > cursor) result.push({ kind: "text", text: segment.text.slice(cursor, index) });
      result.push({ kind: "citation", text: match[0] });
      cursor = index + match[0].length;
    }
    if (cursor < segment.text.length) {
      result.push({ kind: "text", text: segment.text.slice(cursor) });
    }
  }
  return result.length === 0 ? segments : result;
}

function readFencedCode(source: string): ContentBlock | undefined {
  const match = /^( {0,3})(`{3,}|~{3,})([^\n]*)\n?([\s\S]*)$/u.exec(source);
  if (match === null) return undefined;
  const body = match[4] ?? "";
  const lines = body.split("\n");
  // Drop the closing fence line and the empty remainder after a trailing newline.
  while (lines.length > 0) {
    const last = lines.at(-1) ?? "";
    if (/^\s*(`{3,}|~{3,})\s*$/u.test(last) || last.length === 0) {
      lines.pop();
      continue;
    }
    break;
  }
  return { kind: "code-block", language: (match[3] ?? "").trim(), lines };
}

function collapseTrailingBlanks(blocks: readonly ContentBlock[]): readonly ContentBlock[] {
  let end = blocks.length;
  while (end > 0 && blocks[end - 1]?.kind === "blank") end -= 1;
  return blocks.slice(0, end);
}
