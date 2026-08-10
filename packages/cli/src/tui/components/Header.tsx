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

function externalActivityLabel(state: AppState): string | undefined {
  const activity = state.externalActivity;
  if (activity === undefined) return undefined;
  const destination = compact(activity.destination, 24);
  if (activity.kind === "catalog") return `↗ catalog → ${destination}`;
  const documents = activity.documentCount === 0 ? "" : ` + ${activity.documentCount} docs`;
  return `↗ prompt${documents} → ${destination}`;
}

export function Header(props: {
  readonly theme: TuiTheme;
  readonly state: AppState;
  readonly version: string;
  readonly width: number;
}): ReactNode {
  const accent = themeColor(props.theme, "accent");
  const muted = themeColor(props.theme, "muted");
  const border = themeColor(props.theme, "border");
  const workspace = compact(workspaceName(props.state.workspaceRoot), 24);
  const session = compact(props.state.sessionTitle, 24);
  const activity = externalActivityLabel(props.state);

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
      <Box flexGrow={1} flexShrink={1}>
        <Text bold {...(accent === undefined ? {} : { color: accent })}>
          Researk
        </Text>
        <Text {...(muted === undefined ? {} : { color: muted })}>{` ${props.version}`}</Text>
        <Text {...(muted === undefined ? {} : { color: muted })}>{` · ${session}`}</Text>
      </Box>
      <Box flexShrink={1}>
        <Text wrap="truncate-end" {...(muted === undefined ? {} : { color: muted })}>
          {activity ?? workspace}
        </Text>
      </Box>
    </Box>
  );
}
