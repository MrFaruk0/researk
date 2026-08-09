import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { themeColor, type TuiTheme } from "../theme.js";
import type { AppState } from "../state.js";

export function statusLabel(state: AppState): string {
  switch (state.runStatus) {
    case "idle":
      return state.connectionStatus === "connecting" ? "connecting" : "ready";
    case "starting":
      return "starting";
    case "streaming":
      return state.phase === undefined ? "streaming" : `streaming \u00b7 ${state.phase}`;
    case "cancelling":
      return "cancelling";
  }
}

export function Footer(props: {
  readonly theme: TuiTheme;
  readonly state: AppState;
  readonly width: number;
}): ReactNode {
  const muted = themeColor(props.theme, "muted");
  const accent = themeColor(props.theme, "accent");
  const border = themeColor(props.theme, "border");
  const warning = themeColor(props.theme, "warning");
  const success = themeColor(props.theme, "success");
  const { state } = props;

  const provider =
    state.connection === undefined ? "no provider" : `${state.connection.providerId}`;
  const model = state.model ?? "no model";
  const busy = state.runStatus !== "idle";
  const statusColor = busy ? warning : success;

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderBottom={false}
      borderLeft={false}
      borderRight={false}
      paddingX={1}
      width={props.width}
      {...(border === undefined ? {} : { borderColor: border })}
    >
      <Box flexDirection="row" justifyContent="space-between">
        <Box>
          <Text {...(muted === undefined ? {} : { color: muted })}>provider </Text>
          <Text {...(accent === undefined ? {} : { color: accent })}>{provider}</Text>
          <Text {...(muted === undefined ? {} : { color: muted })}>{"  model "}</Text>
          <Text {...(accent === undefined ? {} : { color: accent })}>{model}</Text>
          <Text {...(muted === undefined ? {} : { color: muted })}>{"  variant "}</Text>
          <Text {...(accent === undefined ? {} : { color: accent })}>{state.variant}</Text>
        </Box>
        <Box>
          <Text {...(statusColor === undefined ? {} : { color: statusColor })}>
            {statusLabel(state)}
          </Text>
        </Box>
      </Box>
      <Box>
        <Text {...(muted === undefined ? {} : { color: muted })}>
          {`workspace ${state.workspaceRoot}  \u00b7  Ctrl+X cancel  \u00b7  /exit quit`}
        </Text>
      </Box>
    </Box>
  );
}
