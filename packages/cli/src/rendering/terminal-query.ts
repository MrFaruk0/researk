import { Buffer } from "node:buffer";
import type { Writable } from "node:stream";
import {
  detectTerminalCapability,
  type TerminalCapability,
  type TerminalGraphicsProtocol,
} from "./terminal.js";

const ESC = 0x1b;
const APC_START = Buffer.from([ESC, 0x5f, 0x47]);
const STRING_TERMINATOR = Buffer.from([ESC, 0x5c]);
const CSI_START = Buffer.from([ESC, 0x5b]);
const MAX_QUERY_TIMEOUT_MS = 100;
const DEFAULT_QUERY_TIMEOUT_MS = 100;
const DEFAULT_RESPONSE_BUFFER_BYTES = 8 * 1024;
const MAX_RESPONSE_BUFFER_BYTES = 16 * 1024;
const MAX_CELL_PIXELS = 4096;
const MAX_CELL_AREA = MAX_CELL_PIXELS * MAX_CELL_PIXELS;

/** One serialized, harmless Kitty query followed by DA1 and cell-pixel queries. */
export const KITTY_GRAPHICS_QUERY =
  "\u001b_Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA\u001b\\\u001b[c\u001b[16t";

/** Alias retained for callers that describe the operation as a terminal query. */
export const TERMINAL_GRAPHICS_QUERY = KITTY_GRAPHICS_QUERY;

export interface KittyGraphicsResponse {
  readonly id?: number;
  readonly message: string;
  readonly status: "ok" | "error";
  /** True only for the protocol's complete, literal `OK` response. */
  readonly explicitOk: boolean;
}

export interface CellPixelDimensions {
  readonly width: number;
  readonly height: number;
}

/**
 * Parse one Kitty APC response. Only printable protocol responses are accepted. In particular,
 * arbitrary APC data is not treated as a reply and is replayed by the broker.
 */
export function parseKittyGraphicsResponse(
  input: string | Uint8Array,
): KittyGraphicsResponse | undefined {
  const bytes = toBuffer(input);
  const start = bytes.indexOf(APC_START);
  if (start < 0) return undefined;
  const end = bytes.indexOf(STRING_TERMINATOR, start + APC_START.length);
  if (end < 0) return undefined;
  const body = bytes.subarray(start + APC_START.length, end).toString("ascii");
  const separator = body.indexOf(";");
  if (separator < 0) return undefined;
  const controls = body.slice(0, separator);
  const message = body.slice(separator + 1);
  if (!isPrintableAscii(controls) || !isPrintableAscii(message) || message.length === 0) {
    return undefined;
  }

  let id: number | undefined;
  if (controls.length > 0) {
    for (const field of controls.split(",")) {
      const equals = field.indexOf("=");
      if (equals <= 0 || equals === field.length - 1) return undefined;
      const key = field.slice(0, equals);
      const value = field.slice(equals + 1);
      if (key === "i") {
        if (!/^\d+$/u.test(value)) return undefined;
        const parsed = Number(value);
        if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 0xffff_ffff) {
          return undefined;
        }
        id = parsed;
      }
    }
  }
  const explicitOk = message === "OK";
  return {
    ...(id === undefined ? {} : { id }),
    message,
    status: explicitOk ? "ok" : "error",
    explicitOk,
  };
}

/** Short aliases make the pure parser convenient for protocol-focused callers and tests. */
export const parseKittyResponse = parseKittyGraphicsResponse;
export const parseKittyQueryResponse = parseKittyGraphicsResponse;

/** Parse the numeric parameters from a DA1 response such as `CSI ?1;2;4c`. */
export function parseDa1Parameters(input: string | Uint8Array): readonly number[] | undefined {
  const bytes = toBuffer(input);
  const match = findCsi(bytes, "c");
  if (match === undefined) return undefined;
  let parameters = match.parameters;
  if (parameters.startsWith("?") || parameters.startsWith(">")) {
    parameters = parameters.slice(1);
  }
  if (parameters.length === 0) return [];
  if (!/^\d+(?:;\d+)*$/u.test(parameters)) return undefined;
  const values = parameters.split(";").map((value) => Number(value));
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0)) return undefined;
  return values;
}

export const parseDa1Response = parseDa1Parameters;
export const parseDeviceAttributesParameters = parseDa1Parameters;

