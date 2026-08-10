import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { displayText, type StatusNotice } from "../state.js";
import { type TuiTheme, themeColor } from "../theme.js";

function latestActionable(notices: readonly StatusNotice[]): StatusNotice | undefined {
  let latest: StatusNotice | undefined;
  for (const notice of notices) {
    if (notice.level !== "warning" && notice.level !== "error") continue;
    if (latest === undefined || notice.createdAt >= latest.createdAt) latest = notice;
  }
  return latest;
}

/**
 * Renders only the newest actionable diagnostic. Messages arrive redacted and terminal-neutralized
 * from App; the display projection is retained here as a final rendering-boundary guard.
 */
export function Notices(props: {
  readonly theme: TuiTheme;
  readonly notices: readonly StatusNotice[];
  readonly width: number;
}): ReactNode {
  const notice = latestActionable(props.notices);
  if (notice === undefined) return null;

  const color = themeColor(props.theme, notice.level === "error" ? "error" : "warning");
  const surface = themeColor(props.theme, "surfaceMuted");
  const icon = notice.level === "error" ? "×" : "!";
  return (
    <Box
      flexDirection="row"
      borderStyle="single"
      borderTop={false}
      borderRight={false}
      borderBottom={false}
      borderLeft
      paddingX={1}
      width={props.width}
      {...(color === undefined ? {} : { borderColor: color })}
      {...(surface === undefined ? {} : { backgroundColor: surface })}
    >
      <Text {...(color === undefined ? {} : { color })}>{`${icon} `}</Text>
      <Text wrap="truncate-end" {...(color === undefined ? {} : { color })}>
        {displayText(notice.message)}
      </Text>
    </Box>
  );
}
