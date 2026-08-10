import { Buffer } from "node:buffer";
import type { Writable } from "node:stream";
import {
  detectTerminalCapability,
  type TerminalCapability,
  type TerminalGraphicsProtocol,
  terminalEnvironmentGateReason,
} from "./terminal.js";

const ESC = 0x1b;
const APC_START = Buffer.from([ESC, 0x5f, 0x47]);
const STRING_TERMINATOR = Buffer.from([ESC, 0x5c]);
const CSI_START = Buffer.from([ESC, 0x5b]);
const MAX_QUERY_TIMEOUT_MS = 100;
const DEFAULT_QUERY_TIMEOUT_MS = 100;
const DEFAULT_RESPONSE_BUFFER_BYTES = 8 * 1024;
const MAX_RESPONSE_BUFFER_BYTES = 16 * 1024;
const LATE_BROKER_WINDOW_MS = 50;
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
  const bodyBytes = bytes.subarray(start + APC_START.length, end);
  if (!isPrintableAsciiBytes(bodyBytes)) return undefined;
  const separator = bodyBytes.indexOf(0x3b);
  if (separator < 0) return undefined;
  const controls = bodyBytes.subarray(0, separator).toString("ascii");
  const message = bodyBytes.subarray(separator + 1).toString("ascii");
  if (controls.length === 0 || message.length === 0) {
    return undefined;
  }

  // A query reply has exactly one control field. Reject duplicate/unknown fields instead of
  // letting unrelated Kitty APCs or malformed controls influence capability selection.
  const equals = controls.indexOf("=");
  if (equals <= 0 || equals === controls.length - 1 || controls.indexOf(",") >= 0) {
    return undefined;
  }
  const key = controls.slice(0, equals);
  const value = controls.slice(equals + 1);
  if (key !== "i" || !/^\d+$/u.test(value)) return undefined;
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1 || id > 0xffff_ffff) return undefined;
  if (!isPrintableAscii(message)) return undefined;
  const explicitOk = message === "OK";
  return {
    id,
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
  if (!parameters.startsWith("?")) return undefined;
  parameters = parameters.slice(1);
  if (parameters.length === 0) return undefined;
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

type ReadableProbeInput = TerminalQueryInput & {
  readonly read?: () => Buffer | Uint8Array | string | null;
  on(event: "readable", listener: () => void): unknown;
  off?(event: "readable", listener: () => void): unknown;
  removeListener?(event: "readable", listener: () => void): unknown;
};

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
    const readableInput = options.stdin as ReadableProbeInput;
    let kittyResponse: KittyGraphicsResponse | undefined;
    let da1Parameters: readonly number[] | undefined;
    let cellPixels: CellPixelDimensions | undefined;
    let finished = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let replaySize = 0;
    let replayExternalized = false;
    let replayOverflow = false;
    let lateBrokerActive = false;
    let lateTimer: ReturnType<typeof setTimeout> | undefined;
    let latePending: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    const lateReplayParts: Buffer[] = [];
    let lateReplayBytes = 0;
    // Bytes that have already crossed the ordinary replay budget still have to stay ordered
    // behind an unresolved protocol candidate. They are deferred until the late broker retires;
    // keeping them separate means the candidate never consumes the ordinary replay budget.
    const lateHandoffParts: Buffer[] = [];

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

    function removeLateListener(): void {
      try {
        if (readableInput.off !== undefined) readableInput.off("readable", onLateReadable);
        else readableInput.removeListener?.("readable", onLateReadable);
      } catch {
        // A minimal injected stream may not expose readable-listener removal.
      }
    }

    function retireLateBroker(extra?: Uint8Array): void {
      if (!lateBrokerActive) return;
      lateBrokerActive = false;
      if (lateTimer !== undefined) clearTimeout(lateTimer);
      lateTimer = undefined;
      removeLateListener();
      const replay = Buffer.concat([
        ...lateHandoffParts,
        ...lateReplayParts,
        latePending,
        ...(extra === undefined || extra.length === 0 ? [] : [Buffer.from(extra)]),
      ]);
      latePending = Buffer.alloc(0);
      lateReplayParts.length = 0;
      lateReplayBytes = 0;
      lateHandoffParts.length = 0;
      if (replay.length > 0) {
        try {
          replayHandler?.(Buffer.from(replay));
        } catch {
          // The probe has no authority to make a caller's replay sink succeed.
        }
      }
      const dataListeners = (
        options.stdin as { readonly listenerCount?: (event: string) => number }
      ).listenerCount?.("data");
      try {
        if (wasFlowing === true || (dataListeners ?? 0) > 0) options.stdin.resume?.();
        else options.stdin.pause?.();
      } catch {
        // Keep the lifecycle result stable if a minimal stream rejects flow restoration.
      }
    }

    function appendLateReplay(bytes: Uint8Array): boolean {
      if (bytes.length === 0) return true;
      if (lateReplayBytes + bytes.length > maxReplayBytes) return false;
      lateReplayParts.push(Buffer.from(bytes));
      lateReplayBytes += bytes.length;
      return true;
    }

    function queueLateReplay(bytes: Uint8Array): void {
      if (bytes.length === 0) return;
      // This is called while promoting the probe buffer, before the late broker is active. If the
      // ordinary budget is already full, classify the excess as an ordered handoff; unlike the
      // candidate it is no longer parsed or retained as protocol state.
      if (!appendLateReplay(bytes)) {
        // Preserve the order of any ordinary bytes already queued before this chunk when moving
        // the queue out of the bounded replay bucket.
        lateHandoffParts.push(...lateReplayParts, Buffer.from(bytes));
        lateReplayParts.length = 0;
        lateReplayBytes = 0;
      }
    }

    function queueLatePending(bytes: Uint8Array): void {
      if (bytes.length === 0) return;
      // The unresolved candidate has its own response-sized bound. It must not be externalized
      // merely because ordinary replay has reached maxReplayBytes.
      latePending = Buffer.from(bytes);
    }

    function drainLatePending(): void {
      while (latePending.length > 0 && lateBrokerActive) {
        const candidate = nextCandidate(latePending);
        if (candidate === undefined) {
          const retained = protocolPrefixSuffixLength(latePending);
          const flushLength = latePending.length - retained;
          if (flushLength > 0) {
            const flushed = latePending.subarray(0, flushLength);
            latePending = latePending.subarray(flushLength);
            if (!appendLateReplay(flushed)) {
              // Leave the unconsumed bytes in place so retirement emits them in their original
              // order, including a possible lone ESC prefix.
              latePending = Buffer.concat([flushed, latePending]);
              retireLateBroker();
              return;
            }
          }
          if (latePending.length === 0) retireLateBroker();
          return;
        }
        if (candidate.start > 0) {
          const prefix = latePending.subarray(0, candidate.start);
          if (!appendLateReplay(prefix)) {
            retireLateBroker();
            return;
          }
          latePending = latePending.subarray(candidate.start);
        }
        if (candidate.kind === "kitty") {
          const end = latePending.indexOf(STRING_TERMINATOR, APC_START.length);
          if (end < 0) return;
          const frame = latePending.subarray(0, end + STRING_TERMINATOR.length);
          const parsed = parseKittyGraphicsResponse(frame);
          if (parsed === undefined || parsed.id !== 31) {
            if (!appendLateReplay(frame)) {
              retireLateBroker();
              return;
            }
          }
          latePending = latePending.subarray(frame.length);
          continue;
        }
        const final = findCsiFinal(latePending);
        if (final === undefined) return;
        const frame = latePending.subarray(0, final + 1);
        if (latePending[final] === 0x63) {
          if (parseDa1Parameters(frame) === undefined) {
            const first = latePending.subarray(0, 1);
            if (!appendLateReplay(first)) {
              retireLateBroker();
              return;
            }
            latePending = latePending.subarray(1);
          } else {
            latePending = latePending.subarray(frame.length);
          }
        } else if (latePending[final] === 0x74) {
          if (parseCellPixelReply(frame) === undefined) {
            const first = latePending.subarray(0, 1);
            if (!appendLateReplay(first)) {
              retireLateBroker();
              return;
            }
            latePending = latePending.subarray(1);
          } else {
            latePending = latePending.subarray(frame.length);
          }
        } else {
          const first = latePending.subarray(0, 1);
          if (!appendLateReplay(first)) {
            retireLateBroker();
            return;
          }
          latePending = latePending.subarray(1);
        }
      }
      if (latePending.length === 0) retireLateBroker();
    }

    function onLateReadable(): void {
      if (!lateBrokerActive || readableInput.read === undefined) return;
      let chunk = readableInput.read();
      while (chunk !== null && lateBrokerActive) {
        const bytes = toBuffer(chunk);
        if (bytes.length > 0) {
          if (latePending.length + bytes.length > maxResponseBytes) {
            // Retire before handing off: otherwise the callback's unshift can be read again by
            // this broker and duplicate the same user bytes. The incoming chunk is included in
            // the one ordered handoff, so the response-sized candidate bound never turns into
            // silent data loss.
            retireLateBroker(bytes);
          } else {
            latePending =
              latePending.length === 0 ? Buffer.from(bytes) : Buffer.concat([latePending, bytes]);
            drainLatePending();
          }
        }
        if (!lateBrokerActive) break;
        chunk = readableInput.read();
      }
    }

    function startLateBroker(): boolean {
      // This retirement window never extends the probe promise or pre-Ink startup delay. It only
      // quarantines bytes already buffered by a paused Readable; once ordinary bytes are observed,
      // they are handed back and the broker retires. Replies after this bounded handoff boundary
      // cannot be distinguished from user input without a terminal-owned input multiplexer.
      if (replayHandler === undefined || readableInput.read === undefined) return false;
      lateBrokerActive = true;
      try {
        readableInput.on("readable", onLateReadable);
      } catch {
        lateBrokerActive = false;
        return false;
      }
      lateTimer = setTimeout(retireLateBroker, LATE_BROKER_WINDOW_MS);
      lateTimer.unref?.();
      return true;
    }

    const finish = (
      timedOut: boolean,
      reason: string,
      forcedProtocol?: TerminalGraphicsProtocol,
    ) => {
      if (finished) return;
      finished = true;
      if (timer !== undefined) clearTimeout(timer);
      removeListener();
      let bufferedReplay = Buffer.concat(replayParts);
      let handoff = Buffer.concat(handoffParts);
      let keepLateBroker = false;
      if (
        timedOut &&
        latePending.length > 0 &&
        replayHandler !== undefined &&
        readableInput.read !== undefined
      ) {
        // Promote the unresolved candidate independently of ordinary replay. Prefix bytes stay in
        // the ordered late output until the broker retires, so a replay sink that unshifts them
        // cannot feed them back into the active candidate parser.
        if (handoff.length > 0) {
          lateHandoffParts.push(handoff);
          handoffParts.length = 0;
          handoff = Buffer.alloc(0);
        }
        if (bufferedReplay.length > 0) {
          if (lateReplayBytes + bufferedReplay.length <= maxReplayBytes) {
            lateReplayParts.unshift(bufferedReplay);
            lateReplayBytes += bufferedReplay.length;
            replayParts.length = 0;
            replaySize = 0;
            bufferedReplay = Buffer.alloc(0);
          } else {
            // The candidate remains late-brokered even when the ordinary replay prefix has
            // already reached its cap. The excess is an ordered handoff, never candidate state.
            lateHandoffParts.push(bufferedReplay);
            if (lateReplayParts.length > 0) {
              lateHandoffParts.push(...lateReplayParts);
              lateReplayParts.length = 0;
              lateReplayBytes = 0;
            }
            replayParts.length = 0;
            replaySize = 0;
            bufferedReplay = Buffer.alloc(0);
          }
        }
        keepLateBroker = startLateBroker();
      } else if (
        timedOut &&
        handoff.length === 0 &&
        bufferedReplay.length === 0 &&
        latePending.length === 0 &&
        lateReplayParts.length === 0
      ) {
        // With no initial bytes, retain the old bounded retirement behavior so replies or user
        // input arriving immediately after the timeout are still brokered before handoff.
        keepLateBroker = startLateBroker();
      }
      let lateSeed = Buffer.alloc(0);
      if (
        !keepLateBroker &&
        (lateHandoffParts.length > 0 || latePending.length > 0 || lateReplayParts.length > 0)
      ) {
        lateSeed = Buffer.concat([...lateHandoffParts, ...lateReplayParts, latePending]);
        lateHandoffParts.length = 0;
        latePending = Buffer.alloc(0);
        lateReplayParts.length = 0;
        lateReplayBytes = 0;
      }
      restoreInput();
      let replay = bufferedReplay;
      try {
        if (replayHandler !== undefined) {
          if (handoff.length > 0) replayHandler(Buffer.from(handoff));
          else if (!keepLateBroker && (bufferedReplay.length > 0 || lateSeed.length > 0)) {
            replayHandler(Buffer.concat([bufferedReplay, lateSeed]));
          }
        } else if (handoff.length > 0 || lateSeed.length > 0) {
          replay = Buffer.concat([handoff, bufferedReplay, lateSeed]);
        }
      } catch {
        // A failed handoff remains available in the result rather than being silently discarded.
        replay = Buffer.concat([handoff, bufferedReplay, lateSeed]);
      }
      const protocol =
        forcedProtocol ??
        (kittyResponse?.explicitOk === true &&
        kittyResponse.id === 31 &&
        da1Parameters !== undefined &&
        cellPixels !== undefined
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

    const preservePendingForLate = (): void => {
      if (pending.length === 0) return;
      const candidate = nextCandidate(pending);
      if (candidate === undefined) {
        const retained = protocolPrefixSuffixLength(pending);
        const flushLength = pending.length - retained;
        if (flushLength > 0) queueLateReplay(pending.subarray(0, flushLength));
        if (retained > 0) queueLatePending(pending.subarray(flushLength));
        else if (flushLength === 0) appendReplay(pending);
      } else {
        if (candidate.start > 0) queueLateReplay(pending.subarray(0, candidate.start));
        queueLatePending(pending.subarray(candidate.start));
      }
      pending = Buffer.alloc(0);
    };

    // The listener is installed while paused, then the previous flow state is restored at exit.
    try {
      timer = setTimeout(() => {
        preservePendingForLate();
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
  const environmentGate = terminalEnvironmentGateReason(options.env);
  if (environmentGate !== undefined) return { protocol: "unsupported", reason: environmentGate };
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

function isPrintableAsciiBytes(value: Uint8Array): boolean {
  for (const byte of value) {
    if (byte < 0x20 || byte > 0x7e) return false;
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
