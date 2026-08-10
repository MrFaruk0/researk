import { type MathRenderEvent, parseMarkdownMath } from "../rendering/parser.js";
import {
  type ConversationEntry,
  MAX_CHAT_MESSAGE_CHARACTERS,
  MAX_TUI_CONVERSATION_ENTRIES,
} from "./state.js";

/** The largest formula index retained from one conversation snapshot. */
export const MAX_FORMULA_REFS = 10_000;

/**
 * A stable identity for a formula is its owning conversation entry and UTF-16 source offset.
 * The delimiter and source are intentionally retained so a later presentation layer can reveal or
 * copy the exact canonical event rather than reconstructing it from TeX.
 */
export interface FormulaRef {
  /** Stable key for this formula: `${entryId}:${sourceStart}`. */
  readonly key: string;
  readonly entryId: string;
  /** Zero-based position in the bounded, ordered formula index. */
  readonly ordinal: number;
  /** UTF-16 code-unit offsets into `ConversationEntry.source`. */
  readonly sourceStart: number;
  readonly sourceEnd: number;
  /** UTF-16 code-unit offsets into the owning source when the parser slice permits derivation. */
  readonly texStart: number | undefined;
  readonly texEnd: number | undefined;
  /** Exact event slices from the canonical source. */
  readonly source: string;
  readonly tex: string;
  readonly delimiter: MathRenderEvent["delimiter"];
  readonly kind: MathRenderEvent["kind"];
}

export type FormulaSelection = FormulaRef | string | null | undefined;

/**
 * Build an ordered index of complete math events from assistant entries only.
 *
 * `parseMarkdownMath` returns unmatched delimiters as text, so incomplete constructs are naturally
 * excluded. Event source lengths are accumulated without normalization; JavaScript string offsets
 * therefore remain UTF-16 code-unit offsets suitable for exact `slice` calls.
 */
export function indexConversationFormulas(
  conversation: readonly ConversationEntry[],
): readonly FormulaRef[] {
  const firstEntry = Math.max(0, conversation.length - MAX_TUI_CONVERSATION_ENTRIES);
  const refs: FormulaRef[] = [];

  for (let entryIndex = firstEntry; entryIndex < conversation.length; entryIndex += 1) {
    if (refs.length >= MAX_FORMULA_REFS) break;
    const entry = conversation[entryIndex];
    if (entry === undefined || entry.role !== "assistant") continue;

    // Conversation state already enforces this limit. Skipping an over-limit external snapshot
    // keeps this pure helper bounded when called with an arbitrary transcript.
    if (entry.source.length > MAX_CHAT_MESSAGE_CHARACTERS) continue;

    const events = parseMarkdownMath(entry.source);
    let sourceOffset = 0;
    for (const event of events) {
      const sourceStart = sourceOffset;
      sourceOffset += event.source.length;
      if (event.type !== "math") continue;
      if (refs.length >= MAX_FORMULA_REFS) break;

      const sourceEnd = sourceOffset;
      const texBounds = deriveTexBounds(event);
      refs.push({
        key: `${entry.id}:${sourceStart}`,
        entryId: entry.id,
        ordinal: refs.length,
        sourceStart,
        sourceEnd,
        texStart: texBounds === undefined ? undefined : texBounds[0] + sourceStart,
        texEnd: texBounds === undefined ? undefined : texBounds[1] + sourceStart,
        source: event.source,
        tex: event.tex,
        delimiter: event.delimiter,
        kind: event.kind,
      });
    }
  }

  return refs;
}

/** Alias emphasizing that the result is a bounded, ordered index. */
export const buildFormulaIndex = indexConversationFormulas;

/** Look up a current formula by stable key or by a ref from an earlier snapshot. */
export function lookupFormula(
  formulas: readonly FormulaRef[],
  selection: FormulaSelection,
): FormulaRef | undefined {
  const key = typeof selection === "string" ? selection : selection?.key;
  if (key === undefined) return undefined;
  return formulas.find((formula) => formula.key === key);
}

