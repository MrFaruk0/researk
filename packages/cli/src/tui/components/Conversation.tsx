import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { classifyContent, type ContentBlock, type ContentSegment } from "../content.js";
import { type ConversationEntry, displayText, type MessageRole } from "../state.js";
import { themeColor, type TuiTheme } from "../theme.js";

function roleToken(role: MessageRole): "userMessage" | "assistantMessage" | "toolMessage" {
  if (role === "user") return "userMessage";
  if (role === "assistant") return "assistantMessage";
  return "toolMessage";
}

function roleLabel(role: MessageRole): string {
  switch (role) {
    case "user":
      return "you";
    case "assistant":
      return "researk";
    case "tool":
      return "tool";
    case "system":
      return "system";
  }
}

function Segments(props: {
  readonly theme: TuiTheme;
  readonly segments: readonly ContentSegment[];
  readonly baseColor: string | undefined;
}): ReactNode {
  const accent = themeColor(props.theme, "accent");
  const warning = themeColor(props.theme, "warning");
  const success = themeColor(props.theme, "success");
  return (
    <Text>
      {props.segments.map((segment, index) => {
        // Content-derived, with the position only as a disambiguator for repeated text.
        const key = `${segment.kind}:${segment.text}#${index}`;
        // The rendering boundary: classification ran on canonical source, and only the string
        // actually handed to Ink is neutralized.
        const text = displayText(segment.text);
        if (segment.kind === "code") {
          return (
            <Text key={key} {...(warning === undefined ? {} : { color: warning })}>
              {text}
            </Text>
          );
        }
        if (segment.kind === "inline-math") {
          return (
            <Text key={key} {...(accent === undefined ? {} : { color: accent })}>
              {text}
            </Text>
          );
        }
        if (segment.kind === "citation") {
          return (
            <Text key={key} {...(success === undefined ? {} : { color: success })}>
              {text}
            </Text>
          );
        }
        return (
          <Text key={key} {...(props.baseColor === undefined ? {} : { color: props.baseColor })}>
            {text}
          </Text>
        );
      })}
    </Text>
  );
}

function Block(props: {
  readonly theme: TuiTheme;
  readonly block: ContentBlock;
  readonly baseColor: string | undefined;
}): ReactNode {
  const { block, theme } = props;
  const accent = themeColor(theme, "accent");
  const muted = themeColor(theme, "muted");
  const warning = themeColor(theme, "warning");
  const border = themeColor(theme, "border");

  // Every string below crosses the rendering boundary, so each is projected through `displayText`.
  // Classification already ran on canonical source, so nothing here changes what is retained.
  switch (block.kind) {
    case "blank":
      return <Text> </Text>;
    case "heading":
      return (
        <Text bold {...(accent === undefined ? {} : { color: accent })}>
          {`${"#".repeat(block.level)} ${displayText(block.text)}`}
        </Text>
      );
    case "quote":
      return (
        <Box>
          <Text {...(muted === undefined ? {} : { color: muted })}>{"\u2502 "}</Text>
          <Text {...(muted === undefined ? {} : { color: muted })}>{displayText(block.text)}</Text>
        </Box>
      );
    case "list-item":
      return (
        <Box>
          <Text {...(accent === undefined ? {} : { color: accent })}>
            {`${displayText(block.marker)} `}
          </Text>
          <Text {...(props.baseColor === undefined ? {} : { color: props.baseColor })}>
            {displayText(block.text)}
          </Text>
        </Box>
      );
    case "code-block":
      return (
        <Box
          flexDirection="column"
          borderStyle="single"
          paddingX={1}
          {...(border === undefined ? {} : { borderColor: border })}
        >
          {block.language.length === 0 ? null : (
            <Text {...(muted === undefined ? {} : { color: muted })}>
              {displayText(block.language)}
            </Text>
          )}
          {/* Ink renders embedded newlines, so the block is one node rather than a keyed list. */}
          <Text {...(warning === undefined ? {} : { color: warning })}>
            {block.lines.length === 0 ? " " : displayText(block.lines.join("\n"))}
          </Text>
        </Box>
      );
    case "display-math":
      // Display math is separated onto its own indented lines. The canonical source is shown as
      // text; no terminal image protocol is emitted, so Ink's retained layout stays intact.
      return (
        <Box flexDirection="column" marginY={1} paddingLeft={2}>
          <Text {...(accent === undefined ? {} : { color: accent })}>
            {displayText(block.source)}
          </Text>
        </Box>
      );
    case "paragraph":
      return <Segments theme={theme} segments={block.segments} baseColor={props.baseColor} />;
  }
}

