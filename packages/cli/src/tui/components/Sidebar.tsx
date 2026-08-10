import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { type AppState, displayText } from "../state.js";
import { type TuiTheme, themeColor } from "../theme.js";

const SIDEBAR_WIDTH = 30;

export function sidebarWidth(): number {
  return SIDEBAR_WIDTH;
}

/**
 * Returns true when the terminal is wide enough to show a useful right sidebar without squeezing
 * the conversation below a practical minimum.
 */
export function shouldShowSidebar(terminalWidth: number, maxContentWidth: number): boolean {
  return terminalWidth > maxContentWidth + SIDEBAR_WIDTH;
}

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

function relativeTime(isoString: string): string {
  const then = new Date(isoString).getTime();
  if (Number.isNaN(then)) return "";
  const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(then).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function workspaceLabel(root: string): string {
  const parts = oneLine(root)
    .split(/[\\/]/u)
    .filter((part) => part.length > 0);
  return compact(parts.slice(-2).join("/"), 26);
}

export function Sidebar(props: { readonly theme: TuiTheme; readonly state: AppState }): ReactNode {
  const accent = themeColor(props.theme, "accent");
  const muted = themeColor(props.theme, "muted");
  const border = themeColor(props.theme, "border");
  const surfaceMuted = themeColor(props.theme, "surfaceMuted");
  const { state } = props;

  return (
    <Box
      flexDirection="column"
      width={SIDEBAR_WIDTH}
      borderStyle="single"
      borderTop={false}
      borderRight={false}
      borderBottom={false}
      paddingX={1}
      {...(border === undefined ? {} : { borderColor: border })}
      {...(surfaceMuted === undefined ? {} : { backgroundColor: surfaceMuted })}
    >
      <Box marginBottom={1}>
        <Text bold wrap="truncate-end" {...(accent === undefined ? {} : { color: accent })}>
          {compact(state.sessionTitle, 26)}
        </Text>
      </Box>

      <Text {...(muted === undefined ? {} : { color: muted })}>local-first · no telemetry</Text>
      {state.sessionUpdatedAt === undefined ? null : (
        <Text {...(muted === undefined ? {} : { color: muted })}>
          {relativeTime(state.sessionUpdatedAt)}
        </Text>
      )}

      <Box marginTop={1} flexDirection="column">
        <Box>
          <Text {...(muted === undefined ? {} : { color: muted })}>provider </Text>
          <Text wrap="truncate-end" {...(accent === undefined ? {} : { color: accent })}>
            {compact(state.connection?.providerId ?? "none", 18)}
          </Text>
        </Box>
        <Box>
          <Text {...(muted === undefined ? {} : { color: muted })}>model </Text>
          <Text wrap="truncate-end" {...(accent === undefined ? {} : { color: accent })}>
            {compact(state.model ?? "none", 18)}
          </Text>
        </Box>
        <Box>
          <Text {...(muted === undefined ? {} : { color: muted })}>variant </Text>
          <Text wrap="truncate-end" {...(accent === undefined ? {} : { color: accent })}>
            {compact(state.variant, 18)}
          </Text>
        </Box>
      </Box>

      <Box marginTop={1}>
        <Text {...(muted === undefined ? {} : { color: muted })}>
          {`${state.conversation.length} message${state.conversation.length === 1 ? "" : "s"}`}
        </Text>
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text {...(muted === undefined ? {} : { color: muted })}>workspace</Text>
        <Text wrap="truncate-end" {...(accent === undefined ? {} : { color: accent })}>
          {workspaceLabel(state.workspaceRoot)}
        </Text>
      </Box>

      {state.stagedDocuments.length === 0 ? null : (
        <Box marginTop={1} flexDirection="column">
          <Text {...(muted === undefined ? {} : { color: muted })}>staged documents</Text>
          {state.stagedDocuments.map((doc) => (
            <Text
              key={doc.relativePath}
              wrap="truncate-end"
              {...(accent === undefined ? {} : { color: accent })}
            >
              {compact(doc.relativePath, 26)}
            </Text>
          ))}
        </Box>
      )}
    </Box>
  );
}
