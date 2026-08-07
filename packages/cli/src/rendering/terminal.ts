import { Buffer } from "node:buffer";
import type { Writable } from "node:stream";
import { type LatexRenderBudget, renderTexToPng } from "@researk/latex-renderer";
import type { MarkdownRenderEvent, MathRenderEvent } from "./parser.js";

export type TerminalGraphicsProtocol = "iterm2" | "kitty" | "unsupported";

export interface TerminalCapability {
  readonly protocol: TerminalGraphicsProtocol;
  readonly reason: string;
}

/**
 * Capability detection is deliberately conservative. iTerm's documented identity is sufficient
 * for its inline-image protocol; kitty is not enabled until its bounded query/reply broker exists.
 */
export function detectTerminalCapability(
  stdout: { readonly isTTY?: boolean },
  env: Readonly<Record<string, string | undefined>>,
): TerminalCapability {
  if (stdout.isTTY !== true) return { protocol: "unsupported", reason: "stdout is not a TTY" };
  if (env.TERM === "dumb" || env.CI !== undefined) {
    return { protocol: "unsupported", reason: "non-interactive terminal environment" };
  }
  if (env.TMUX !== undefined || env.STY !== undefined) {
    return { protocol: "unsupported", reason: "multiplexer passthrough is not verified" };
  }
  const itermVersion = env.TERM_PROGRAM_VERSION ?? env.LC_TERMINAL_VERSION;
  if (
    (env.TERM_PROGRAM === "iTerm.app" || env.LC_TERMINAL === "iTerm2") &&
    itermVersion !== undefined &&
    /^\d+(?:\.\d+)+/u.test(itermVersion)
  ) {
    return { protocol: "iterm2", reason: "trusted iTerm2 terminal identity" };
  }
  return { protocol: "unsupported", reason: "no positively detected graphics protocol" };
}

export function reconstructCanonicalSource(events: readonly MarkdownRenderEvent[]): string {
  return events.map((event) => event.source).join("");
}

export async function renderTerminalMath(
  event: MathRenderEvent,
  capability: TerminalCapability,
  stdout: Writable,
  budget?: LatexRenderBudget,
  signal?: AbortSignal,
): Promise<boolean> {
  if (event.kind !== "display" || capability.protocol !== "iterm2") return false;
  try {
    const image = await renderTexToPng(
      { tex: event.tex, display: true },
      {
        ...(budget === undefined ? {} : { budget }),
        ...(signal === undefined ? {} : { signal }),
      },
    );
    const png = image.png;
    // iTerm2's protocol is emitted only by this trusted emitter. TeX never enters the sequence.
    const payload = Buffer.from(png).toString("base64");
    // Apply the protocol ceiling to what is actually emitted, not only the decoded PNG.
    if (Buffer.byteLength(payload, "ascii") > 8 * 1024 * 1024) return false;
    const sequence = `\u001b]1337;File=inline=1;preserveAspectRatio=1:${payload}\u0007\n`;
    if (!stdout.write(sequence)) {
      await new Promise<void>((resolve, reject) => {
        const drain = () => {
          cleanup();
          resolve();
        };
        const error = (reason: Error) => {
          cleanup();
          reject(reason);
        };
        const cleanup = () => {
          stdout.off("drain", drain);
          stdout.off("error", error);
        };
        stdout.once("drain", drain);
        stdout.once("error", error);
      });
    }
    return true;
  } catch {
    return false;
  }
}