/** Parse `CSI 6;<height>;<width>t`, the response to `CSI 16 t`. */
export function parseCellPixelReply(input: string | Uint8Array): CellPixelDimensions | undefined {
  const bytes = toBuffer(input);
  const match = findCsi(bytes, "t");
  if (match === undefined || match.parameters === "") return undefined;
  const values = match.parameters.split(";");
  if (values.length !== 3 || values[0] !== "6" || values.some((value) => !/^\d+$/u.test(value))) {
    return undefined;
  }
  const height = Number(values[1]);
  const width = Number(values[2]);
  if (!validCellPixels(width, height)) return undefined;
  return { width, height };
}

export const parseCellPixelSize = parseCellPixelReply;
export const parseCellSizeReply = parseCellPixelReply;

export interface TerminalQueryInput {
  readonly isTTY?: boolean;
  readonly isRaw?: boolean;
  readonly readableFlowing?: boolean | null;
  isPaused?(): boolean;
  pause?(): unknown;
  resume?(): unknown;
  setRawMode?(enabled: boolean): unknown;
  on(event: "data", listener: (chunk: Buffer | Uint8Array | string) => void): unknown;
  off?(event: "data", listener: (chunk: Buffer | Uint8Array | string) => void): unknown;
  removeListener?(event: "data", listener: (chunk: Buffer | Uint8Array | string) => void): unknown;
}

export type TerminalQueryOutput = Writable & { readonly isTTY?: boolean };

export interface TerminalCapabilityProbeOptions {
  readonly stdin: TerminalQueryInput;
  readonly stdout: TerminalQueryOutput;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Explicit test/application gate. If omitted, both injected streams must advertise TTY. */
  readonly isTTY?: boolean;
  readonly tty?: boolean;
  readonly stdinIsTTY?: boolean;
  readonly stdoutIsTTY?: boolean;
  readonly interactive?: boolean;
  readonly accessible?: boolean;
  readonly raw?: boolean;
  readonly json?: boolean;
  readonly allowProbe?: boolean;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  /** Maximum buffered unmatched bytes before the optional replay sink is used as a handoff. */
  readonly maxReplayBytes?: number;
  /** Replay bytes that were not positively identified as protocol replies. */
  readonly replay?: (bytes: Uint8Array) => void;
  readonly onReplay?: (bytes: Uint8Array) => void;
}

export interface TerminalCapabilityProbeResult extends TerminalCapability {
  readonly timedOut: boolean;
  readonly replay: Uint8Array;
  readonly unmatchedInput: Uint8Array;
  readonly replayedInput: Uint8Array;
  readonly kittyResponse?: KittyGraphicsResponse;
  readonly da1Parameters?: readonly number[];
  readonly cellPixels?: CellPixelDimensions;
}

type ProbeOptionsWithoutStreams = Omit<TerminalCapabilityProbeOptions, "stdin" | "stdout" | "env">;

/**
 * Probe terminal graphics support with a bounded, temporary input broker. The positional overload
 * is useful to small embedders; the object form is preferred because all gates are explicit.
 */
export function probeTerminalCapability(
  options: TerminalCapabilityProbeOptions,
): Promise<TerminalCapabilityProbeResult>;
export function probeTerminalCapability(
  stdin: TerminalQueryInput,
  stdout: TerminalQueryOutput,
  env: Readonly<Record<string, string | undefined>>,
  options?: ProbeOptionsWithoutStreams,
): Promise<TerminalCapabilityProbeResult>;
export function probeTerminalCapability(
  first: TerminalCapabilityProbeOptions | TerminalQueryInput,
  second?: TerminalQueryOutput,
  third?: Readonly<Record<string, string | undefined>>,
  fourth?: ProbeOptionsWithoutStreams,
): Promise<TerminalCapabilityProbeResult> {
  const options: TerminalCapabilityProbeOptions =
    "stdin" in first
      ? first
      : {
          stdin: first,
          stdout: second as TerminalQueryOutput,
          env: third ?? {},
          ...(fourth ?? {}),
        };
  return runProbe(options);
}

export const probeTerminalGraphics = probeTerminalCapability;
export const queryTerminalCapability = probeTerminalCapability;

