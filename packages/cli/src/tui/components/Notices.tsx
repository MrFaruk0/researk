import { Box, Text } from "ink";
import type { ReactNode } from "react";
import type { StatusNotice } from "../state.js";
import { themeColor, type TuiTheme, type TuiThemeToken } from "../theme.js";

function levelToken(level: StatusNotice["level"]): TuiThemeToken {
  switch (level) {
    case "error":
      return "error";
    case "warning":
      return "warning";
    case "success":
      return "success";
    case "info":
      return "muted";
  }
}

function levelPrefix(level: StatusNotice["level"]): string {
  switch (level) {
    case "error":
      return "error";
    case "warning":
      return "warning";
    case "success":
      return "ok";
    case "info":
      return "info";
  }
}

/**
 * Renders diagnostics, errors, and external-I/O disclosure inside the TUI. Messages arrive already
 * redacted and neutralized, and no stack trace is ever shown.
 */
export function Notices(props: {
  readonly theme: TuiTheme;
  readonly notices: readonly StatusNotice[];
  readonly width: number;
}): ReactNode {
  if (props.notices.length === 0) return null;
  return (
    <Box flexDirection="column" paddingX={1} width={props.width}>
      {props.notices.map((notice) => {
        const color = themeColor(props.theme, levelToken(notice.level));
        return (
          <Box key={notice.id}>
            <Text {...(color === undefined ? {} : { color })}>
              {`${levelPrefix(notice.level)}: `}
            </Text>
            <Text {...(color === undefined ? {} : { color })} wrap="truncate-end">
              {notice.message}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}
