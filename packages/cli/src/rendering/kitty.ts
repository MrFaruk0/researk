import { Buffer } from "node:buffer";
import type { Writable } from "node:stream";

const ESC = "\u001b";
const STRING_TERMINATOR = `${ESC}\\`;
const MAX_BASE64_CHUNK_BYTES = 4096;
const MAX_PNG_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_ID = 0xffff_ffff;
const MAX_PLACEMENT_ID = 0xffff_ffff;
const MAX_COLUMNS = 512;
const MAX_ROWS = 512;
const MAX_CELL_PIXELS = 4096;
const MAX_CELL_AREA = MAX_CELL_PIXELS * MAX_CELL_PIXELS;

/** Stable IDs keep redraw/delete behavior deterministic for one CLI process. */
export const KITTY_IMAGE_ID = 1;
export const KITTY_PLACEMENT_ID = 1;
export const KITTY_BASE64_CHUNK_BYTES = MAX_BASE64_CHUNK_BYTES;
export const KITTY_MAX_PNG_BYTES = MAX_PNG_BYTES;

export interface KittyPngOptions {
  readonly imageId?: number;
  readonly placementId?: number;
  /** 1-based terminal row for CUP. */
  readonly row?: number;
  /** 1-based terminal column for CUP. */
  readonly column?: number;
  /** Explicit Kitty placement width in cells (`c`). */
  readonly columns?: number;
  /** Explicit Kitty placement height in cells (`r`). */
  readonly rows?: number;
  /** Optional cell-pixel dimensions used only for bounded layout validation. */
  readonly cellWidth?: number;
  readonly cellHeight?: number;
}

export interface KittyPngSuccess {
  readonly ok: true;
  readonly success: true;
  readonly sequence: string;
  readonly chunks: readonly string[];
  readonly imageId: number;
  readonly placementId: number;
  readonly row: number;
  readonly column: number;
  readonly columns: number;
  readonly rows: number;
}

export interface KittyEmitFailure {
  readonly ok: false;
  readonly success: false;
  readonly reason:
    | "empty-png"
    | "png-too-large"
    | "invalid-image-id"
    | "invalid-placement-id"
    | "invalid-cursor-position"
    | "invalid-placement"
    | "invalid-cell-size"
    | "write-failed";
  readonly message: string;
}

export type KittyEmitResult = KittyPngSuccess | KittyEmitFailure;

/**
 * Build a complete Kitty PNG presentation in memory. No bytes are written until all ceilings and
 * controls have been validated, so callers can safely fall back to exact source on failure.
 */
export function buildKittyPng(png: Uint8Array, options: KittyPngOptions = {}): KittyEmitResult {
  const bytes = Buffer.from(png);
  if (bytes.length === 0) return failure("empty-png", "Kitty PNG payload is empty.");
  if (bytes.length > MAX_PNG_BYTES) {
    return failure("png-too-large", "Kitty PNG payload exceeds the bounded payload ceiling.");
  }

  const imageId = options.imageId ?? KITTY_IMAGE_ID;
  const placementId = options.placementId ?? KITTY_PLACEMENT_ID;
  const row = options.row ?? 1;
  const column = options.column ?? 1;
  const columns = options.columns ?? 1;
  const rows = options.rows ?? 1;
  if (!validId(imageId, MAX_IMAGE_ID))
    return failure("invalid-image-id", "Kitty image ID is invalid.");
  if (!validId(placementId, MAX_PLACEMENT_ID)) {
    return failure("invalid-placement-id", "Kitty placement ID is invalid.");
  }
  if (!validPositiveInteger(row) || !validPositiveInteger(column)) {
    return failure("invalid-cursor-position", "Kitty CUP coordinates must be positive integers.");
  }
  if (!validBoundedInteger(columns, MAX_COLUMNS) || !validBoundedInteger(rows, MAX_ROWS)) {
    return failure("invalid-placement", "Kitty placement dimensions exceed the cell ceiling.");
  }
  if (
    (options.cellWidth !== undefined || options.cellHeight !== undefined) &&
    (options.cellWidth === undefined ||
      options.cellHeight === undefined ||
      !validCellPixels(options.cellWidth, options.cellHeight))
  ) {
    return failure("invalid-cell-size", "Kitty cell-pixel dimensions are invalid or oversized.");
  }

  const encoded = bytes.toString("base64");
  const chunks = splitBase64(encoded, MAX_BASE64_CHUNK_BYTES);
  if (chunks.length === 0)
    return failure("empty-png", "Kitty PNG payload produced no base64 data.");
  const graphics = chunks.map((chunk, index) => {
    if (index === 0) {
      const more = chunks.length > 1 ? 1 : 0;
      return `${ESC}_Ga=T,f=100,t=d,i=${imageId},p=${placementId},c=${columns},r=${rows},C=1,m=${more};${chunk}${STRING_TERMINATOR}`;
    }
    const more = index < chunks.length - 1 ? 1 : 0;
    return `${ESC}_Gm=${more};${chunk}${STRING_TERMINATOR}`;
  });
  return {
    ok: true,
    success: true,
    sequence: `${ESC}[s${ESC}[${row};${column}H${graphics.join("")}${ESC}[u`,
    chunks,
    imageId,
    placementId,
    row,
    column,
    columns,
    rows,
  };
}