function runProbe(options: TerminalCapabilityProbeOptions): Promise<TerminalCapabilityProbeResult> {
  const outputTTY = options.stdoutIsTTY ?? options.stdout.isTTY === true;
  const inputTTY = options.stdinIsTTY ?? options.stdin.isTTY === true;
  const explicitTTY = options.isTTY ?? options.tty;
  const isTTY = explicitTTY ?? (outputTTY && inputTTY);
  const syncCapability = detectTerminalCapability({ isTTY }, options.env);
  const gateReason = probeGateReason(options, isTTY);
  if (gateReason !== undefined) {
    return Promise.resolve(makeResult(gateReason.protocol, gateReason.reason, false));
  }

  const timeoutMs = clamp(options.timeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS, 1, MAX_QUERY_TIMEOUT_MS);
  const maxResponseBytes = clamp(
    options.maxResponseBytes ?? DEFAULT_RESPONSE_BUFFER_BYTES,
    1,
    MAX_RESPONSE_BUFFER_BYTES,
  );
  const maxReplayBytes = clamp(
    options.maxReplayBytes ?? options.maxResponseBytes ?? DEFAULT_RESPONSE_BUFFER_BYTES,
    1,
    MAX_RESPONSE_BUFFER_BYTES,
  );

  return new Promise<TerminalCapabilityProbeResult>((resolve) => {
    let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    const replayParts: Buffer[] = [];
    const handoffParts: Buffer[] = [];
    const replayHandler = options.replay ?? options.onReplay;
    let kittyResponse: KittyGraphicsResponse | undefined;
    let da1Parameters: readonly number[] | undefined;
    let cellPixels: CellPixelDimensions | undefined;
    let finished = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let replaySize = 0;
    let replayExternalized = false;
    let replayOverflow = false;

    const wasPaused = options.stdin.isPaused?.();
    const wasFlowing = options.stdin.readableFlowing;
    const wasRaw = options.stdin.isRaw === true;
    let rawChanged = false;

    const appendReplay = (bytes: Uint8Array): void => {
      if (bytes.length === 0) return;
      const copy = Buffer.from(bytes);
      if (replayExternalized) {
        handoffParts.push(copy);
        return;
      }
      const nextSize = replaySize + copy.length;
      if (nextSize <= maxReplayBytes) {
        replayParts.push(copy);
        replaySize = nextSize;
        return;
      }
      if (replayHandler === undefined) {
        // Without a sink the result itself is the only lossless handoff. Retain the complete
        // accepted bytes, mark the overflow, and terminate immediately instead of waiting for the
        // timeout or silently dropping ordinary input.
        replayParts.push(copy);
        replaySize = nextSize;
        replayOverflow = true;
        return;
      }
      // Move the bounded prefix and this complete incoming chunk to a caller-owned handoff. The
      // probe will fail promptly; any remaining bytes from the same input event are appended to
      // the handoff before cleanup, so no normal keystroke is silently discarded.
      const buffered = Buffer.concat([...replayParts, copy]);
      replayParts.length = 0;
      replaySize = 0;
      handoffParts.push(buffered);
      replayExternalized = true;
      replayOverflow = true;
    };

    const restoreInput = (): void => {
      try {
        if (rawChanged) {
          options.stdin.setRawMode?.(wasRaw);
          rawChanged = false;
        }
      } catch {
        // Continue restoring flow even if a platform TTY rejects raw-mode restoration.
      }
      try {
        if (wasPaused === true || wasFlowing !== true) options.stdin.pause?.();
        else options.stdin.resume?.();
      } catch {
        // Cleanup must not turn a conservative capability result into a startup failure.
      }
    };

    const removeListener = (): void => {
      try {
        if (options.stdin.off !== undefined) options.stdin.off("data", onData);
        else options.stdin.removeListener?.("data", onData);
      } catch {
        // Some injected test streams expose only a minimal event surface.
      }
    };

    const finish = (
      timedOut: boolean,
      reason: string,
      forcedProtocol?: TerminalGraphicsProtocol,
    ) => {
      if (finished) return;
      finished = true;
      if (timer !== undefined) clearTimeout(timer);
      removeListener();
      restoreInput();
      const bufferedReplay = Buffer.concat(replayParts);
      const handoff = Buffer.concat(handoffParts);
      let replay = bufferedReplay;
      try {
        if (replayHandler !== undefined) {
          if (handoff.length > 0) replayHandler(Buffer.from(handoff));
          else if (bufferedReplay.length > 0) replayHandler(Buffer.from(bufferedReplay));
        } else if (handoff.length > 0) {
          replay = Buffer.concat([handoff, bufferedReplay]);
        }
      } catch {
        // A failed handoff remains available in the result rather than being silently discarded.
        replay = Buffer.concat([handoff, bufferedReplay]);
      }
      const protocol =
        forcedProtocol ??
        (kittyResponse?.explicitOk === true
          ? "kitty"
          : syncCapability.protocol === "iterm2"
            ? "iterm2"
            : sixelDetected(options.env, da1Parameters, cellPixels)
              ? "sixel"
              : "unsupported");
      const result = makeResult(protocol, reason, timedOut, {
        replay,
        ...(kittyResponse === undefined ? {} : { kittyResponse }),
        ...(da1Parameters === undefined ? {} : { da1Parameters }),
        ...(cellPixels === undefined ? {} : { cellPixels }),
      });
      resolve(result);
    };

    const onData = (chunk: Buffer | Uint8Array | string): void => {
      if (finished) return;
      const bytes = toBuffer(chunk);
      if (bytes.length === 0) return;
      pending = pending.length === 0 ? bytes : Buffer.concat([pending, bytes]);
      if (pending.length > maxResponseBytes) {
        appendReplay(pending);
        pending = Buffer.alloc(0);
        finish(false, "probe response exceeded the bounded buffer");
        return;
      }
      drainPending();
      if (replayOverflow) {
        if (pending.length > 0) {
          appendReplay(pending);
          pending = Buffer.alloc(0);
        }
        finish(false, "probe replay exceeded the bounded buffer");
        return;
      }
      if (
        kittyResponse?.explicitOk === true &&
        kittyResponse.id === 31 &&
        da1Parameters !== undefined &&
        cellPixels !== undefined
      ) {
        finish(false, "explicit Kitty graphics query response");
      }
    };

    const drainPending = (): void => {
      while (pending.length > 0 && !finished && !replayOverflow) {
        const candidate = nextCandidate(pending);
        if (candidate === undefined) {
          const retained = protocolPrefixSuffixLength(pending);
          const flushLength = pending.length - retained;
          if (flushLength > 0) {
            appendReplay(pending.subarray(0, flushLength));
            pending = pending.subarray(flushLength);
          }
          return;
        }
        if (candidate.start > 0) {
          appendReplay(pending.subarray(0, candidate.start));
          pending = pending.subarray(candidate.start);
        }

        if (candidate.kind === "kitty") {
          const end = pending.indexOf(STRING_TERMINATOR, APC_START.length);
          if (end < 0) return;
          const frame = pending.subarray(0, end + STRING_TERMINATOR.length);
          const parsed = parseKittyGraphicsResponse(frame);
          if (parsed === undefined) {
            appendReplay(frame);
          } else {
            // A well-formed reply for our query ID belongs to the broker even when it reports an
            // error. Only literal OK grants Kitty capability; unrelated IDs remain replayable.
            if (parsed.id === 31) kittyResponse = parsed;
            else appendReplay(frame);
          }
          pending = pending.subarray(frame.length);
          continue;
        }

        const final = findCsiFinal(pending);
        if (final === undefined) return;
        const frame = pending.subarray(0, final + 1);
        if (pending[final] === 0x63) {
          const parsed = parseDa1Parameters(frame);
          if (parsed === undefined) {
            appendReplay(pending.subarray(0, 1));
            pending = pending.subarray(1);
          } else {
            da1Parameters = parsed;
            pending = pending.subarray(frame.length);
          }
        } else if (pending[final] === 0x74) {
          const parsed = parseCellPixelReply(frame);
          if (parsed === undefined) {
            appendReplay(pending.subarray(0, 1));
            pending = pending.subarray(1);
          } else {
            cellPixels = parsed;
            pending = pending.subarray(frame.length);
          }
        } else {
          appendReplay(pending.subarray(0, 1));
          pending = pending.subarray(1);
        }
      }
    };

    // The listener is installed while paused, then the previous flow state is restored at exit.
    try {
      timer = setTimeout(() => {
        if (pending.length > 0) appendReplay(pending);
        pending = Buffer.alloc(0);
        finish(true, "terminal graphics probe timed out");
      }, timeoutMs);
      options.stdin.pause?.();
      if (options.stdin.setRawMode !== undefined && !wasRaw) {
        rawChanged = true;
        options.stdin.setRawMode(true);
      }
      options.stdin.on("data", onData);
      options.stdin.resume?.();
      // A blocked output stream is still bounded by the same timeout; no second write is issued.
      if (!finished) options.stdout.write(KITTY_GRAPHICS_QUERY, "ascii");
    } catch {
      if (pending.length > 0) appendReplay(pending);
      pending = Buffer.alloc(0);
      finish(false, "terminal graphics probe could not be written");
    }
  });
}

