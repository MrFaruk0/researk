import { LatexRenderBudget } from "@researk/latex-renderer";
import { Box, type DOMElement, Text, useBoxMetrics } from "ink";
import { type ReactNode, useEffect, useRef } from "react";
import { type ContentBlock, type ContentSegment, classifyContent } from "../content.js";
import { type FormulaRef, indexConversationFormulas } from "../formulas.js";
import {
  FormulaGraphic,
  type FormulaGraphicsRefLike,
  type FormulaGraphicsRuntime,
} from "../graphics.js";
import { type ConversationEntry, displayText, type MessageRole } from "../state.js";
import { formulaRenderStyle, type TuiTheme, themeColor } from "../theme.js";

function roleToken(role: MessageRole): "userMessage" | "assistantMessage" | "toolMessage" {
  if (role === "user") return "userMessage";
  if (role === "assistant") return "assistantMessage";
  return "toolMessage";
}

function roleSurfaceToken(role: MessageRole): "userSurface" | "assistantSurface" | "surfaceMuted" {
  if (role === "user") return "userSurface";
  if (role === "assistant") return "assistantSurface";
  return "surfaceMuted";
}

/** User and assistant surfaces are intentionally unlabeled; tools/system entries retain semantics. */
function roleLabel(role: MessageRole): string | undefined {
  if (role === "tool") return "tool";
  if (role === "system") return "system";
  return undefined;
}

function colorProp(color: string | undefined): { readonly color: string } | Record<string, never> {
  return color === undefined ? {} : { color };
}

function backgroundProp(
  backgroundColor: string | undefined,
): { readonly backgroundColor: string } | Record<string, never> {
  return backgroundColor === undefined ? {} : { backgroundColor };
}

function borderProp(
  borderColor: string | undefined,
): { readonly borderColor: string } | Record<string, never> {
  return borderColor === undefined ? {} : { borderColor };
}

interface FormulaRenderContext {
  readonly budget: LatexRenderBudget;
  readonly runtime: FormulaGraphicsRuntime;
  readonly renderStyle?: ReturnType<typeof formulaRenderStyle>;
  readonly selectedFormulaKey: string | undefined;
  readonly clipRef?: FormulaGraphicsRefLike;
  readonly refs: readonly FormulaRef[];
  cursor: number;
}

function createFormulaRenderContext(
  entry: ConversationEntry,
  theme: TuiTheme,
  budget: LatexRenderBudget,
  runtime: FormulaGraphicsRuntime | undefined,
  selectedFormulaKey: string | undefined,
  clipRef: FormulaGraphicsRefLike | undefined,
): FormulaRenderContext | undefined {
  if (
    entry.role !== "assistant" ||
    !theme.colorEnabled ||
    runtime === undefined ||
    runtime.disposed
  ) {
    return undefined;
  }
  if (!runtime.supportsGraphics()) return undefined;
  const refs = indexConversationFormulas([entry]);
  return refs.length === 0
    ? undefined
    : {
        budget,
        cursor: 0,
        refs,
        runtime,
        renderStyle: formulaRenderStyle(theme, runtime.rendererId),
        selectedFormulaKey,
        ...(clipRef === undefined ? {} : { clipRef }),
      };
}

/** Consume one indexed formula in parser order; never search by source text. */
function takeFormula(
  context: FormulaRenderContext,
  source: string,
  kind: FormulaRef["kind"],
): FormulaRef | undefined {
  const formula = context.refs[context.cursor];
  context.cursor += 1;
  if (formula === undefined || formula.kind !== kind || formula.source !== source) return undefined;
  return formula;
}

function hasInlineMath(segments: readonly ContentSegment[]): boolean {
  return segments.some((segment) => segment.kind === "inline-math");
}

function selectedFormula(context: FormulaRenderContext, formula: FormulaRef): boolean {
  return context.selectedFormulaKey === formula.key;
}

