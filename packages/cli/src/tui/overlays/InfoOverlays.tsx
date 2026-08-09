import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { SLASH_COMMANDS } from "../commands.js";
import { HintLine, OptionRow, Panel } from "../components/Panel.js";
import { displayText } from "../state.js";
import { themeColor, type TuiTheme } from "../theme.js";

const KEY_BINDINGS: readonly (readonly [string, string])[] = Object.freeze([
  ["Enter", "send prompt / submit overlay"],
  ["Ctrl+J", "newline in the composer"],
  ["Up / Down", "history, overlay selection, or source line"],
  ["PageUp / PageDown", "scroll conversation, or page source"],
  ["Tab / Shift+Tab", "move between form fields"],
  ["Esc", "close overlay"],
  ["Ctrl+X", "cancel an active run"],
  ["Ctrl+L", "clear conversation"],
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

/**
 * Rows the `/source` panel spends on things other than source: the top and bottom border, the
 * title and its margin, the range line, and the hint line with its margin.
 */
const SOURCE_OVERLAY_CHROME_ROWS = 8;

/** The smallest page worth drawing; below this the overlay would be unreadable rather than bounded. */
const SOURCE_OVERLAY_MINIMUM_PAGE_LINES = 1;

/**
 * The number of source lines drawn in one page of the `/source` overlay.
 *
 * The overlay must give access to every line of a response of any length, but it also must not push
 * unbounded content into a retained Ink frame, which would break the layout. A page sized to the
 * region actually available satisfies both: the frame stays bounded, paging reaches the final line,
 * and the reported range always matches what is really on screen. Deriving it from the region
 * rather than fixing it is what keeps the range honest on a short terminal.
 */
export function sourceOverlayPageLines(regionHeight: number): number {
  return Math.max(SOURCE_OVERLAY_MINIMUM_PAGE_LINES, regionHeight - SOURCE_OVERLAY_CHROME_ROWS);
}

/** Splits redacted canonical source into the lines the overlay pages through. */
export function sourceLines(source: string): readonly string[] {
  return source.split("\n");
}

/** Clamps a requested first-line offset so paging can never run past either end. */
export function clampSourceOffset(offset: number, lineCount: number, pageLines: number): number {
  const highest = Math.max(0, lineCount - pageLines);
  return Math.min(Math.max(offset, 0), highest);
}

/**
 * Shows the redacted canonical source of the latest response, one bounded page at a time.
 *
 * Every line is reachable: the visible range and the total are always stated, and Up/Down, PageUp/
 * PageDown, and Home/End move the window, so the last line of an arbitrarily long response can be
 * read. The source is shown verbatim apart from the terminal-safe projection applied by
 * `displayText` at this rendering boundary, so LaTeX can be copied exactly while a control sequence
 * embedded in the response cannot reach the terminal.
 */
export function SourceOverlay(props: {
  readonly theme: TuiTheme;
  readonly source: string | undefined;
  readonly offset: number;
  readonly regionHeight: number;
}): ReactNode {
  const muted = themeColor(props.theme, "muted");

  if (props.source === undefined) {
    return (
      <Panel theme={props.theme} title="Canonical source">
        <Text {...(muted === undefined ? {} : { color: muted })}>No assistant response yet.</Text>
        <HintLine theme={props.theme} text={"Esc close"} />
      </Panel>
    );
  }

  const lines = sourceLines(props.source);
  const pageLines = sourceOverlayPageLines(props.regionHeight);
  const offset = clampSourceOffset(props.offset, lines.length, pageLines);
  const end = Math.min(lines.length, offset + pageLines);
  const visible = lines.slice(offset, end);
  const atStart = offset === 0;
  const atEnd = end >= lines.length;

  return (
    <Panel theme={props.theme} title="Canonical source">
      <Box>
        <Text {...(muted === undefined ? {} : { color: muted })}>
          {`lines ${offset + 1}\u2013${end} of ${lines.length}${atEnd ? " \u00b7 end" : ""}`}
        </Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {/* One node per page keeps the shown range exact; Ink renders the newlines. */}
        <Text>{displayText(visible.join("\n"))}</Text>
      </Box>
      <HintLine
        theme={props.theme}
        text={
          atStart && atEnd
            ? "Esc close"
            : "Up/Down line \u00b7 PageUp/PageDown page \u00b7 Home/End \u00b7 Esc close"
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
      <HintLine theme={props.theme} text={"Up/Down \u00b7 Enter run \u00b7 Esc cancel"} />
    </Panel>
  );
}