function probeGateReason(
  options: TerminalCapabilityProbeOptions,
  isTTY: boolean,
): TerminalCapability | undefined {
  if (!isTTY) return { protocol: "unsupported", reason: "terminal graphics probe requires a TTY" };
  if (options.allowProbe === false) {
    return { protocol: "unsupported", reason: "terminal graphics probe disabled by caller" };
  }
  if (
    options.interactive === false ||
    options.accessible === true ||
    options.raw === true ||
    options.json === true
  ) {
    return {
      protocol: "unsupported",
      reason: "terminal graphics probe disabled for this output mode",
    };
  }
  if (options.env.TERM === "dumb" || options.env.CI !== undefined) {
    return { protocol: "unsupported", reason: "non-interactive terminal environment" };
  }
  if (
    options.env.TMUX !== undefined ||
    options.env.STY !== undefined ||
    options.env.TERM === "screen" ||
    options.env.TERM?.startsWith("screen-")
  ) {
    return { protocol: "unsupported", reason: "multiplexer passthrough is not verified" };
  }
  return undefined;
}

function makeResult(
  protocol: TerminalGraphicsProtocol,
  reason: string,
  timedOut: boolean,
  extras: Readonly<{
    readonly replay?: Uint8Array;
    readonly kittyResponse?: KittyGraphicsResponse;
    readonly da1Parameters?: readonly number[];
    readonly cellPixels?: CellPixelDimensions;
  }> = {},
): TerminalCapabilityProbeResult {
  const replay = Buffer.from(extras.replay ?? Buffer.alloc(0));
  return {
    protocol,
    reason,
    timedOut,
    replay,
    unmatchedInput: replay,
    replayedInput: replay,
    ...(extras.kittyResponse === undefined ? {} : { kittyResponse: extras.kittyResponse }),
    ...(extras.da1Parameters === undefined ? {} : { da1Parameters: extras.da1Parameters }),
    ...(extras.cellPixels === undefined ? {} : { cellPixels: extras.cellPixels }),
  };
}

