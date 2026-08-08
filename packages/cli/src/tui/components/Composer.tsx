import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { discoverSlashCommands } from "../commands.js";
import type { ComposerState } from "../state.js";
import { themeColor, type TuiTheme } from "../theme.js";

export function Composer(props: {
  readonly theme: TuiTheme;
  readonly composer: ComposerState;
  readonly disabled: boolean;
  readonly width: number;
}): ReactNode {
  const accent = themeColor(props.theme, "accent");
  const muted = themeColor(props.theme, "muted");
  const border = themeColor(props.theme, "border");
  const foreground = themeColor(props.theme, "foreground");
  const suggestions = discoverSlashCommands(props.composer.value);
  // The reducer clamps the stored cursor, but the component clamps again so a malformed state can
  // never split a rendered string out of bounds.
  const cursor = Math.min(Math.max(props.composer.cursor, 0), props.composer.value.length);

  return (
    <Box flexDirection="column" width={props.width}>
      {suggestions.length === 0 ? null : (
        <Box flexDirection="column" paddingX={1}>
          {suggestions.map((command) => (
            <Box key={command.name}>
              <Text {...(accent === undefined ? {} : { color: accent })}>{command.name}</Text>
              <Text
                {...(muted === undefined ? {} : { color: muted })}
              >{`  ${command.summary}`}</Text>
            </Box>
          ))}
        </Box>
      )}
      <Box
        borderStyle="round"
        paddingX={1}
        {...(border === undefined ? {} : { borderColor: border })}
      >
        <Text {...(accent === undefined ? {} : { color: accent })}>{"\u203a "}</Text>
        <Box flexDirection="column" flexGrow={1}>
          {props.composer.value.length === 0 ? (
            <Text {...(muted === undefined ? {} : { color: muted })}>
              {props.disabled
                ? "Streaming\u2026 Ctrl+C cancels"
                : "Ask a question, or type / for commands"}
            </Text>
          ) : (
            // Ink renders embedded newlines, so multi-line input is one node. The cursor block is
            // drawn at the composer's actual cursor offset, so Left/Right movement is visible; the
            // character under the cursor is preserved after the block rather than being replaced.
            <Text {...(foreground === undefined ? {} : { color: foreground })}>
              {`${props.composer.value.slice(0, cursor)}\u2588${props.composer.value.slice(cursor)}`}
            </Text>
          )}
        </Box>
      </Box>
    </Box>
  );
}
