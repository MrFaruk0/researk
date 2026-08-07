import type { Writable } from "node:stream";
import { type LatexRenderBudget, renderTexToSvg } from "@researk/latex-renderer";
import type { CliTheme } from "../theme.js";
import type { MarkdownRenderEvent, MathRenderEvent } from "./parser.js";
import { detectTerminalCapability, renderTerminalMath } from "./terminal.js";

export interface RenderedMath {
  readonly format: "source" | "svg";
  readonly content: string;
}

export interface MathRenderer {
  readonly id: string;
  readonly available: boolean;
  render(event: MathRenderEvent, signal?: AbortSignal): Promise<RenderedMath>;
}

/** Local MathJax adapter. SVG remains an in-memory presentation artifact. */
export class MathJaxSvgMathRenderer implements MathRenderer {
  readonly id = "mathjax-4.1.3-svg";
  readonly available = true;
  async render(event: MathRenderEvent, signal?: AbortSignal): Promise<RenderedMath> {
    signal?.throwIfAborted();
    return {
      format: "svg",
      content: (
        await renderTexToSvg(
          { tex: event.tex, display: event.kind === "display" },
          signal === undefined ? {} : { signal },
        )
      ).svg,
    };
  }
}

export class ExactSourceMathRenderer implements MathRenderer {
  readonly id = "exact-source";
  readonly available = true;

  async render(event: MathRenderEvent, signal?: AbortSignal): Promise<RenderedMath> {
    signal?.throwIfAborted();
    return { format: "source", content: event.source };
  }
}

export const GRAPHICS_CAPABILITY = Object.freeze({
  mathJaxSvg: true,
  resvg: true,
  kitty: false,
  iterm2: true,
  sixel: false,
  reason: "Terminal protocol support is detected per interactive output stream.",
});

export async function renderInteractiveEvents(
  events: readonly MarkdownRenderEvent[],
  options: TerminalPresentationOptions & {
    readonly stdout: Writable;
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly writeText?: (value: string) => Promise<void>;
    readonly budget?: LatexRenderBudget;
    readonly signal?: AbortSignal;
  },
): Promise<string> {
  if (options.accessible === true || options.interactive !== true) {
    return events.map((event) => event.source).join("");
  }
  const capability = detectTerminalCapability(
    options.stdout as Writable & { readonly isTTY?: boolean },
    options.env,
  );
  const output: string[] = [];
  for (const event of events) {
    if (
      event.type === "math" &&
      event.kind === "display" &&
      capability.protocol !== "unsupported"
    ) {
      if (options.writeText !== undefined && output.length > 0) {
        await options.writeText(output.join(""));
        output.length = 0;
      }
      if (
        await renderTerminalMath(event, capability, options.stdout, options.budget, options.signal)
      ) {
        continue;
      }
    }
    output.push(renderTerminalPresentation([event], options));
  }
  return output.join("");
}

export async function renderExactSource(
  events: readonly MarkdownRenderEvent[],
  renderer: MathRenderer = new ExactSourceMathRenderer(),
  signal?: AbortSignal,
): Promise<string> {
  const output: string[] = [];
  for (const event of events) {
    signal?.throwIfAborted();
    if (event.type === "math") {
      output.push((await renderer.render(event, signal)).content);
    } else {
      output.push(event.source);
    }
  }
  return output.join("");
}

export interface TerminalPresentationOptions {
  readonly theme?: CliTheme;
  readonly accessible?: boolean;
  readonly interactive?: boolean;
}

export function renderTerminalPresentation(
  events: readonly MarkdownRenderEvent[],
  options: TerminalPresentationOptions = {},
): string {
  if (options.accessible === true || options.interactive !== true || options.theme === undefined) {
    return events.map((event) => event.source).join("");
  }
  return events
    .map((event) => {
      if (event.type === "math") {
        const value = options.theme?.math(event.source) ?? event.source;
        return event.kind === "display" ? `\n${value}\n` : value;
      }
      if (event.type === "code") return options.theme?.code(event.source) ?? event.source;
      return event.source
        .split(/(\n)/u)
        .map((part) => {
          if (part === "\n" || part.length === 0) return part;
          if (/^ {0,3}#{1,6}\s/u.test(part)) return options.theme?.heading(part) ?? part;
          if (/^\s*(?:[-*+] |\d+\. |>|```)/u.test(part)) return options.theme?.accent(part) ?? part;
          return part;
        })
        .join("");
    })
    .join("");
}
