/**
 * The worker protocol is a trust boundary. A renderer worker executes MathJax and resvg over
 * untrusted TeX, so every message it sends back is treated as untrusted input and must be proven
 * to match this exact contract before any field reaches a caller.
 *
 * Validation here is intentionally exhaustive and closed. An unknown discriminator, an unexpected
 * field, an unbounded string, an out-of-contract error code, or a response that does not match the
 * request actually in flight is a protocol failure, not a render failure.
 */

/** Request identifiers are a bounded, wrapping counter so an id is always an exact small integer. */
export const maximumRequestId = 2 ** 32;

/** Mirrors the core TeX input ceiling. UTF-16 length is a safe upper bound for a UTF-8 byte limit. */
export const maximumTexLength = 16 * 1024;

/** A worker error message is a fixed redacted sentence; anything longer did not come from us. */
export const maximumWorkerMessageLength = 512;

/** Mirrors the core SVG output ceiling. Duplicated here to keep this module dependency-free. */
export const maximumSvgLength = 1024 * 1024;

export const maximumPngBytes = 8 * 1024 * 1024;

export const maximumRasterWidth = 4096;

export const maximumRasterHeight = 2048;

export const maximumRasterArea = 8_388_608;

/** A raw RGBA plane is bounded by the same raster area, at four bytes per pixel. */
export const maximumRgbaBytes = maximumRasterArea * 4;

export const rendererIdentity = "mathjax-4.1.3";

/**
 * The only error codes a worker may report. `worker_failed`, `timeout`, `cancelled`, and the budget
 * codes are pool-authored and are never accepted from a worker.
 */
export const workerErrorCodes = Object.freeze([
  "invalid_input",
  "input_limit",
  "output_limit",
  "render_failed",
  "unsafe_svg",
] as const);

export type WorkerErrorCode = (typeof workerErrorCodes)[number];

export type WorkerRenderFormat = "svg" | "png";

export interface WorkerRenderRequest {
  readonly id: number;
  readonly type: "render";
  readonly tex: string;
  readonly display: boolean;
  readonly format: WorkerRenderFormat;
}

export interface WorkerReadyMessage {
  readonly type: "ready";
}

export interface WorkerRenderPayload {
  readonly display: boolean;
  readonly renderer: typeof rendererIdentity;
  readonly svg: string;
  readonly tex: string;
  readonly png?: Uint8Array;
  readonly pixels?: Uint8Array;
  readonly width?: number;
  readonly height?: number;
}

export interface WorkerSuccessMessage {
  readonly id: number;
  readonly type: "result";
  readonly result: WorkerRenderPayload;
}

export interface WorkerFailureMessage {
  readonly id: number;
  readonly type: "error";
  readonly code: WorkerErrorCode;
  readonly message: string;
}

export type WorkerMessage = WorkerReadyMessage | WorkerSuccessMessage | WorkerFailureMessage;

/** A response correlated to one in-flight request. */
export type WorkerResponseMessage = WorkerSuccessMessage | WorkerFailureMessage;

/** The full identity of the request a response must match. */
export interface ExpectedResponse {
  readonly id: number;
  readonly format: WorkerRenderFormat;
  readonly tex: string;
  readonly display: boolean;
}

const readyKeys: ReadonlySet<string> = new Set(["type"]);
const resultKeys: ReadonlySet<string> = new Set(["type", "id", "result"]);
const errorKeys: ReadonlySet<string> = new Set(["type", "id", "code", "message"]);
const svgPayloadKeys: ReadonlySet<string> = new Set(["display", "renderer", "svg", "tex"]);
const pngPayloadKeys: ReadonlySet<string> = new Set([
  "display",
  "renderer",
  "svg",
  "tex",
  "png",
  "pixels",
  "width",
  "height",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A closed key set. An unexpected field means the sender is not the packaged worker. */
function hasExactKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  const keys = Object.keys(value);
  if (keys.length !== allowed.size) return false;
  return keys.every((key) => allowed.has(key));
}

/**
 * Structured clone transfers a `Uint8Array` as a `Uint8Array`, but a hostile or broken worker may
 * post a look-alike. Require the real view and reject a shared-memory-backed view, which would let
 * a worker mutate bytes after validation.
 */
function isPlainUint8Array(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array && value.buffer instanceof ArrayBuffer;
}

function isBoundedRequestId(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= maximumRequestId
  );
}

