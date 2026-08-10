import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { SLASH_COMMANDS } from "../commands.js";
import { HintLine, OptionRow, Panel } from "../components/Panel.js";
import { paginateDisplayText } from "../layout.js";
import { type TuiTheme, themeColor } from "../theme.js";

const KEY_BINDINGS: readonly (readonly [string, string])[] = Object.freeze([
  ["Enter", "send prompt / submit overlay"],
  ["Ctrl+J", "newline in the composer"],
  ["Up / Down", "history, overlay selection, or source row"],
  ["Wheel / PageUp / PageDown", "scroll conversation, or page source"],
  ["Home / End", "oldest / live tail"],
  ["Tab / Shift+Tab", "move between form fields"],
  ["Esc", "close overlay"],
  ["Ctrl+X", "cancel an active run"],
  ["Ctrl+L", "clear conversation"],
  ["Formula keys", "Up/Down or j/k · c copy · e edit · i insert · s source"],
]);

/**
 * A compact two-column help overlay. It is deliberately terse so it fits inside the bounded overlay
 * region of a standard 24-row terminal without pushing the composer or footer off screen.
 */
export function HelpOverlay(props: { readonly theme: TuiTheme }): ReactNode {
  const accent = themeColor(props.theme, "accent");
  const muted = themeColor(props.theme, "muted");
  return (
    <Panel theme={props.theme} title="Researk help">
      <Box flexDirection="row">
        <Box flexDirection="column" width="45%">
          <Text bold {...(accent === undefined ? {} : { color: accent })}>
            Commands
          </Text>
          {SLASH_COMMANDS.map((command) => (
            <Box key={command.name}>
              <Text {...(accent === undefined ? {} : { color: accent })}>
                {command.name.padEnd(10)}
              </Text>
              <Text {...(muted === undefined ? {} : { color: muted })} wrap="truncate-end">
                {command.summary}
              </Text>
            </Box>
          ))}
        </Box>
        <Box flexDirection="column" flexGrow={1}>
          <Text bold {...(accent === undefined ? {} : { color: accent })}>
            Keys
          </Text>
          {KEY_BINDINGS.map(([key, description]) => (
            <Box key={key}>
              <Text {...(accent === undefined ? {} : { color: accent })}>{key.padEnd(18)}</Text>
              <Text {...(muted === undefined ? {} : { color: muted })} wrap="truncate-end">
                {description}
              </Text>
            </Box>
          ))}
        </Box>
      </Box>
      <HintLine theme={props.theme} text={"Esc close"} />
    </Panel>
  );
}

export function ReadOverlay(props: {
  readonly theme: TuiTheme;
  readonly value: string;
  readonly error: string | undefined;
  readonly workspaceRoot: string;
}): ReactNode {
  const accent = themeColor(props.theme, "accent");
  const muted = themeColor(props.theme, "muted");
  const error = themeColor(props.theme, "error");
  return (
    <Panel theme={props.theme} title="Stage a workspace document">
      <Box>
        <Text {...(muted === undefined ? {} : { color: muted })}>
          {`inside ${props.workspaceRoot}`}
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text {...(accent === undefined ? {} : { color: accent })}>{"path "}</Text>
        <Text>{props.value.length === 0 ? " " : props.value}</Text>
        <Text>{"\u2588"}</Text>
      </Box>
      {props.error === undefined ? null : (
        <Box marginTop={1}>
          <Text {...(error === undefined ? {} : { color: error })} wrap="truncate-end">
            {props.error}
          </Text>
        </Box>
      )}
      <HintLine theme={props.theme} text={"Enter stage \u00b7 Esc cancel"} />
    </Panel>
  );
}

/** Full `/source` panel chrome: borders, title, range, margins, and the hint. */
const SOURCE_OVERLAY_CHROME_ROWS = 8;
const SOURCE_OVERLAY_MINIMUM_PAGE_ROWS = 1;
const SOURCE_OVERLAY_COMPACT_HEADER_ROWS = 1;

/**
 * Returns the number of rendered source rows in one page. The normal Panel is used only when its
 * eight rows of chrome plus one source row can fit; otherwise a compact header is used.
 */
export function sourceOverlayPageLines(regionHeight: number): number {
  const height = Math.max(1, Math.trunc(Number.isFinite(regionHeight) ? regionHeight : 1));
  if (height >= SOURCE_OVERLAY_CHROME_ROWS + SOURCE_OVERLAY_MINIMUM_PAGE_ROWS) {
    return Math.max(SOURCE_OVERLAY_MINIMUM_PAGE_ROWS, height - SOURCE_OVERLAY_CHROME_ROWS);
  }
  if (height > SOURCE_OVERLAY_COMPACT_HEADER_ROWS)
    return height - SOURCE_OVERLAY_COMPACT_HEADER_ROWS;
  return SOURCE_OVERLAY_MINIMUM_PAGE_ROWS;
}

