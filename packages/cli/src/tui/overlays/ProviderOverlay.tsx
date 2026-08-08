import { Box, Text } from "ink";
import type { ReactNode } from "react";
import type { ProviderConnectionKind } from "../../types.js";
import { HintLine, OptionRow, Panel } from "../components/Panel.js";
import type { ProviderFormState } from "../state.js";
import { themeColor, type TuiTheme } from "../theme.js";

export interface ProviderChoice {
  readonly kind: ProviderConnectionKind;
  readonly label: string;
  readonly hint: string;
}

/**
 * Only the two adapters the CLI actually implements are offered. Native OpenAI and Anthropic
 * adapters do not exist in this build and are deliberately not listed.
 */
export const PROVIDER_CHOICES: readonly ProviderChoice[] = Object.freeze([
  Object.freeze({
    kind: "openrouter" as const,
    label: "OpenRouter",
    hint: "aggregated catalog, default base URL",
  }),
  Object.freeze({
    kind: "compatible" as const,
    label: "OpenAI-compatible endpoint",
    hint: "requires an explicit base URL",
  }),
]);

export function ProviderPicker(props: {
  readonly theme: TuiTheme;
  readonly selected: number;
}): ReactNode {
  return (
    <Panel theme={props.theme} title="Connect a provider">
      {PROVIDER_CHOICES.map((choice, index) => (
        <OptionRow
          key={choice.kind}
          theme={props.theme}
          label={choice.label}
          hint={choice.hint}
          selected={index === props.selected}
        />
      ))}
      <HintLine
        theme={props.theme}
        text={"Up/Down choose \u00b7 Enter continue \u00b7 Esc cancel"}
      />
    </Panel>
  );
}

export interface FormField {
  readonly key: "providerId" | "baseUrl" | "apiKeyEnvironmentVariable" | "apiKey";
  readonly label: string;
  readonly secret: boolean;
  readonly hint: string;
}

export function formFields(kind: ProviderConnectionKind): readonly FormField[] {
  const shared: readonly FormField[] = [
    {
      key: "apiKeyEnvironmentVariable",
      label: "API key environment reference",
      secret: false,
      hint: "name only, never a value",
    },
    {
      key: "apiKey",
      label: "API key (this session only)",
      secret: true,
      hint: "optional if the environment variable is already set",
    },
  ];
  if (kind === "openrouter") {
    return [
      {
        key: "baseUrl",
        label: "Base URL",
        secret: false,
        hint: "leave empty for the OpenRouter default",
      },
      ...shared,
    ];
  }
  return [
    { key: "providerId", label: "Provider ID", secret: false, hint: "e.g. local-vllm" },
    { key: "baseUrl", label: "Base URL", secret: false, hint: "required, HTTPS or loopback" },
    ...shared,
  ];
}

function mask(value: string): string {
  return value.length === 0 ? "" : "\u2022".repeat(Math.min(value.length, 32));
}

/** Omits `color` entirely when the theme disables colour, keeping optional props exact. */
function labelColor(color: string | undefined): Readonly<{ color?: string }> {
  return color === undefined ? {} : { color };
}

export function ProviderForm(props: {
  readonly theme: TuiTheme;
  readonly form: ProviderFormState;
  readonly disclosure: string;
}): ReactNode {
  const fields = formFields(props.form.kind);
  const accent = themeColor(props.theme, "accent");
  const muted = themeColor(props.theme, "muted");
  const error = themeColor(props.theme, "error");
  const foreground = themeColor(props.theme, "foreground");
  const warning = themeColor(props.theme, "warning");

  return (
    <Panel
      theme={props.theme}
      title={
        props.form.kind === "openrouter" ? "OpenRouter connection" : "OpenAI-compatible connection"
      }
    >
      {fields.map((field, index) => {
        const focused = index === props.form.focusedField;
        const raw = props.form[field.key];
        const shown = field.secret ? mask(raw) : raw;
        return (
          <Box key={field.key} flexDirection="column">
            <Box>
              <Text {...(accent === undefined ? {} : { color: accent })}>
                {focused ? "\u276f " : "  "}
              </Text>
              <Text bold={focused} {...labelColor(focused ? accent : muted)}>
                {field.label}
              </Text>
            </Box>
            <Box paddingLeft={2}>
              <Text {...(foreground === undefined ? {} : { color: foreground })}>
                {shown.length === 0 ? " " : shown}
              </Text>
              {focused ? <Text>{"\u2588"}</Text> : null}
            </Box>
            {focused ? (
              <Box paddingLeft={2}>
                <Text {...(muted === undefined ? {} : { color: muted })}>{field.hint}</Text>
              </Box>
            ) : null}
          </Box>
        );
      })}
      <Box marginTop={1}>
        <Text {...(warning === undefined ? {} : { color: warning })}>
          {`Network: ${props.disclosure}`}
        </Text>
      </Box>
      {props.form.error === undefined ? null : (
        <Box marginTop={1}>
          <Text {...(error === undefined ? {} : { color: error })} wrap="truncate-end">
            {props.form.error}
          </Text>
        </Box>
      )}
      <HintLine
        theme={props.theme}
        text={
          props.form.submitting
            ? "Connecting\u2026"
            : "Tab/Shift+Tab move \u00b7 Enter connect \u00b7 Esc cancel"
        }
      />
    </Panel>
  );
}
