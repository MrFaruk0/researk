import { Box, Text } from "ink";
import type { ReactNode } from "react";
import type { AppState, ProviderConnection } from "../state.js";
import { type TuiTheme, themeColor } from "../theme.js";

export interface WelcomeProps {
  readonly theme: TuiTheme;
  readonly width: number;
  readonly height?: number | undefined;
  /** A full state is convenient for App; the narrower props keep the component reusable in tests. */
  readonly state?: Pick<AppState, "connection" | "model"> | undefined;
  readonly connection?: ProviderConnection | undefined;
  readonly model?: string | undefined;
  /** Minimum rows required by the live child stack (notice plus composer input). */
  readonly childRows?: number | undefined;
  readonly children?: ReactNode;
}

function setupCopy(
  state: Pick<AppState, "connection" | "model"> | undefined,
  connection: ProviderConnection | undefined,
  model: string | undefined,
): Readonly<{ readonly command: string; readonly detail: string }> {
  const hasConnection = state?.connection !== undefined || connection !== undefined;
  const selectedModel = state?.model ?? model;
  if (!hasConnection) {
    return { command: "/provider", detail: "connect a model provider to begin" };
  }
  if (selectedModel === undefined || selectedModel.trim().length === 0) {
    return { command: "/model", detail: "choose a model from the provider catalog" };
  }
  return { command: "prompt", detail: "ask a question, or type / for commands" };
}

/**
 * A small terminal wordmark authored for Researk's home state. It intentionally uses only plain
 * characters so it remains legible in monochrome, accessible, and narrow terminal environments.
 */
const WIDE_WORDMARK = [
  "  rrr  eee  sss  eee  aaa  rrr  k k",
  "  r  r e    s    e    a a  r  r k k",
  "  rrr  eee  sss  eee  aaa  r  r k  k",
] as const;

interface WelcomeContentFlags {
  readonly compactVertical: boolean;
  readonly compactWordmark: boolean;
  readonly showSetup: boolean;
  readonly showWordmark: boolean;
  readonly childMargin: number;
}

function welcomeContentFlags(
  width: number,
  height: number,
  childRows: number,
): WelcomeContentFlags {
  const compactVertical = height < 12;
  const compactWordmark = width < 56 || compactVertical;
  let showSetup = height >= 5;
  let showWordmark = height >= 3;
  const rows = (wordmark: boolean, setup: boolean): number => {
    const wordmarkRows = !wordmark ? 0 : compactWordmark ? 1 : 3;
    const taglineRows = wordmark && !compactVertical ? 1 : 0;
    const setupMargin = wordmark && setup ? 1 : 0;
    const setupRows = setup ? 1 : 0;
    const canonicalHintRows = setup && wordmark && !compactVertical ? 1 : 0;
    const childMargin = wordmark || setup ? 1 : 0;
    return wordmarkRows + taglineRows + setupMargin + setupRows + canonicalHintRows + childMargin;
  };

  // Preserve the child stack before decorative content. Setup guidance is more useful than the
  // wordmark, so hide the latter first when a short terminal cannot fit both and the composer.
  while (showWordmark && rows(showWordmark, showSetup) + childRows > height) showWordmark = false;
  while (showSetup && rows(showWordmark, showSetup) + childRows > height) showSetup = false;

  return {
    compactVertical,
    compactWordmark,
    showSetup,
    showWordmark,
    childMargin: showWordmark || showSetup ? 1 : 0,
  };
}

/**
 * Returns the number of rows available to optional slash suggestions inside the home stack. The
 * calculation mirrors the authored rows below so App can reserve the same geometry before Ink
 * renders the children.
 */
