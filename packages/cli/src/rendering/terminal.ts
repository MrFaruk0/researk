import { Buffer } from "node:buffer";
import type { Writable } from "node:stream";
import {
  type LatexRenderBudget,
  type LatexRenderStyle,
  renderTexToPng,
} from "@researk/latex-renderer";
import type { MarkdownRenderEvent, MathRenderEvent } from "./parser.js";

export type TerminalGraphicsProtocol = "iterm2" | "kitty" | "sixel" | "unsupported";

export interface TerminalCapability {
  readonly protocol: TerminalGraphicsProtocol;
  readonly reason: string;
}

/** Shared environment gates used by both synchronous detection and the startup query broker. */
export function terminalEnvironmentGateReason(
  env: Readonly<Record<string, string | undefined>>,
): "non-interactive terminal environment" | "multiplexer passthrough is not verified" | undefined {
  const term = env.TERM?.trim().toLowerCase();
  if (term === "dumb" || env.CI !== undefined) return "non-interactive terminal environment";
  if (
    env.TMUX !== undefined ||
    env.STY !== undefined ||
    env.ZELLIJ !== undefined ||
    term === "screen" ||
    term?.startsWith("screen-") ||
    term === "tmux" ||
    term?.startsWith("tmux-")
  ) {
    return "multiplexer passthrough is not verified";
  }
  return undefined;
}

/**
 * Capability detection is deliberately conservative. iTerm's documented identity is sufficient
 * for its inline-image protocol. Kitty and Sixel are selected only by the separate bounded
 * startup probe; this synchronous helper intentionally performs no terminal I/O.
 */
export function detectTerminalCapability(
  stdout: { readonly isTTY?: boolean },
  env: Readonly<Record<string, string | undefined>>,
): TerminalCapability {
  if (stdout.isTTY !== true) return { protocol: "unsupported", reason: "stdout is not a TTY" };
  const environmentGate = terminalEnvironmentGateReason(env);
  if (environmentGate !== undefined) return { protocol: "unsupported", reason: environmentGate };
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

/**
 * The rasterization step, injectable for tests.
 *
 * Production always uses the packaged isolated-worker renderer. Tests use this seam to drive the
 * ADR 0006 fallback deterministically, without depending on native bindings or on which
 * expressions the renderer happens to accept for rasterization on a given host.
 */
export type TerminalMathImageRenderer = (
  request: { readonly tex: string; readonly display: boolean; readonly style?: LatexRenderStyle },
  options: { readonly budget?: LatexRenderBudget; readonly signal?: AbortSignal },
) => Promise<{ readonly png: Uint8Array }>;

/**
 * Emits display math as an inline image, or reports `false` so the caller presents exact source.
 *
 * Every failure path is a `false`, never a throw and never a partial image: an unsupported
 * protocol, a renderer that declines the expression (the worker fails closed on anything needing
 * font-backed text, such as CJK, emoji, or a MathJax error marker), a budget or timeout rejection,
 * or an oversized payload. This is the ADR 0006 contract: no graphic unless it is known correct.
 */
export async function renderTerminalMath(
  event: MathRenderEvent,
  capability: TerminalCapability,
  stdout: Writable,
  budget?: LatexRenderBudget,
  signal?: AbortSignal,
  renderImage: TerminalMathImageRenderer = renderTexToPng,
  style?: LatexRenderStyle,
): Promise<boolean> {
  if (event.kind !== "display" || capability.protocol !== "iterm2") return false;
  try {
    const image = await renderImage(
      { display: true, ...(style === undefined ? {} : { style }), tex: event.tex },
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
