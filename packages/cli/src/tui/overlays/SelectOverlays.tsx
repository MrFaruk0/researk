import { Box, Text } from "ink";
import type { ReactNode } from "react";
import type { ReasoningIntent } from "@researk/contracts";
import type { SessionMeta } from "../../config/sessions.js";
import type { ThemeName } from "../../theme.js";
import { HintLine, OptionRow, Panel } from "../components/Panel.js";
import { themeColor, type TuiTheme } from "../theme.js";

/**
 * Lists only the variants the selected model advertises. When no model is selected the list is just
 * `auto`, because nothing else can be honestly offered.
 */
export function VariantOverlay(props: {
  readonly theme: TuiTheme;
  readonly variants: readonly ReasoningIntent[];
  readonly current: ReasoningIntent;
  readonly selected: number;
  readonly modelLabel: string;
}): ReactNode {
  const muted = themeColor(props.theme, "muted");
  return (
    <Panel theme={props.theme} title="Reasoning variant">
      <Box marginBottom={1}>
        <Text {...(muted === undefined ? {} : { color: muted })}>
          {`advertised by ${props.modelLabel}`}
        </Text>
      </Box>
      {props.variants.map((variant, index) => (
        <OptionRow
          key={variant}
          theme={props.theme}
          label={variant}
          {...(variant === props.current ? { hint: "current" } : {})}
          selected={index === props.selected}
        />
      ))}
      <HintLine theme={props.theme} text={"Up/Down \u00b7 Enter select \u00b7 Esc cancel"} />
    </Panel>
  );
}

export function ThemeOverlay(props: {
  readonly theme: TuiTheme;
  readonly names: readonly ThemeName[];
  readonly selected: number;
}): ReactNode {
  const muted = themeColor(props.theme, "muted");
  return (
    <Panel theme={props.theme} title="Theme">
      {props.names.map((name, index) => (
        <OptionRow
          key={name}
          theme={props.theme}
          label={name}
          {...(name === props.theme.name ? { hint: "applied" } : {})}
          selected={index === props.selected}
        />
      ))}
      <Box marginTop={1}>
        <Text {...(muted === undefined ? {} : { color: muted })}>
          {props.theme.colorEnabled
            ? "Moving the selection applies the palette immediately."
            : "Colour is disabled by NO_COLOR, TERM=dumb, or accessible mode."}
        </Text>
      </Box>
      <HintLine theme={props.theme} text={"Up/Down preview \u00b7 Enter keep \u00b7 Esc cancel"} />
    </Panel>
  );
}

/**
 * The saved-sessions browser. Each row shows the session title with a muted metadata hint; the
 * workspace shown is the session's own workspace, because a session may have been created in a
 * different workspace than the one currently open.
 */
export function SessionOverlay(props: {
  readonly theme: TuiTheme;
  readonly sessions: readonly SessionMeta[];
  readonly selected: number;
}): ReactNode {
  const muted = themeColor(props.theme, "muted");
  return (
    <Panel theme={props.theme} title="Saved sessions">
      {props.sessions.length === 0 ? (
        <Box>
          <Text {...(muted === undefined ? {} : { color: muted })}>
            No saved sessions yet. Every completed exchange is persisted automatically.
          </Text>
        </Box>
      ) : (
        props.sessions.map((session, index) => (
          <OptionRow
            key={session.id}
            theme={props.theme}
            label={session.title}
            hint={`${session.messageCount} msg \u00b7 ${session.workspace}`}
            selected={index === props.selected}
          />
        ))
      )}
      <HintLine
        theme={props.theme}
        text={
          props.sessions.length === 0 ? "Esc close" : "Up/Down \u00b7 Enter load \u00b7 Esc cancel"
        }
      />
    </Panel>
  );
}
