import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { displayText } from "../state.js";
import { type TuiTheme, themeColor } from "../theme.js";

export function Panel(props: {
  readonly theme: TuiTheme;
  readonly title?: string;
  readonly children: ReactNode;
  readonly width?: number | string;
}): ReactNode {
  const border = themeColor(props.theme, "border");
  const accent = themeColor(props.theme, "accent");
  const surface = themeColor(props.theme, "surface");
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      paddingX={1}
      {...(border === undefined ? {} : { borderColor: border })}
      {...(surface === undefined ? {} : { backgroundColor: surface })}
      {...(props.width === undefined ? {} : { width: props.width })}
    >
      {props.title === undefined ? null : (
        <Box marginBottom={1}>
          <Text bold {...(accent === undefined ? {} : { color: accent })}>
            {displayText(props.title)}
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
  const selectedSurface = themeColor(props.theme, "surfaceMuted");
  const color = props.selected ? accent : foreground;
  return (
    <Box
      {...(props.selected && selectedSurface === undefined
        ? {}
        : props.selected
          ? { backgroundColor: selectedSurface }
          : {})}
    >
      <Text {...(accent === undefined ? {} : { color: accent })}>
        {props.selected ? "❯ " : "  "}
      </Text>
      <Text bold={props.selected} wrap="truncate-end" {...(color === undefined ? {} : { color })}>
        {displayText(props.label)}
      </Text>
      {props.hint === undefined ? null : (
        <Text wrap="truncate-end" {...(muted === undefined ? {} : { color: muted })}>
          {`  ${displayText(props.hint)}`}
        </Text>
      )}
    </Box>
  );
}

export function HintLine(props: { readonly theme: TuiTheme; readonly text: string }): ReactNode {
  const muted = themeColor(props.theme, "muted");
  return (
    <Box marginTop={1}>
      <Text {...(muted === undefined ? {} : { color: muted })}>{displayText(props.text)}</Text>
    </Box>
  );
}
