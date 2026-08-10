import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { HintLine, Panel } from "../components/Panel.js";
import type { FormulaRef } from "../formulas.js";
import { displayText } from "../state.js";
import { type TuiTheme, themeColor } from "../theme.js";

const CURSOR_BLOCK = "\u2588";
const DEFAULT_FORMULA_COUNT = 0;

const formulaGraphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Actions the surrounding App can route to the formula overlay. */
export type FormulaOverlayAction =
  | "previous"
  | "next"
  | "copy"
  | "edit"
  | "insert"
  | "reveal-source"
  | "close";

/** Shared display and selection data for both formula overlay views. */
export interface FormulaOverlayBaseProps {
  readonly theme: TuiTheme;
  /** The immutable indexed formula currently selected by the parent. */
  readonly formula: FormulaRef | undefined;
  /** One-based position shown in the title. Defaults to `formula.ordinal + 1`. */
  readonly position?: number | undefined;
  /** Total number of indexed formulas. Defaults to the selected position. */
  readonly count?: number | undefined;
  /** Optional renderer-owned preview. The overlay does not interpret or mutate this node. */
  readonly preview?: ReactNode;
  /** Label for a renderer-owned preview, including its exact-source fallback semantics. */
  readonly previewLabel?: string | undefined;
  /** Exact source to show when the preview is unavailable or when the user asks for source. */
  readonly exactSource?: string | undefined;
  /** Label for the exact-source fallback (for example, when typesetting is unsupported). */
  readonly sourceLabel?: string | undefined;
  /** Optional dimensions supplied by the bounded App overlay region. */
  readonly width?: number | undefined;
  readonly height?: number | undefined;
}

export interface FormulaOverlayBrowseProps extends FormulaOverlayBaseProps {
  readonly mode?: "browse" | undefined;
  readonly onPrevious?: (() => void) | undefined;
  readonly onNext?: (() => void) | undefined;
  /** Receives the exact canonical source, not TeX reconstructed from the preview. */
  readonly onCopy?: ((source: string) => void | Promise<void>) | undefined;
  /** Starts a local draft; the parent remains the owner of immutable conversation state. */
  readonly onEdit?: ((formula: FormulaRef) => void) | undefined;
  /** Receives exact source for insertion into the composer. */
  readonly onInsert?: ((source: string) => void) | undefined;
  /** Reveals exact source through the parent source view. */
  readonly onRevealSource?: ((source: string) => void) | undefined;
  readonly onClose?: (() => void) | undefined;
}

export interface FormulaOverlayEditProps extends FormulaOverlayBaseProps {
  readonly mode: "edit";
  /** Local inner-TeX draft. The canonical formula source is never changed by this view. */
  readonly draft: string;
  /** Cursor is a UTF-16 code-unit offset, clamped to a grapheme boundary for display. */
  readonly cursor: number;
  readonly onDraftChange?: ((draft: string, cursor: number) => void) | undefined;
  /** Applies the local draft and lets the parent rebuild the renderer-owned preview. */
  readonly onApply?: ((draft: string) => void | Promise<void>) | undefined;
  readonly onCancel?: (() => void) | undefined;
}

export type FormulaOverlayProps = FormulaOverlayBrowseProps | FormulaOverlayEditProps;

/**
 * Clamps a formula cursor without splitting a grapheme. This mirrors the composer's terminal-safe
 * cursor behavior while retaining the UTF-16 offsets used by canonical formula indexing.
 */
export function formulaCursorOffset(value: string, cursor: number): number {
  const requested = Number.isFinite(cursor)
    ? Math.min(Math.max(Math.trunc(cursor), 0), value.length)
    : 0;
  for (const item of formulaGraphemes.segment(value)) {
    const end = item.index + item.segment.length;
    if (requested > item.index && requested < end) return end;
  }
  return requested;
}

/** Returns the safe terminal projection of a local TeX draft with a visible cursor block. */
export function formulaInputText(value: string, cursor: number): string {
  const safeCursor = formulaCursorOffset(value, cursor);
  return `${displayText(value.slice(0, safeCursor))}${CURSOR_BLOCK}${displayText(
    value.slice(safeCursor),
  )}`;
}