function FormulaSlot(props: {
  readonly budget: LatexRenderBudget;
  readonly context: FormulaRenderContext;
  readonly formula: FormulaRef;
  readonly display: boolean;
  readonly mathColor: string | undefined;
  readonly accentColor: string | undefined;
  readonly renderStyle?: ReturnType<typeof formulaRenderStyle>;
  readonly bold?: boolean;
}): ReactNode {
  const selected = selectedFormula(props.context, props.formula);
  const marker = selected ? "\u25b8 " : props.display ? "" : "  ";
  const boldProp = props.bold === undefined ? {} : { bold: props.bold };
  const selectedColorProp =
    props.accentColor === undefined ? {} : { selectedColor: props.accentColor };
  return (
    <Box flexDirection="row" flexShrink={0}>
      <Text {...boldProp} {...colorProp(selected ? props.accentColor : undefined)}>
        {marker}
      </Text>
      <FormulaGraphic
        runtime={props.context.runtime}
        formulaKey={props.formula.key}
        exactSource={props.formula.source}
        innerTex={props.formula.tex}
        display={props.display}
        inline={!props.display}
        selected={selected}
        renderBudget={props.budget}
        {...(props.renderStyle === undefined ? {} : { renderStyle: props.renderStyle })}
        style={{
          ...colorProp(props.mathColor),
          ...boldProp,
          ...selectedColorProp,
        }}
        {...(props.context.clipRef === undefined ? {} : { clipRef: props.context.clipRef })}
      />
    </Box>
  );
}

function StyledSegment(props: {
  readonly theme: TuiTheme;
  readonly segment: ContentSegment;
  readonly baseColor: string | undefined;
  readonly keyValue: string;
  readonly bold?: boolean;
}): ReactNode {
  const math = themeColor(props.theme, "math");
  const code = themeColor(props.theme, "code");
  const citation = themeColor(props.theme, "citation");
  const text = displayText(props.segment.text);
  const boldProp = props.bold === undefined ? {} : { bold: props.bold };
  if (props.segment.kind === "code") {
    return (
      <Text key={props.keyValue} {...boldProp} {...colorProp(code)}>
        {text}
      </Text>
    );
  }
  if (props.segment.kind === "inline-math") {
    return (
      <Text key={props.keyValue} {...boldProp} {...colorProp(math)}>
        {text}
      </Text>
    );
  }
  if (props.segment.kind === "citation") {
    return (
      <Text key={props.keyValue} {...boldProp} {...colorProp(citation)}>
        {text}
      </Text>
    );
  }
  return (
    <Text key={props.keyValue} {...boldProp} {...colorProp(props.baseColor)}>
      {text}
    </Text>
  );
}

function Segments(props: {
  readonly theme: TuiTheme;
  readonly segments: readonly ContentSegment[];
  readonly baseColor: string | undefined;
}): ReactNode {
  return (
    <Text>
      {props.segments.map((segment, index) => {
        // Content-derived, with the position only as a disambiguator for repeated text.
        const key = segment.kind + ":" + segment.text + "#" + index;
        // This is the actual rendering boundary. Canonical source is classified, never rewritten;
        // only the string handed to Ink is neutralized.
        return StyledSegment({
          baseColor: props.baseColor,
          keyValue: key,
          segment,
          theme: props.theme,
        });
      })}
    </Text>
  );
}