export const buildKittyPngSequence = buildKittyPng;
export const createKittyPngSequence = buildKittyPng;

/** Emit one already validated, complete sequence. */
export async function emitKittyPng(
  stdout: Writable,
  png: Uint8Array,
  options: KittyPngOptions = {},
): Promise<KittyEmitResult> {
  const built = buildKittyPng(png, options);
  if (!built.ok) return built;
  try {
    await writeComplete(stdout, built.sequence);
    return built;
  } catch {
    return failure("write-failed", "Kitty graphics sequence could not be written.");
  }
}

export const emitKittyImage = emitKittyPng;

/** Return a trusted numeric delete-by-image-ID sequence. */
export function kittyDeleteById(imageId: number = KITTY_IMAGE_ID): string | undefined {
  if (!validId(imageId, MAX_IMAGE_ID)) return undefined;
  return `${ESC}_Ga=d,d=I,i=${imageId}${STRING_TERMINATOR}`;
}

/** Delete all visible Kitty image placements. */
export function kittyDeleteAll(): string {
  return `${ESC}_Ga=d,d=A${STRING_TERMINATOR}`;
}

export const buildKittyDeleteById = kittyDeleteById;
export const buildKittyDeleteAll = kittyDeleteAll;

export async function emitKittyDeleteById(
  stdout: Writable,
  imageId: number = KITTY_IMAGE_ID,
): Promise<{ readonly ok: true; readonly success: true } | KittyEmitFailure> {
  const sequence = kittyDeleteById(imageId);
  if (sequence === undefined) return failure("invalid-image-id", "Kitty image ID is invalid.");
  return emitControl(stdout, sequence);
}

export async function emitKittyDeleteAll(
  stdout: Writable,
): Promise<{ readonly ok: true; readonly success: true } | KittyEmitFailure> {
  return emitControl(stdout, kittyDeleteAll());
}

function splitBase64(value: string, maximum: number): readonly string[] {
  const chunks: string[] = [];
  for (let offset = 0; offset < value.length; offset += maximum) {
    chunks.push(value.slice(offset, offset + maximum));
  }
  return chunks;
}

function validId(value: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= maximum;
}

function validPositiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function validBoundedInteger(value: number, maximum: number): boolean {
  return validPositiveInteger(value) && value <= maximum;
}

function validCellPixels(width: number, height: number): boolean {
  return (
    validPositiveInteger(width) &&
    validPositiveInteger(height) &&
    width <= MAX_CELL_PIXELS &&
    height <= MAX_CELL_PIXELS &&
    width * height <= MAX_CELL_AREA
  );
}

function failure(reason: KittyEmitFailure["reason"], message: string): KittyEmitFailure {
  return { ok: false, success: false, reason, message };
}

async function emitControl(
  stdout: Writable,
  sequence: string,
): Promise<{ readonly ok: true; readonly success: true } | KittyEmitFailure> {
  try {
    await writeComplete(stdout, sequence);
    return { ok: true, success: true };
  } catch {
    return failure("write-failed", "Kitty graphics control sequence could not be written.");
  }
}

async function writeComplete(stdout: Writable, sequence: string): Promise<void> {
  if (stdout.write(sequence)) return;
  await new Promise<void>((resolve, reject) => {
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      stdout.off("drain", onDrain);
      stdout.off("error", onError);
    };
    stdout.once("drain", onDrain);
    stdout.once("error", onError);
  });
}
