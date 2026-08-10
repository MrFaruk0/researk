import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { discoverSlashCommands, type SlashCommand } from "../commands.js";
import { renderedRowCount } from "../layout.js";
import { type ComposerState, displayText } from "../state.js";
import { type TuiTheme, themeColor } from "../theme.js";

const CURSOR_BLOCK = "\u2588";
const PLACEHOLDER = "Ask a question, or type / for commands";
const DISABLED_PLACEHOLDER = "Ctrl+X cancel";
const composerGraphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function safeCursor(composer: ComposerState): number {
  const requested = Math.min(Math.max(composer.cursor, 0), composer.value.length);
  for (const item of composerGraphemes.segment(composer.value)) {
    const end = item.index + item.segment.length;
    if (requested > item.index && requested < end) return end;
  }
  return requested;
}

/** The exact display projection Ink receives for a non-empty composer. */
export function composerInputText(composer: ComposerState): string {
  const cursor = safeCursor(composer);
  return `${displayText(composer.value.slice(0, cursor))}${CURSOR_BLOCK}${displayText(
    composer.value.slice(cursor),
  )}`;
}

/** Measures the input rows using display cells rather than JavaScript string length. */
export function composerInputRows(
  composer: ComposerState,
  disabled: boolean,
  width: number,
): number {
  const inputWidth = Math.max(1, Math.trunc(width) - 5);
  const text =
    composer.value.length === 0
      ? disabled
        ? DISABLED_PLACEHOLDER
        : PLACEHOLDER
      : composerInputText(composer);
  return renderedRowCount(text, inputWidth);
}

function normalizedSuggestionBudget(value: number | undefined): number {
  if (value === undefined || value === Number.POSITIVE_INFINITY) return Number.MAX_SAFE_INTEGER;
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

function suggestionLine(command: SlashCommand): string {
  return `${command.name}  ${command.summary}`;
}

/**
 * Converts matches to a bounded, single-row-per-item presentation. The final row is an explicit
 * overflow indicator, so a short terminal never loses the fact that more commands exist.
 */
export function suggestionLines(
  input: string,
  maxSuggestionRows: number | undefined = undefined,
): readonly string[] {
  const suggestions = discoverSlashCommands(input);
  const budget = normalizedSuggestionBudget(maxSuggestionRows);
  if (suggestions.length === 0 || budget === 0) return [];
  if (suggestions.length <= budget) return suggestions.map(suggestionLine);
  const first = suggestions[0];
  if (first === undefined) return [];
  if (budget === 1) return [`${first.name}  +${suggestions.length - 1} more (Tab to complete)`];
  const visible = suggestions.slice(0, budget - 1).map(suggestionLine);
  visible.push(`… +${suggestions.length - visible.length} more (Tab to complete)`);
  return visible;
}

export function composerSuggestionRows(
  input: string,
  maxSuggestionRows: number | undefined = undefined,
): number {
  return suggestionLines(input, maxSuggestionRows).length;
}

export function Composer(props: {
  readonly theme: TuiTheme;
  readonly composer: ComposerState;
  readonly disabled: boolean;
  readonly width: number;
  /** Maximum number of suggestion rows; the input row is never included in this budget. */
  readonly maxSuggestionRows?: number | undefined;
}): ReactNode {
  const accent = themeColor(props.theme, "accent");
  const muted = themeColor(props.theme, "muted");
  const surface = themeColor(props.theme, "surface");
  const surfaceMuted = themeColor(props.theme, "surfaceMuted");
  const foreground = themeColor(props.theme, "foreground");
  const suggestions = suggestionLines(props.composer.value, props.maxSuggestionRows);
  const inputText = composerInputText(props.composer);

  return (
    <Box flexDirection="column" width={props.width} flexShrink={0}>
      {suggestions.length === 0 ? null : (
        <Box
          flexDirection="column"
          width={props.width}
          paddingX={1}
          {...(surfaceMuted === undefined ? {} : { backgroundColor: surfaceMuted })}
        >
          {suggestions.map((line) => (
            <Text
              key={line}
              wrap="truncate-end"
              {...(line.startsWith("\u2026")
                ? muted === undefined
                  ? {}
                  : { color: muted }
                : accent === undefined
                  ? {}
                  : { color: accent })}
            >
              {displayText(line)}
            </Text>
          ))}
        </Box>
      )}
      <Box
        borderStyle="single"
        borderTop={false}
        borderRight={false}
        borderBottom={false}
        borderLeft
        paddingX={1}
        width={props.width}
        {...(accent === undefined ? {} : { borderColor: accent })}
        {...(surface === undefined ? {} : { backgroundColor: surface })}
      >
        <Text {...(accent === undefined ? {} : { color: accent })}>{"\u203a "}</Text>
        <Box flexDirection="column" flexGrow={1} minWidth={0}>
          {props.composer.value.length === 0 ? (
            <Text wrap="truncate-end" {...(muted === undefined ? {} : { color: muted })}>
              {props.disabled ? DISABLED_PLACEHOLDER : PLACEHOLDER}
            </Text>
          ) : (
            // Ink wraps this exact safe projection. The cursor block is inserted at the stored
            // offset and the character under it remains visible after the block.
            <Text {...(foreground === undefined ? {} : { color: foreground })}>{inputText}</Text>
          )}
        </Box>
      </Box>
    </Box>
  );
}