export function welcomeSuggestionBudget(
  width: number,
  height: number,
  inputRows: number,
  noticeRows = 0,
): number {
  const safeWidth = Math.max(1, Math.trunc(Number.isFinite(width) ? width : 1));
  const safeHeight = Math.max(1, Math.trunc(Number.isFinite(height) ? height : 1));
  const safeNoticeRows = Math.max(0, Math.trunc(Number.isFinite(noticeRows) ? noticeRows : 0));
  const safeInputRows = Math.max(1, Math.trunc(Number.isFinite(inputRows) ? inputRows : 1));
  const flags = welcomeContentFlags(safeWidth, safeHeight, safeInputRows + safeNoticeRows);
  const fixedRows =
    (flags.showWordmark ? (flags.compactWordmark ? 1 : 3) : 0) +
    (flags.showWordmark && !flags.compactVertical ? 1 : 0) +
    (flags.showWordmark && flags.showSetup ? 1 : 0) +
    (flags.showSetup ? 1 : 0) +
    (flags.showSetup && flags.showWordmark && !flags.compactVertical ? 1 : 0) +
    flags.childMargin +
    safeNoticeRows;
  return Math.max(0, safeHeight - fixedRows - safeInputRows);
}

/**
 * Centered home-state copy for a fresh Researk session. Children are deliberately rendered inside
 * the home stack so App can place the live Composer beneath the setup guidance without duplicating
 * the wordmark or responsive layout.
 */
export function Welcome(props: WelcomeProps): ReactNode {
  const accent = themeColor(props.theme, "accent");
  const muted = themeColor(props.theme, "muted");
  const foreground = themeColor(props.theme, "foreground");
  const surface = themeColor(props.theme, "surface");
  const setup = setupCopy(props.state, props.connection, props.model);
  const measuredHeight = props.height === undefined ? Number.POSITIVE_INFINITY : props.height;
  const childRows = Math.max(1, Math.trunc(props.childRows ?? 1));
  const flags =
    props.height === undefined
      ? {
          compactVertical: false,
          compactWordmark: props.width < 56,
          showSetup: true,
          showWordmark: true,
          childMargin: 1,
        }
      : welcomeContentFlags(props.width, measuredHeight, childRows);
  const { compactVertical, compactWordmark, showSetup, showWordmark, childMargin } = flags;

  return (
    <Box
      flexDirection="column"
      alignItems="center"
      justifyContent={compactVertical ? "flex-start" : "center"}
      flexGrow={1}
      minHeight={0}
      overflow="hidden"
      width={props.width}
      {...(props.height === undefined ? {} : { height: props.height })}
      paddingX={1}
    >
      {!showWordmark ? null : compactWordmark ? (
        <Text bold {...(accent === undefined ? {} : { color: accent })}>
          researk
        </Text>
      ) : (
        <Box flexDirection="column" alignItems="center">
          {WIDE_WORDMARK.map((line, index) => (
            <Text
              key={line}
              bold={index === 1}
              {...(index === 1
                ? foreground === undefined
                  ? {}
                  : { color: foreground }
                : accent === undefined
                  ? {}
                  : { color: accent })}
            >
              {line}
            </Text>
          ))}
        </Box>
      )}
      {!showWordmark || compactVertical ? null : (
        <Text {...(muted === undefined ? {} : { color: muted })}>Scientific work, kept local.</Text>
      )}
      {showSetup ? (
        <Box
          marginTop={showWordmark ? 1 : 0}
          flexDirection="column"
          alignItems="center"
          width="100%"
        >
          <Text wrap="truncate-end" {...(foreground === undefined ? {} : { color: foreground })}>
            <Text bold {...(accent === undefined ? {} : { color: accent })}>
              {setup.command}
            </Text>
            {` \u00b7 ${setup.detail}`}
          </Text>
          {!showWordmark || compactVertical ? null : (
            <Text wrap="truncate-end" {...(muted === undefined ? {} : { color: muted })}>
              Markdown and LaTeX stay as canonical source.
            </Text>
          )}
        </Box>
      ) : null}
      {props.children === undefined ? null : (
        <Box
          marginTop={childMargin}
          width="100%"
          flexShrink={0}
          {...(surface === undefined ? {} : { backgroundColor: surface })}
        >
          {props.children}
        </Box>
      )}
    </Box>
  );
}
