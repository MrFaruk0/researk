import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { type AppState, displayText } from "../state.js";
import { type TuiTheme, themeColor } from "../theme.js";

function oneLine(value: string): string {
  return displayText(value)
    .replace(/[\r\n\t]+/gu, " ")
    .trim();
}

function compact(value: string, limit: number): string {
  const text = oneLine(value);
  if (text.length <= limit) return text;
  if (limit <= 1) return text.slice(0, limit);
  return `${text.slice(0, limit - 1)}…`;
}

function workspaceName(root: string): string {
  const parts = oneLine(root)
    .split(/[\\/]/u)
    .filter((part) => part.length > 0);
  return parts.at(-1) ?? oneLine(root);
}

export function Footer(props: {
  readonly theme: TuiTheme;
  readonly state: AppState;
  readonly width: number;
}): ReactNode {
  const muted = themeColor(props.theme, "muted");
  const accent = themeColor(props.theme, "accent");
  const border = themeColor(props.theme, "border");
  const { state } = props;

  const provider = state.connection?.providerId ?? "none";
  const model = state.model ?? "none";
  const context = [
    `workspace ${compact(workspaceName(state.workspaceRoot), 24)}`,
    `provider ${compact(provider, 20)}`,
    `model ${compact(model, 30)}`,
    `variant ${compact(state.variant, 12)}`,
    `session ${compact(state.sessionTitle, 24)}`,
  ].join("  ·  ");

  return (
    <Box
      flexDirection="row"
      borderStyle="single"
      borderBottom={false}
      borderLeft={false}
      borderRight={false}
      paddingX={1}
      width={props.width}
      {...(border === undefined ? {} : { borderColor: border })}
    >
      <Box flexGrow={1} flexShrink={1}>
        <Text wrap="truncate-end" {...(accent === undefined ? {} : { color: accent })}>
          {context}
        </Text>
      </Box>
      <Text {...(muted === undefined ? {} : { color: muted })}> </Text>
    </Box>
  );
}