/** Alias emphasizing that this helper is the edit-view cursor projection. */
export const formulaCursorText = formulaInputText;

/**
 * Returns a bounded integer dimension. Invalid dimensions are ignored rather than reaching Ink,
 * which keeps tiny-terminal callers from producing negative or NaN layout values.
 */
export function formulaOverlayDimension(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return Math.max(1, Math.trunc(fallback));
  return Math.max(1, Math.trunc(value));
}

function formulaTitle(props: FormulaOverlayBaseProps): string {
  if (props.formula === undefined) return "Formula · none";
  const fallback = props.formula.ordinal + 1;
  const position = boundedCount(props.position ?? fallback, fallback);
  const count = Math.max(fallback, boundedCount(props.count ?? fallback, fallback));
  return `Formula ${Math.min(position, count)} of ${count}`;
}

function boundedCount(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return Math.max(DEFAULT_FORMULA_COUNT, Math.trunc(fallback));
  return Math.max(DEFAULT_FORMULA_COUNT, Math.trunc(value));
}

function formulaSource(props: FormulaOverlayBaseProps): string {
  return props.exactSource ?? props.formula?.source ?? "";
}

function formulaBody(props: FormulaOverlayBaseProps): ReactNode {
  const muted = themeColor(props.theme, "muted");
  const formula = props.formula;
  if (formula === undefined) {
    return <Text {...(muted === undefined ? {} : { color: muted })}>No formula selected.</Text>;
  }

  if (props.preview !== undefined) {
    return (
      <Box flexDirection="column">
        <Text {...(muted === undefined ? {} : { color: muted })}>
          {props.previewLabel ?? "Typeset preview · exact source fallback"}
        </Text>
        <Box marginTop={1} flexDirection="column" overflow="hidden">
          {props.preview}
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text {...(muted === undefined ? {} : { color: muted })}>
        {props.sourceLabel ?? "Exact source"}
      </Text>
      <Text wrap="truncate-end">{displayText(formulaSource(props))}</Text>
    </Box>
  );
}

function browseHints(): string {
  return "Up/Down or j/k navigate · c copy source · e edit/rerender\ni insert · s source · Esc close";
}

function editHints(): string {
  return "Left/Right · Backspace · Ctrl+J newline\nEnter apply/rerender · Esc cancel";
}

function compactSource(value: string): string {
  // A tiny terminal cannot preserve source line breaks without hiding the close/cancel affordance.
  // Whitespace is presentation-only here; the exact source supplied to copy/insert is untouched.
  return displayText(value)
    .replace(/[\t\r\n ]+/gu, " ")
    .trim();
}

function compactHint(mode: "browse" | "edit"): string {
  return mode === "edit" ? "Esc cancel · Enter apply" : "Esc close · c copy · e edit";
}

function compactLines(props: FormulaOverlayProps, height: number): readonly string[] {
  const formula = props.formula;
  const source = compactSource(formulaSource(props));
  const tex = compactSource(props.mode === "edit" ? props.draft : (formula?.tex ?? ""));
  const title = formulaTitle(props);
  const hint = compactHint(props.mode === "edit" ? "edit" : "browse");
  const label =
    props.preview === undefined
      ? (props.sourceLabel ?? "Exact source")
      : (props.previewLabel ?? "Typeset preview · exact source fallback");
  const compactLabel = compactSource(label);

  if (height <= 1) {
    const value = props.mode === "edit" ? tex : source;
    // Keep the close/cancel affordance and a useful source projection visible even when the
    // terminal can render only one row. The full status label is intentionally omitted here;
    // height 2+ has room for it without truncating the formula itself.
    return [`${hint} · ${props.mode === "edit" ? "TeX" : "exact source"}: ${value}`];
  }
  if (height === 2) {
    return [
      `${props.mode === "edit" ? "TeX" : compactLabel}: ${props.mode === "edit" ? tex : source}`,
      hint,
    ];
  }
  if (height === 3) {
    return [
      title,
      `${props.mode === "edit" ? "TeX" : compactLabel}: ${props.mode === "edit" ? tex : source}`,
      hint,
    ];
  }
  if (props.mode === "edit") {
    const lines = [title, `TeX: ${tex}`, `${compactLabel}: ${source}`, hint];
    return height === 4 ? lines : [...lines, "Ctrl+J newline · Backspace delete"];
  }
  const lines = [title, `TeX: ${tex}`, `${compactLabel}: ${source}`, hint];
  return height === 4 ? lines : [...lines, "s source · i insert"];
}

function renderCompact(props: FormulaOverlayProps, height: number, width: number): ReactNode {
  const muted = themeColor(props.theme, "muted");
  return (
    <Box flexDirection="column" width={width} height={height} overflow="hidden">
      {compactLines(props, height).map((line) => (
        <Text key={line} wrap="truncate-end" {...(muted === undefined ? {} : { color: muted })}>
          {line}
        </Text>
      ))}
    </Box>
  );
}

function renderBrowse(props: FormulaOverlayBrowseProps): ReactNode {
  const accent = themeColor(props.theme, "accent");
  const panelWidth = props.width === undefined ? {} : { width: props.width };
  return (
    <Panel theme={props.theme} title={formulaTitle(props)} {...panelWidth}>
      <Box>
        <Text {...(accent === undefined ? {} : { color: accent })}>TeX </Text>
        <Text wrap="truncate-end">
          {props.formula === undefined ? " " : displayText(props.formula.tex)}
        </Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        {formulaBody(props)}
      </Box>
      <HintLine theme={props.theme} text={browseHints()} />
    </Panel>
  );
}

function renderEdit(props: FormulaOverlayEditProps): ReactNode {
  const accent = themeColor(props.theme, "accent");
  const muted = themeColor(props.theme, "muted");
  const panelWidth = props.width === undefined ? {} : { width: props.width };
  return (
    <Panel theme={props.theme} title={formulaTitle(props)} {...panelWidth}>
      <Text {...(muted === undefined ? {} : { color: muted })}>
        Local draft · assistant source unchanged
      </Text>
      <Box marginTop={1} flexDirection="column">
        <Box>
          <Text {...(accent === undefined ? {} : { color: accent })}>TeX </Text>
          <Text wrap="truncate-end">{formulaInputText(props.draft, props.cursor)}</Text>
        </Box>
        {props.preview === undefined ? (
          <Box marginTop={1} flexDirection="column">
            <Text {...(muted === undefined ? {} : { color: muted })}>
              {props.sourceLabel ?? "Exact source"}
            </Text>
            <Text wrap="truncate-end">{displayText(formulaSource(props))}</Text>
          </Box>
        ) : (
          <Box marginTop={1} flexDirection="column" overflow="hidden">
            <Text {...(muted === undefined ? {} : { color: muted })}>
              {props.previewLabel ?? "Typeset preview · exact source fallback"}
            </Text>
            <Box marginTop={1} flexDirection="column" overflow="hidden">
              {props.preview}
            </Box>
          </Box>
        )}
      </Box>
      <HintLine theme={props.theme} text={editHints()} />
    </Panel>
  );
}

/**
 * Bounded formula browse/edit chrome. Input routing intentionally remains in App: callbacks in the
 * prop surface let App copy, insert, navigate, or manage a local draft without giving this view
 * authority to mutate canonical conversation entries.
 */
export function FormulaOverlay(props: FormulaOverlayProps): ReactNode {
  const width = props.width === undefined ? undefined : formulaOverlayDimension(props.width, 1);
  const height = props.height === undefined ? undefined : formulaOverlayDimension(props.height, 1);
  if (width !== undefined && height !== undefined && height <= 5) {
    return renderCompact(props, height, width);
  }
  const content = props.mode === "edit" ? renderEdit(props) : renderBrowse(props);

  if (width === undefined && height === undefined) return content;
  return (
    <Box
      flexDirection="column"
      {...(width === undefined ? {} : { width })}
      {...(height === undefined ? {} : { height })}
      overflow="hidden"
    >
      {content}
    </Box>
  );
}
