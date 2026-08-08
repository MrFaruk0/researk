import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { themeColor, type TuiTheme } from "../theme.js";
import type { AppState } from "../state.js";

export function Header(props: {
  readonly theme: TuiTheme;
  readonly state: AppState;
  readonly version: string;
  readonly width: number;
}): ReactNode {
  const accent = themeColor(props.theme, "accent");
  const muted = themeColor(props.theme, "muted");
  const border = themeColor(props.theme, "border");
  const staged = props.state.stagedDocuments.length;
  return (
    <Box
      flexDirection="row"
      justifyContent="space-between"
      borderStyle="single"
      borderTop={false}
      borderLeft={false}
      borderRight={false}
      paddingX={1}
      width={props.width}
      {...(border === undefined ? {} : { borderColor: border })}
    >
      <Box>
        <Text bold {...(accent === undefined ? {} : { color: accent })}>
          Researk
        </Text>
        <Text {...(muted === undefined ? {} : { color: muted })}>{` ${props.version}`}</Text>
      </Box>
      <Box>
        <Text {...(muted === undefined ? {} : { color: muted })}>
          {staged === 0 ? "local-first \u00b7 no telemetry" : `${staged} staged document(s)`}
        </Text>
      </Box>
    </Box>
  );
}