function FormulaSegments(props: {
  readonly theme: TuiTheme;
  readonly segments: readonly ContentSegment[];
  readonly baseColor: string | undefined;
  readonly context: FormulaRenderContext;
  readonly accentColor: string | undefined;
  readonly mathColor: string | undefined;
  readonly bold?: boolean;
  readonly leading?: (row: number) => ReactNode;
}): ReactNode {
  const rows: ReactNode[] = [];
  let prose: ContentSegment[] = [];
  let row = 0;
  const boldProp = props.bold === undefined ? {} : { bold: props.bold };

  const pushProse = (): void => {
    if (prose.length === 0) return;
    const segments = prose;
    prose = [];
    rows.push(
      <Box key={`prose:${row}`} flexDirection="row" width="100%">
        {props.leading?.(row)}
        <Text {...boldProp}>
          {segments.map((segment, index) =>
            StyledSegment({
              baseColor: props.baseColor,
              keyValue: segment.kind + ":" + segment.text + "#" + index,
              segment,
              theme: props.theme,
              ...boldProp,
            }),
          )}
        </Text>
      </Box>,
    );
    row += 1;
  };

  props.segments.forEach((segment, index) => {
    if (segment.kind !== "inline-math") {
      prose.push(segment);
      return;
    }

    pushProse();
    const formula = takeFormula(props.context, segment.text, "inline");
    rows.push(
      <Box key={`formula:${formula?.key ?? index}`} flexDirection="row" width="100%">
        {props.leading?.(row)}
        {formula === undefined ? (
          <Text {...boldProp} {...colorProp(props.mathColor)}>
            {displayText(segment.text)}
          </Text>
        ) : (
          <FormulaSlot
            accentColor={props.accentColor}
            budget={props.context.budget}
            context={props.context}
            display={false}
            formula={formula}
            mathColor={props.mathColor}
            renderStyle={props.context.renderStyle}
            {...(props.bold === undefined ? {} : { bold: props.bold })}
          />
        )}
      </Box>,
    );
    row += 1;
  });
  pushProse();

  return (
    <Box flexDirection="column" flexShrink={0} width="100%">
      {rows}
    </Box>
  );
}

function Block(props: {
  readonly theme: TuiTheme;
  readonly block: ContentBlock;
  readonly baseColor: string | undefined;
  readonly formulaContext?: FormulaRenderContext;
}): ReactNode {
  const { block, theme } = props;
  const accent = themeColor(theme, "accent");
  const muted = themeColor(theme, "muted");
  const border = themeColor(theme, "border");
  const surfaceMuted = themeColor(theme, "surfaceMuted");
  const math = themeColor(theme, "math");
  const code = themeColor(theme, "code");

  switch (block.kind) {
    case "blank":
      return <Text> </Text>;
    case "heading":
      if (props.formulaContext !== undefined && hasInlineMath(block.segments)) {
        const prefix = "#".repeat(block.level) + " ";
        return (
          <FormulaSegments
            accentColor={accent}
            baseColor={props.baseColor}
            bold
            context={props.formulaContext}
            leading={(row) => (
              <Text bold {...colorProp(accent)}>
                {row === 0 ? prefix : " ".repeat(prefix.length)}
              </Text>
            )}
            mathColor={math}
            segments={block.segments}
            theme={theme}
          />
        );
      }
      return (
        <Text bold>
          <Text {...colorProp(accent)}>{"#".repeat(block.level) + " "}</Text>
          <Segments theme={theme} segments={block.segments} baseColor={props.baseColor} />
        </Text>
      );
    case "quote":
      if (props.formulaContext !== undefined && hasInlineMath(block.segments)) {
        return (
          <FormulaSegments
            accentColor={accent}
            baseColor={muted}
            context={props.formulaContext}
            leading={() => <Text {...colorProp(muted)}>{"\u2502 "}</Text>}
            mathColor={math}
            segments={block.segments}
            theme={theme}
          />
        );
      }
      return (
        <Box>
          <Text {...colorProp(muted)}>{"\u2502 "}</Text>
          <Segments theme={theme} segments={block.segments} baseColor={muted} />
        </Box>
      );
    case "list-item":
      if (props.formulaContext !== undefined && hasInlineMath(block.segments)) {
        const marker = displayText(block.marker) + " ";
        return (
          <FormulaSegments
            accentColor={accent}
            baseColor={props.baseColor}
            context={props.formulaContext}
            leading={(row) => (
              <Text {...colorProp(accent)}>{row === 0 ? marker : " ".repeat(marker.length)}</Text>
            )}
            mathColor={math}
            segments={block.segments}
            theme={theme}
          />
        );
      }
      return (
        <Box>
          <Text {...colorProp(accent)}>{displayText(block.marker) + " "}</Text>
          <Segments theme={theme} segments={block.segments} baseColor={props.baseColor} />
        </Box>
      );
    case "code-block":
      return (
        <Box
          flexDirection="column"
          width="100%"
          borderStyle="single"
          paddingX={1}
          {...borderProp(border)}
          {...backgroundProp(surfaceMuted)}
        >
          {block.language.length === 0 ? null : (
            <Text {...colorProp(muted)}>{displayText(block.language)}</Text>
          )}
          {/* Ink renders embedded newlines while preserving the code source as display text. */}
          <Text {...colorProp(code)}>
            {block.lines.length === 0 ? " " : displayText(block.lines.join("\n"))}
          </Text>
        </Box>
      );
    case "display-math":
      // Delimiters and source are shown verbatim as safe display text. No TeX engine, Unicode
      // approximation, or terminal graphics protocol participates in rendering.
      return (
        <Box flexDirection="column" width="100%" marginY={1}>
          {props.formulaContext === undefined ? (
            <Text {...colorProp(math)}>{displayText(block.source)}</Text>
          ) : (
            (() => {
              const formula = takeFormula(props.formulaContext, block.source, "display");
              return formula === undefined ? (
                <Text {...colorProp(math)}>{displayText(block.source)}</Text>
              ) : (
                <FormulaSlot
                  accentColor={accent}
                  budget={props.formulaContext.budget}
                  context={props.formulaContext}
                  display
                  formula={formula}
                  mathColor={math}
                  renderStyle={props.formulaContext.renderStyle}
                />
              );
            })()
          )}
        </Box>
      );
    case "paragraph":
      if (props.formulaContext !== undefined && hasInlineMath(block.segments)) {
        return (
          <FormulaSegments
            accentColor={accent}
            baseColor={props.baseColor}
            context={props.formulaContext}
            mathColor={math}
            segments={block.segments}
            theme={theme}
          />
        );
      }
      return <Segments theme={theme} segments={block.segments} baseColor={props.baseColor} />;
  }
}