function blockIdentity(block: ContentBlock): string {
  switch (block.kind) {
    case "blank":
      return "blank";
    case "heading":
      return `heading:${block.level}:${block.text}`;
    case "list-item":
      return `list:${block.marker}:${block.text}`;
    case "quote":
      return `quote:${block.text}`;
    case "code-block":
      return `code:${block.language}:${block.lines.join("\n")}`;
    case "display-math":
      return `math:${block.source}`;
    case "paragraph":
      return `para:${block.segments.map((segment) => `${segment.kind}:${segment.text}`).join("")}`;
  }
}

/**
 * Derives content-based keys so streaming appends keep earlier blocks mounted.
 * A repeat counter disambiguates blocks whose content is identical.
 */
function keyedBlocks(
  blocks: readonly ContentBlock[],
): readonly { readonly key: string; readonly block: ContentBlock }[] {
  const seen = new Map<string, number>();
  return blocks.map((block) => {
    const identity = blockIdentity(block);
    const repeat = seen.get(identity) ?? 0;
    seen.set(identity, repeat + 1);
    return { key: `${identity}#${repeat}`, block };
  });
}

export function ConversationMessage(props: {
  readonly theme: TuiTheme;
  readonly entry: ConversationEntry;
}): ReactNode {
  const { entry, theme } = props;
  const baseColor = themeColor(theme, roleToken(entry.role));
  const muted = themeColor(theme, "muted");
  const blocks = classifyContent(entry.source);
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text bold {...(baseColor === undefined ? {} : { color: baseColor })}>
          {roleLabel(entry.role)}
        </Text>
        {entry.streaming ? (
          <Text {...(muted === undefined ? {} : { color: muted })}>{"  \u2026"}</Text>
        ) : null}
      </Box>
      {blocks.length === 0 ? (
        <Text {...(muted === undefined ? {} : { color: muted })}> </Text>
      ) : (
        keyedBlocks(blocks).map((entry) => (
          <Block key={entry.key} theme={theme} block={entry.block} baseColor={baseColor} />
        ))
      )}
    </Box>
  );
}

export function Conversation(props: {
  readonly theme: TuiTheme;
  readonly entries: readonly ConversationEntry[];
  readonly height: number;
  readonly scrollOffset: number;
  readonly emptyHint: string;
}): ReactNode {
  const muted = themeColor(props.theme, "muted");
  if (props.entries.length === 0) {
    return (
      <Box flexDirection="column" flexGrow={1} justifyContent="center" paddingX={1}>
        <Text {...(muted === undefined ? {} : { color: muted })}>{props.emptyHint}</Text>
      </Box>
    );
  }

  // The visible window is bounded so a long session cannot exceed the conversation region. The
  // offset counts entries away from the newest, and zero follows the live stream.
  const visibleCount = Math.max(1, Math.floor(props.height / 3));
  const end = Math.max(1, props.entries.length - props.scrollOffset);
  const start = Math.max(0, end - visibleCount);
  const visible = props.entries.slice(start, end);
  const hiddenAbove = start;
  const hiddenBelow = props.entries.length - end;

  return (
    <Box flexDirection="column" flexGrow={1} paddingX={1} overflow="hidden">
      {hiddenAbove > 0 ? (
        <Text {...(muted === undefined ? {} : { color: muted })}>
          {`\u2191 ${hiddenAbove} earlier message(s)`}
        </Text>
      ) : null}
      {visible.map((entry) => (
        <ConversationMessage key={entry.id} theme={props.theme} entry={entry} />
      ))}
      {hiddenBelow > 0 ? (
        <Text {...(muted === undefined ? {} : { color: muted })}>
          {`\u2193 ${hiddenBelow} newer message(s) \u00b7 PageDown to follow`}
        </Text>
      ) : null}
    </Box>
  );
}
