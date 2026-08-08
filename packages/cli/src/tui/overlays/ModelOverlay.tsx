import { Box, Text } from "ink";
import type { ModelDescriptor } from "@researk/contracts";
import type { ReactNode } from "react";
import { safeTerminalText } from "../../safety.js";
import { HintLine, OptionRow, Panel } from "../components/Panel.js";
import { themeColor, type TuiTheme } from "../theme.js";

const VISIBLE_ROWS = 10;

export function filterModels(
  catalog: readonly ModelDescriptor[],
  query: string,
): readonly ModelDescriptor[] {
  const trimmed = query.trim().toLowerCase();
  if (trimmed.length === 0) return catalog;
  const terms = trimmed.split(/\s+/u);
  return catalog.filter((descriptor) => {
    const haystack = `${descriptor.canonicalId} ${descriptor.displayName}`.toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

export function ModelOverlay(props: {
  readonly theme: TuiTheme;
  readonly catalog: readonly ModelDescriptor[];
  readonly query: string;
  readonly selected: number;
  readonly loading: boolean;
  readonly secrets: readonly string[];
}): ReactNode {
  const muted = themeColor(props.theme, "muted");
  const accent = themeColor(props.theme, "accent");
  const matches = filterModels(props.catalog, props.query);
  const start = Math.max(
    0,
    Math.min(props.selected - VISIBLE_ROWS + 1, matches.length - VISIBLE_ROWS),
  );
  const visible = matches.slice(Math.max(0, start), Math.max(0, start) + VISIBLE_ROWS);

  return (
    <Panel theme={props.theme} title="Select a model">
      <Box>
        <Text {...(accent === undefined ? {} : { color: accent })}>{"search "}</Text>
        <Text>{props.query.length === 0 ? " " : props.query}</Text>
        <Text>{"\u2588"}</Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        {props.loading ? (
          <Text {...(muted === undefined ? {} : { color: muted })}>{"Loading catalog\u2026"}</Text>
        ) : matches.length === 0 ? (
          <Text {...(muted === undefined ? {} : { color: muted })}>No matching models.</Text>
        ) : (
          visible.map((descriptor, index) => {
            const absolute = Math.max(0, start) + index;
            // Catalog metadata is untrusted provider input, so it is neutralized before display.
            const label = safeTerminalText(descriptor.canonicalId, props.secrets);
            const hint = safeTerminalText(descriptor.displayName, props.secrets);
            return (
              <OptionRow
                key={descriptor.canonicalId}
                theme={props.theme}
                label={label}
                {...(hint === label ? {} : { hint })}
                selected={absolute === props.selected}
              />
            );
          })
        )}
      </Box>
      <HintLine
        theme={props.theme}
        text={`${matches.length} of ${props.catalog.length} \u00b7 type to search \u00b7 Up/Down \u00b7 Enter select \u00b7 Esc cancel`}
      />
    </Panel>
  );
}
