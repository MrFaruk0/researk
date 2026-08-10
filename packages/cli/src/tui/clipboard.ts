import { Buffer } from "node:buffer";

/** The OSC 52 target used by this adapter: the terminal's clipboard selection. */
export const OSC52_CLIPBOARD_TARGET = "c" as const;

/** BEL is the fixed OSC 52 terminator; no caller-controlled byte enters the sequence framing. */
export const OSC52_TERMINATOR = "\u0007" as const;

/** Maximum UTF-8 source size accepted before encoding, measured in decoded bytes. */
export const MAX_CLIPBOARD_SOURCE_BYTES = 64 * 1024;

/** Maximum base64 payload size accepted after encoding, measured in ASCII bytes. */
export const MAX_CLIPBOARD_ENCODED_BYTES = 64 * 1024;

/** The terminal facts required to authorize this explicit clipboard action. */
export interface ClipboardTerminalContext {
  readonly interactive: boolean;
  readonly accessible?: boolean;
  /** Existing CLI callers can pass the same stdout object used by rendering. */
  readonly stdout?: { readonly isTTY?: boolean };
  /** Small test and adapter seam for callers that already have a boolean TTY decision. */
  readonly isTTY?: boolean;
  readonly stdoutIsTTY?: boolean;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** An explicit multiplexer marker is treated as unsupported when present. */
  readonly multiplexer?: string | false;
}

export type ClipboardWrite = (sequence: string) => undefined | boolean | Promise<unknown>;

export type ClipboardFallbackReason =
  | "not-interactive"
  | "stdout-not-tty"
  | "accessible-mode"
  | "term-dumb"
  | "ci-environment"
  | "multiplexer-unsupported"
  | "empty-source"
  | "source-too-large"
  | "payload-too-large"
  | "write-failed";

export interface ClipboardSuccess {
  readonly ok: true;
  readonly reason: "copied";
  readonly decodedBytes: number;
  readonly encodedBytes: number;
}

export interface ClipboardFallback {
  readonly ok: false;
  readonly reason: ClipboardFallbackReason;
  readonly decodedBytes?: number;
  readonly encodedBytes?: number;
}

export type ClipboardResult = ClipboardSuccess | ClipboardFallback;

/**
 * Copies an already-redacted canonical formula source through a trusted OSC 52 writer.
 *
 * The only sequence this module authorizes is `ESC ] 52 ; c ; <base64> BEL`. The source is UTF-8
 * encoded and then base64 encoded before it reaches that sequence, so source bytes and terminal
 * controls cannot become OSC framing or payload bytes. This function performs no process, file, or
 * network I/O; the caller owns the explicit action and supplies the trusted writer.
 */
export async function copyFormulaSource(
  source: string,
  context: ClipboardTerminalContext,
  write: ClipboardWrite,
): Promise<ClipboardResult> {
  const eligibility = terminalFallbackReason(context);
  if (eligibility !== undefined) return { ok: false, reason: eligibility };

  if (source.length === 0) return { ok: false, reason: "empty-source" };

  const decodedBytes = Buffer.byteLength(source, "utf8");
  if (decodedBytes > MAX_CLIPBOARD_SOURCE_BYTES) {
    return { ok: false, reason: "source-too-large", decodedBytes };
  }

  const encoded = Buffer.from(source, "utf8").toString("base64");
  const encodedBytes = Buffer.byteLength(encoded, "ascii");
  if (encodedBytes > MAX_CLIPBOARD_ENCODED_BYTES) {
    return { ok: false, reason: "payload-too-large", decodedBytes, encodedBytes };
  }

  // The framing is constant and the payload alphabet is base64 (ASCII only). No source or
  // caller-controlled control byte is interpolated into the OSC sequence.
  const sequence = `\u001b]52;${OSC52_CLIPBOARD_TARGET};${encoded}${OSC52_TERMINATOR}`;
  try {
    const result = await write(sequence);
    if (result === false) {
      return { ok: false, reason: "write-failed", decodedBytes, encodedBytes };
    }
    return { ok: true, reason: "copied", decodedBytes, encodedBytes };
  } catch {
    return { ok: false, reason: "write-failed", decodedBytes, encodedBytes };
  }
}

function terminalFallbackReason(
  context: ClipboardTerminalContext,
):
  | Exclude<
      ClipboardFallbackReason,
      "empty-source" | "source-too-large" | "payload-too-large" | "write-failed"
    >
  | undefined {
  if (context.interactive !== true) return "not-interactive";
  const tty =
    context.stdout === undefined
      ? context.isTTY === true || context.stdoutIsTTY === true
      : context.stdout.isTTY === true;
  if (!tty) return "stdout-not-tty";
  if (context.accessible === true) return "accessible-mode";

  const env = context.env ?? {};
  const term = env.TERM?.toLowerCase();
  if (term === "dumb") return "term-dumb";
  if (env.CI !== undefined) return "ci-environment";
  if (context.multiplexer !== undefined && context.multiplexer !== false) {
    return "multiplexer-unsupported";
  }
  if (env.TMUX !== undefined || env.STY !== undefined || env.ZELLIJ !== undefined) {
    return "multiplexer-unsupported";
  }
  // TERM values identifying a screen/tmux session are a conservative fallback when a wrapper did
  // not preserve its usual environment marker.
  if (
    term === "screen" ||
    term?.startsWith("screen-") ||
    term === "tmux" ||
    term?.startsWith("tmux-")
  ) {
    return "multiplexer-unsupported";
  }
  return undefined;
}
