import type { MarkdownRenderEvent, MathRenderEvent } from "./parser.js";

export interface RenderedMath {
  readonly format: "source" | "svg";
  readonly content: string;
}

export interface MathRenderer {
  readonly id: string;
  readonly available: boolean;
  render(event: MathRenderEvent, signal?: AbortSignal): Promise<RenderedMath>;
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
  mathJaxSvg: false,
  resvg: false,
  kitty: false,
  iterm2: false,
  sixel: false,
  reason: "Graphics are unavailable until the dependency licensing and packaging gate passes.",
});

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
