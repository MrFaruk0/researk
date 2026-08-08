import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { themeColor, type TuiTheme } from "../theme.js";

export function Panel(props: {
  readonly theme: TuiTheme;
  readonly title?: string;
  readonly children: ReactNode;
  readonly width?: number | string;
}): ReactNode {
  const border = themeColor(props.theme, "border");
  const accent = themeColor(props.theme, "accent");
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      paddingX={1}
      {...(border === undefined ? {} : { borderColor: border })}
      {...(props.width === undefined ? {} : { width: props.width })}
    >
      {props.title === undefined ? null : (
        <Box marginBottom={1}>
          <Text bold {...(accent === undefined ? {} : { color: accent })}>
            {props.title}
          </Text>
        </Box>
      )}
      {props.children}
    </Box>
  );
}

/** A keyboard-navigable option row shared by every list overlay. */
export function OptionRow(props: {
  readonly theme: TuiTheme;
  readonly label: string;
  readonly hint?: string | undefined;
  readonly selected: boolean;
}): ReactNode {
  const accent = themeColor(props.theme, "accent");
  const muted = themeColor(props.theme, "muted");
  const foreground = themeColor(props.theme, "foreground");
  const color = props.selected ? accent : foreground;
  return (
    <Box>
      <Text {...(accent === undefined ? {} : { color: accent })}>
        {props.selected ? "\u276f " : "  "}
      </Text>
      <Text bold={props.selected} {...(color === undefined ? {} : { color })}>
        {props.label}
      </Text>
      {props.hint === undefined ? null : (
        <Text {...(muted === undefined ? {} : { color: muted })}>{`  ${props.hint}`}</Text>
      )}
    </Box>
  );
}

export function HintLine(props: { readonly theme: TuiTheme; readonly text: string }): ReactNode {
  const muted = themeColor(props.theme, "muted");
  return (
    <Box marginTop={1}>
      <Text {...(muted === undefined ? {} : { color: muted })}>{props.text}</Text>
    </Box>
  );
}