function segmentsIdentity(segments: readonly ContentSegment[]): string {
  return segments.map((segment) => segment.kind + ":" + segment.text).join("");
}

function blockIdentity(block: ContentBlock): string {
  switch (block.kind) {
    case "blank":
      return "blank";
    case "heading":
      return "heading:" + block.level + ":" + segmentsIdentity(block.segments);
    case "list-item":
      return "list:" + block.marker + ":" + segmentsIdentity(block.segments);
    case "quote":
      return "quote:" + segmentsIdentity(block.segments);
    case "code-block":
      return "code:" + block.language + ":" + block.lines.join("\n");
    case "display-math":
      return "math:" + block.source;
    case "paragraph":
      return "para:" + segmentsIdentity(block.segments);
  }
}

/** Derives content-based keys so streaming appends keep earlier blocks mounted. */
function keyedBlocks(
  blocks: readonly ContentBlock[],
): readonly { readonly key: string; readonly block: ContentBlock }[] {
  const seen = new Map<string, number>();
  return blocks.map((block) => {
    const identity = blockIdentity(block);
    const repeat = seen.get(identity) ?? 0;
    seen.set(identity, repeat + 1);
    return { key: identity + "#" + repeat, block };
  });
}

export function ConversationMessage(props: {
  readonly theme: TuiTheme;
  readonly entry: ConversationEntry;
  readonly graphicsRuntime?: FormulaGraphicsRuntime;
  readonly selectedFormulaKey?: string;
  readonly clipRef?: FormulaGraphicsRefLike;
}): ReactNode {
  const { entry, theme } = props;
  // Keep one budget for this keyed assistant response across theme/layout rerenders. A later
  // response mounts a different message and therefore receives a fresh budget.
  const formulaRenderBudget = useRef<LatexRenderBudget | undefined>(undefined);
  formulaRenderBudget.current ??= new LatexRenderBudget();
  const baseColor = themeColor(theme, roleToken(entry.role));
  const muted = themeColor(theme, "muted");
  const border = themeColor(theme, "border");
  const surface = themeColor(theme, roleSurfaceToken(entry.role));
  const blocks = classifyContent(entry.source);
  const label = roleLabel(entry.role);
  const formulaContext = createFormulaRenderContext(
    entry,
    theme,
    formulaRenderBudget.current,
    props.graphicsRuntime,
    props.selectedFormulaKey,
    props.clipRef,
  );

  return (
    <Box
      flexDirection="column"
      width="100%"
      alignSelf="stretch"
      marginBottom={1}
      paddingX={1}
      borderStyle="single"
      {...borderProp(border)}
      {...backgroundProp(surface)}
    >
      {label === undefined ? null : (
        <Text bold {...colorProp(baseColor)}>
          {label}
        </Text>
      )}
      {blocks.length === 0 ? (
        <Text {...colorProp(muted)}>{entry.streaming ? "\u2026" : " "}</Text>
      ) : (
        keyedBlocks(blocks).map((item) => (
          <Block
            key={item.key}
            theme={theme}
            block={item.block}
            baseColor={baseColor}
            {...(formulaContext === undefined ? {} : { formulaContext })}
          />
        ))
      )}
      {entry.streaming && blocks.length > 0 ? <Text {...colorProp(muted)}>{"\u2026"}</Text> : null}
    </Box>
  );
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, Number.isFinite(value) ? value : 0));
}