function sixelDetected(
  env: Readonly<Record<string, string | undefined>>,
  da1Parameters: readonly number[] | undefined,
  cellPixels: CellPixelDimensions | undefined,
): boolean {
  return (
    env.WT_SESSION !== undefined &&
    env.WT_SESSION.length > 0 &&
    da1Parameters?.includes(4) === true &&
    cellPixels !== undefined
  );
}

function nextCandidate(
  bytes: Buffer,
): { readonly kind: "kitty" | "csi"; readonly start: number } | undefined {
  const kitty = bytes.indexOf(APC_START);
  const csi = bytes.indexOf(CSI_START);
  if (kitty < 0 && csi < 0) return undefined;
  if (kitty < 0) return { kind: "csi", start: csi };
  if (csi < 0) return { kind: "kitty", start: kitty };
  return kitty < csi ? { kind: "kitty", start: kitty } : { kind: "csi", start: csi };
}

/** Keep only a suffix that can still become the beginning of a protocol reply on the next chunk. */
function protocolPrefixSuffixLength(bytes: Buffer): number {
  const prefixes = [APC_START, CSI_START] as const;
  let longest = 0;
  for (const prefix of prefixes) {
    for (let length = 1; length < prefix.length && length <= bytes.length; length += 1) {
      const start = bytes.length - length;
      let matches = true;
      for (let offset = 0; offset < length; offset += 1) {
        if (bytes[start + offset] !== prefix[offset]) {
          matches = false;
          break;
        }
      }
      if (matches) longest = Math.max(longest, length);
    }
  }
  return longest;
}

function findCsiFinal(bytes: Buffer): number | undefined {
  for (let index = CSI_START.length; index < bytes.length; index += 1) {
    const value = bytes[index];
    if (value !== undefined && value >= 0x40 && value <= 0x7e) return index;
  }
  return undefined;
}

function findCsi(bytes: Buffer, final: string): { readonly parameters: string } | undefined {
  const expected = final.charCodeAt(0);
  let start = bytes.indexOf(CSI_START);
  while (start >= 0) {
    for (let index = start + CSI_START.length; index < bytes.length; index += 1) {
      const value = bytes[index];
      if (value === expected) {
        return {
          parameters: bytes.subarray(start + CSI_START.length, index).toString("ascii"),
        };
      }
      if (value !== undefined && value >= 0x40 && value <= 0x7e) break;
    }
    start = bytes.indexOf(CSI_START, start + 1);
  }
  return undefined;
}

function validCellPixels(width: number, height: number): boolean {
  return (
    Number.isSafeInteger(width) &&
    Number.isSafeInteger(height) &&
    width > 0 &&
    height > 0 &&
    width <= MAX_CELL_PIXELS &&
    height <= MAX_CELL_PIXELS &&
    width * height <= MAX_CELL_AREA
  );
}

function isPrintableAscii(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 0x20 || code > 0x7e) return false;
  }
  return true;
}

function toBuffer(value: string | Uint8Array): Buffer {
  return typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value);
}

function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, Math.trunc(value)));
}