/** Splits canonical source by physical newline for compatibility; `/source` uses display rows. */
export function sourceLines(source: string): readonly string[] {
  return source.split("\n");
}

/** Clamps a requested first-display-row offset so paging cannot run past either end. */
export function clampSourceOffset(offset: number, rowCount: number, pageRows: number): number {
  const highest = Math.max(0, rowCount - pageRows);
  return Math.min(Math.max(offset, 0), highest);
}

/** Source text width inside a full Panel (two borders and two padding cells). */
export function sourcePanelTextWidth(panelWidth: number): number {
  return Math.max(1, Math.trunc(Number.isFinite(panelWidth) ? panelWidth : 1) - 4);
}

function rowText(row: string): string {
  return row.length === 0 ? " " : row;
}

function keyedRows(
  rows: readonly string[],
  offset: number,
): readonly { key: string; row: string }[] {
  const occurrences = new Map<string, number>();
  return rows.map((row) => {
    const occurrence = occurrences.get(row) ?? 0;
    occurrences.set(row, occurrence + 1);
    return { key: `${offset}:${row}:${occurrence}`, row };
  });
}

/**
 * Shows the redacted canonical source one bounded display-row page at a time. Canonical bytes remain
 * in state; only the terminal-safe projection and the visible page enter Ink.
 */
export function SourceOverlay(props: {
  readonly theme: TuiTheme;
  readonly source: string | undefined;
  /** First rendered display row, not a physical source-line offset. */
  readonly offset: number;
  readonly regionHeight: number;
  /** Width of the overlay child after App's horizontal wrapper padding. */
  readonly width?: number | undefined;
}): ReactNode {
  const muted = themeColor(props.theme, "muted");
  const panelWidth = Math.max(
    1,
    Math.trunc(Number.isFinite(props.width ?? 80) ? (props.width ?? 80) : 80),
  );
  const height = Math.max(
    1,
    Math.trunc(Number.isFinite(props.regionHeight) ? props.regionHeight : 1),
  );
  const compact = height < SOURCE_OVERLAY_CHROME_ROWS + SOURCE_OVERLAY_MINIMUM_PAGE_ROWS;
  const pageRows = sourceOverlayPageLines(height);

  if (props.source === undefined) {
    if (compact) {
      return (
        <Box flexDirection="column" width={panelWidth} height={height} overflow="hidden">
          <Text wrap="truncate-end" {...(muted === undefined ? {} : { color: muted })}>
            {height <= 1 ? "No assistant response yet." : "Canonical source · none"}
          </Text>
        </Box>
      );
    }
    return (
      <Panel theme={props.theme} title="Canonical source" width={panelWidth}>
        <Text {...(muted === undefined ? {} : { color: muted })}>No assistant response yet.</Text>
        <HintLine theme={props.theme} text={"Esc close"} />
      </Panel>
    );
  }

  const page = paginateDisplayText(
    props.source,
    compact ? panelWidth : sourcePanelTextWidth(panelWidth),
    props.offset,
    pageRows,
  );
  const end = Math.min(page.totalRows, page.offset + page.rows.length);
  const atStart = page.offset === 0;
  const atEnd = end >= page.totalRows;
  const range = `rows ${page.offset + 1}\u2013${end} of ${page.totalRows}${atEnd ? " \u00b7 end" : ""}`;

  if (compact) {
    return (
      <Box flexDirection="column" width={panelWidth} height={height} overflow="hidden">
        {height <= 1 ? null : (
          <Text wrap="truncate-end" {...(muted === undefined ? {} : { color: muted })}>
            {`Canonical source · ${range}`}
          </Text>
        )}
        <Box flexDirection="column" height={pageRows} overflow="hidden">
          {keyedRows(page.rows, page.offset).map((item) => (
            <Text key={item.key}>{rowText(item.row)}</Text>
          ))}
        </Box>
      </Box>
    );
  }

  return (
    <Panel theme={props.theme} title="Canonical source" width={panelWidth}>
      <Box>
        <Text {...(muted === undefined ? {} : { color: muted })}>{range}</Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {keyedRows(page.rows, page.offset).map((item) => (
          <Text key={item.key}>{rowText(item.row)}</Text>
        ))}
      </Box>
      <HintLine
        theme={props.theme}
        text={
          atStart && atEnd
            ? "Esc close"
            : "Up/Down row · PageUp/PageDown page · Home/End · Esc close"
        }
      />
    </Panel>
  );
}

export function CommandOverlay(props: {
  readonly theme: TuiTheme;
  readonly selected: number;
}): ReactNode {
  return (
    <Panel theme={props.theme} title="Commands">
      {SLASH_COMMANDS.map((command, index) => (
        <OptionRow
          key={command.name}
          theme={props.theme}
          label={command.name}
          hint={command.summary}
          selected={index === props.selected}
        />
      ))}
      <HintLine theme={props.theme} text={"Up/Down · Enter run · Esc cancel"} />
    </Panel>
  );
}