function isBoundedString(value: unknown, maximumLength: number): value is string {
  return typeof value === "string" && value.length <= maximumLength;
}

function isPositiveIntegerWithin(value: unknown, maximum: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= maximum;
}

export function isWorkerErrorCode(value: unknown): value is WorkerErrorCode {
  return typeof value === "string" && (workerErrorCodes as readonly string[]).includes(value);
}

/** The only message accepted before a slot is marked ready. */
export function isWorkerReadyMessage(value: unknown): value is WorkerReadyMessage {
  return isRecord(value) && value.type === "ready" && hasExactKeys(value, readyKeys);
}

function isValidRenderPayload(value: unknown, expected: ExpectedResponse): boolean {
  if (!isRecord(value)) return false;

  const isPng = expected.format === "png";
  if (!hasExactKeys(value, isPng ? pngPayloadKeys : svgPayloadKeys)) return false;

  if (value.renderer !== rendererIdentity) return false;
  if (!isBoundedString(value.svg, maximumSvgLength)) return false;

  // `tex` and `display` are echoes of our own request, and `tex` is the canonical source the
  // caller keeps. A worker must not be able to substitute either, so they are compared exactly
  // rather than merely type-checked. This is also the operation-consistency check for the input.
  if (!isBoundedString(value.tex, maximumTexLength) || value.tex !== expected.tex) return false;
  if (value.display !== expected.display) return false;

  if (!isPng) return true;

  if (!isPlainUint8Array(value.png)) return false;
  if (value.png.byteLength < 1 || value.png.byteLength > maximumPngBytes) return false;
  if (!isPositiveIntegerWithin(value.width, maximumRasterWidth)) return false;
  if (!isPositiveIntegerWithin(value.height, maximumRasterHeight)) return false;
  if (value.width * value.height > maximumRasterArea) return false;
  if (!isPlainUint8Array(value.pixels)) return false;
  if (value.pixels.byteLength > maximumRgbaBytes) return false;
  return value.pixels.byteLength === value.width * value.height * 4;
}

/**
 * Validates a worker response against the request actually in flight.
 *
 * Returns `undefined` for anything that is not an exact, in-contract, correlated response. The
 * caller must treat `undefined` as `worker_failed` and replace the worker. No field of a rejected
 * message may be surfaced to a caller.
 */
export function parseWorkerResponse(
  value: unknown,
  expected: ExpectedResponse,
): WorkerResponseMessage | undefined {
  if (!isRecord(value)) return undefined;

  // Exact match against the single outstanding request. A stale, guessed, or unsolicited id is a
  // protocol failure even when the rest of the payload is well formed.
  if (!isBoundedRequestId(value.id) || value.id !== expected.id) return undefined;

  if (value.type === "result") {
    if (!hasExactKeys(value, resultKeys)) return undefined;
    if (!isValidRenderPayload(value.result, expected)) return undefined;
    return value as unknown as WorkerSuccessMessage;
  }

  if (value.type === "error") {
    if (!hasExactKeys(value, errorKeys)) return undefined;
    if (!isWorkerErrorCode(value.code)) return undefined;
    if (!isBoundedString(value.message, maximumWorkerMessageLength)) return undefined;
    return value as unknown as WorkerFailureMessage;
  }

  return undefined;
}

export function isWorkerRenderRequest(value: unknown): value is WorkerRenderRequest {
  if (!isRecord(value)) return false;
  return (
    value.type === "render" &&
    isBoundedRequestId(value.id) &&
    typeof value.tex === "string" &&
    typeof value.display === "boolean" &&
    (value.format === "svg" || value.format === "png")
  );
}