export function firstFormula(formulas: readonly FormulaRef[]): FormulaRef | undefined {
  return formulas[0];
}

export function lastFormula(formulas: readonly FormulaRef[]): FormulaRef | undefined {
  return formulas.at(-1);
}

/**
 * Select the next formula in document order. Empty or stale selections start at the first formula;
 * moving beyond the last formula clamps to the last formula.
 */
export function nextFormula(
  formulas: readonly FormulaRef[],
  selection: FormulaSelection,
): FormulaRef | undefined {
  if (formulas.length === 0) return undefined;
  const current = lookupFormula(formulas, selection);
  if (current === undefined) return firstFormula(formulas);
  return formulas[Math.min(current.ordinal + 1, formulas.length - 1)];
}

/**
 * Select the previous formula in document order. Empty or stale selections start at the last
 * formula; moving before the first formula clamps to the first formula.
 */
export function previousFormula(
  formulas: readonly FormulaRef[],
  selection: FormulaSelection,
): FormulaRef | undefined {
  if (formulas.length === 0) return undefined;
  const current = lookupFormula(formulas, selection);
  if (current === undefined) return lastFormula(formulas);
  return formulas[Math.max(current.ordinal - 1, 0)];
}

/**
 * Reconcile a selection after a new index is built. A live key resolves directly. A stale ref uses
 * its former ordinal as a deterministic nearest position and clamps to the available range; an
 * unknown key or no selection falls back to the first formula.
 */
export function reconcileFormulaSelection(
  formulas: readonly FormulaRef[],
  selection: FormulaSelection,
): FormulaRef | undefined {
  if (formulas.length === 0) return undefined;
  const current = lookupFormula(formulas, selection);
  if (current !== undefined) return current;
  if (typeof selection !== "string" && selection !== null && selection !== undefined) {
    const ordinal = Number.isFinite(selection.ordinal) ? Math.max(0, selection.ordinal) : 0;
    return formulas[Math.min(Math.trunc(ordinal), formulas.length - 1)];
  }
  return firstFormula(formulas);
}

/**
 * Wrap an edited inner-TeX draft for insertion. Ordinary delimiters use the selected event's
 * matching closer. A valid `math` fence is reconstructed with its original opening/closing lines;
 * if that would be unsafe (for example, the draft contains a closing fence) the helper uses a
 * standalone `math` fence whose backtick marker is longer than every backtick run in the draft.
 * This deterministic fallback is recognized by the formula indexer and round-trips the draft
 * exactly, including multiline and trailing carriage-return input. The original ref is untouched.
 */
export function wrapFormulaDraft(ref: FormulaRef, draft: string): string {
  switch (ref.delimiter) {
    case "$":
      return isSafeInlineDollarDraft(draft) ? `$${draft}$` : wrapInSafeMathFence(draft);
    case "$$":
      return draft.includes("$$") ? wrapInSafeMathFence(draft) : `$$${draft}$$`;
    case "\\(":
      return draft.includes("\\)") ? wrapInSafeMathFence(draft) : `\\(${draft}\\)`;
    case "\\[":
      return draft.includes("\\]") ? wrapInSafeMathFence(draft) : `\\[${draft}\\]`;
    case "math-fence":
      return reconstructMathFence(ref, draft) ?? wrapInSafeMathFence(draft);
  }
}

function isSafeInlineDollarDraft(draft: string): boolean {
  if (draft.length === 0 || draft.includes("$")) return false;
  return !/^\s/u.test(draft) && !/\s$/u.test(draft);
}

function wrapInSafeMathFence(draft: string): string {
  const markerLength = Math.max(3, longestRun(draft, "`") + 1);
  const marker = "`".repeat(markerLength);
  // The parser removes one terminal CRLF/LF from a fenced body's raw source. A lone trailing CR
  // therefore needs a CRLF separator so that the CR remains part of `tex` after that removal.
  const separator = draft.endsWith("\r") ? "\r\n" : "\n";
  return `${marker}math\n${draft}${separator}${marker}\n`;
}