export function Conversation(props: {
  readonly theme: TuiTheme;
  readonly entries: readonly ConversationEntry[];
  readonly graphicsRuntime?: FormulaGraphicsRuntime;
  readonly selectedFormulaKey?: string;
  /** Fixed row height of the conversation region supplied by the full-screen layout. */
  readonly height: number;
  /** Rendered rows from the bottom: 0 follows the tail; larger values reveal older rows. */
  readonly scrollOffset: number;
  readonly emptyHint: string;
  /** Reports measured rendered-row range changes for the state/controller layer. */
  readonly onScrollRangeChange?: (maxScrollRows: number) => void;
}): ReactNode {
  const outerRef = useRef<DOMElement | null>(null);
  const innerRef = useRef<DOMElement | null>(null);
  const viewportMetrics = useBoxMetrics(outerRef);
  const contentMetrics = useBoxMetrics(innerRef);
  const lastMaxScroll = useRef<number | undefined>(undefined);
  const viewportHeight = Math.max(1, props.height);
  const measuredViewportHeight = viewportMetrics.hasMeasured
    ? viewportMetrics.height
    : viewportHeight;
  const maxScroll = Math.max(0, Math.ceil(contentMetrics.height - measuredViewportHeight));
  const effectiveOffset = clamp(props.scrollOffset, 0, maxScroll);
  const marginTop = -(maxScroll - effectiveOffset);
  const muted = themeColor(props.theme, "muted");

  useEffect(() => {
    if (!viewportMetrics.hasMeasured || !contentMetrics.hasMeasured) return;
    if (lastMaxScroll.current === maxScroll) return;
    lastMaxScroll.current = maxScroll;
    props.onScrollRangeChange?.(maxScroll);
  }, [
    contentMetrics.hasMeasured,
    maxScroll,
    props.onScrollRangeChange,
    viewportMetrics.hasMeasured,
  ]);

  return (
    <Box
      ref={outerRef}
      flexDirection="column"
      flexShrink={0}
      minHeight={0}
      width="100%"
      height={viewportHeight}
      paddingX={1}
      overflow="hidden"
      justifyContent={props.entries.length === 0 ? "center" : "flex-start"}
    >
      <Box
        ref={innerRef}
        flexDirection="column"
        flexShrink={0}
        width="100%"
        marginTop={props.entries.length === 0 ? 0 : marginTop}
      >
        {props.entries.length === 0 ? (
          <Text {...colorProp(muted)}>{displayText(props.emptyHint)}</Text>
        ) : (
          props.entries.map((entry) => (
            <ConversationMessage
              key={entry.id}
              theme={props.theme}
              entry={entry}
              clipRef={outerRef}
              {...(props.graphicsRuntime === undefined
                ? {}
                : { graphicsRuntime: props.graphicsRuntime })}
              {...(props.selectedFormulaKey === undefined
                ? {}
                : { selectedFormulaKey: props.selectedFormulaKey })}
            />
          ))
        )}
      </Box>
    </Box>
  );
}