function longestRun(source: string, character: string): number {
  let longest = 0;
  let current = 0;
  for (const value of source) {
    if (value === character) {
      current += 1;
      longest = Math.max(longest, current);
    } else {
      current = 0;
    }
  }
  return longest;
}

function deriveTexBounds(event: MathRenderEvent): readonly [number, number] | undefined {
  const { source, tex } = event;
  switch (event.delimiter) {
    case "$":
      return source.length >= 2 && source.slice(1, -1) === tex ? [1, source.length - 1] : undefined;
    case "$$":
      return source.length >= 4 && source.slice(2, -2) === tex ? [2, source.length - 2] : undefined;
    case "\\(":
      return source.length >= 4 && source.slice(2, -2) === tex ? [2, source.length - 2] : undefined;
    case "\\[":
      return source.length >= 4 && source.slice(2, -2) === tex ? [2, source.length - 2] : undefined;
    case "math-fence":
      return deriveMathFenceTexBounds(source, tex);
  }
}

function deriveMathFenceTexBounds(
  source: string,
  tex: string,
): readonly [number, number] | undefined {
  const openingLineEnd = source.indexOf("\n");
  if (openingLineEnd < 0) return undefined;
  const openingLine = source.slice(0, openingLineEnd).replace(/\r$/u, "");
  const opening = /^( {0,3})(`{3,}|~{3,})[^\r\n]*$/u.exec(openingLine);
  if (opening === null) return undefined;

  const texStart = openingLineEnd + 1;
  const texEnd = texStart + tex.length;
  if (source.slice(texStart, texEnd) !== tex) return undefined;

  const marker = opening[2];
  if (marker === undefined) return undefined;
  const markerCharacter = marker[0];
  if (markerCharacter === undefined) return undefined;
  const closing = new RegExp(
    `^(?:\\r?\\n)? {0,3}${escapeRegExp(markerCharacter)}{${marker.length},}[ \\t]*(?:\\r?\\n)?$`,
    "u",
  );
  return closing.test(source.slice(texEnd)) ? [texStart, texEnd] : undefined;
}

function reconstructMathFence(ref: FormulaRef, draft: string): string | undefined {
  if (ref.texStart === undefined || ref.texEnd === undefined) return undefined;
  const localTexStart = ref.texStart - ref.sourceStart;
  const localTexEnd = ref.texEnd - ref.sourceStart;
  if (
    localTexStart < 0 ||
    localTexEnd < localTexStart ||
    ref.source.slice(localTexStart, localTexEnd) !== ref.tex
  ) {
    return undefined;
  }

  const openingLineEnd = ref.source.indexOf("\n");
  if (openingLineEnd < 0) return undefined;
  const openingLine = ref.source.slice(0, openingLineEnd).replace(/\r$/u, "");
  const opening = /^( {0,3})(`{3,}|~{3,})[^\r\n]*$/u.exec(openingLine);
  const marker = opening?.[2];
  const markerCharacter = marker?.[0];
  if (marker === undefined || markerCharacter === undefined) return undefined;

  const closingLine = new RegExp(
    `^ {0,3}${escapeRegExp(markerCharacter)}{${marker.length},}[ \\t]*$`,
    "u",
  );
  for (const line of draft.split(/\r?\n/u)) {
    if (closingLine.test(line.replace(/\r$/u, ""))) return undefined;
  }

  const prefix = ref.source.slice(0, localTexStart);
  const suffix = ref.source.slice(localTexEnd);
  // An empty fenced body may have its closing marker immediately after the opening newline. A
  // non-empty replacement needs a line break before that marker; otherwise use the safe display
  // fallback instead of manufacturing an invalid one-line fence.
  if (draft.length > 0 && !/(?:\r\n|\n)$/u.test(draft) && !/^(?:\r\n|\n)/u.test(suffix)) {
    return undefined;
  }
  return `${prefix}${draft}${suffix}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
