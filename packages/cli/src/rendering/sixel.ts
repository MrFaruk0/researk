/**
 * The largest raster accepted by the packaged LaTeX renderer. Keep these limits local to the
 * emitter as well: callers may supply a renderer-shaped value without having passed through the
 * worker protocol validator.
 */
export const MAX_SIXEL_WIDTH = 4096;
export const MAX_SIXEL_HEIGHT = 2048;
export const MAX_SIXEL_AREA = 8_388_608;
export const MAX_SIXEL_ENCODED_BYTES = 1024 * 1024;

const RGBA_CHANNELS = 4;
const SIXEL_DATA_OFFSET = 0x3f;
const SIXEL_BAND_HEIGHT = 6;
const GRAYSCALE_LEVELS = Object.freeze([0, 14, 29, 43, 57, 71, 86, 100] as const);

export interface SixelImage {
  readonly pixels: Uint8Array;
  readonly width: number;
  readonly height: number;
}

export type SixelFailureReason =
  | "invalid-pixels"
  | "invalid-dimensions"
  | "pixels-length"
  | "area-limit"
  | "output-limit";

export interface SixelEncodeSuccess {
  readonly ok: true;
  readonly sequence: string;
  readonly encodedBytes: number;
  readonly width: number;
  readonly height: number;
}

export interface SixelEncodeFailure {
  readonly ok: false;
  readonly reason: SixelFailureReason;
}

export type SixelEncodeResult = SixelEncodeSuccess | SixelEncodeFailure;

export interface ImageCellSize {
  readonly width: number;
  readonly height: number;
}

/**
 * Encodes an already-rasterized RGBA image as a complete, bounded Sixel DCS.
 *
 * This function is deliberately a pure formatter. It does not inspect the environment, write to
 * a stream, decode a PNG, or interpolate caller-controlled text. DCS P2=1 leaves zero-valued
 * sixels untouched, so each source pixel is assigned to exactly one palette plane (white included)
 * rather than relying on terminal background clearing.
 */
export function encodeSixel(input: SixelImage): SixelEncodeResult;
export function encodeSixel(pixels: Uint8Array, width: number, height: number): SixelEncodeResult;
export function encodeSixel(
  inputOrPixels: SixelImage | Uint8Array,
  width?: number,
  height?: number,
): SixelEncodeResult {
  const input = normalizeInput(inputOrPixels, width, height);
  if (input === undefined) return { ok: false, reason: "invalid-pixels" };

  const dimensionReason = validateDimensions(input.width, input.height);
  if (dimensionReason !== undefined) return { ok: false, reason: dimensionReason };

  const expectedLength = input.width * input.height * RGBA_CHANNELS;
  if (input.pixels.byteLength !== expectedLength) {
    return { ok: false, reason: "pixels-length" };
  }

  const chunks: string[] = [];
  let encodedBytes = 0;
  const append = (value: string): boolean => {
    const nextLength = encodedBytes + value.length;
    if (nextLength > MAX_SIXEL_ENCODED_BYTES) return false;
    chunks.push(value);
    encodedBytes = nextLength;
    return true;
  };

  // P1=0 selects the standard sixel mode; P2=1 keeps unset sixels transparent. Raster attributes
  // provide fixed 1:1 pixels and the bounded image dimensions. All values are local integers.
  if (!append(`\u001bP0;1q"1;1;${input.width};${input.height}`)) {
    return { ok: false, reason: "output-limit" };
  }
  for (let palette = 0; palette < GRAYSCALE_LEVELS.length; palette += 1) {
    const level = GRAYSCALE_LEVELS[palette];
    if (!append(`#${palette};2;${level};${level};${level}`)) {
      return { ok: false, reason: "output-limit" };
    }
  }

  const bandPixels = new Uint8Array(SIXEL_BAND_HEIGHT * input.width);
  const bandCount = Math.ceil(input.height / SIXEL_BAND_HEIGHT);
  for (let band = 0; band < bandCount; band += 1) {
    const firstRow = band * SIXEL_BAND_HEIGHT;
    const rows = Math.min(SIXEL_BAND_HEIGHT, input.height - firstRow);
    fillBandPixels(bandPixels, input.pixels, input.width, firstRow, rows);

    for (let palette = 0; palette < GRAYSCALE_LEVELS.length; palette += 1) {
      if (!append(`#${palette}`)) return { ok: false, reason: "output-limit" };
      if (!appendPlane(append, bandPixels, input.width, rows, palette)) {
        return { ok: false, reason: "output-limit" };
      }
      if (palette + 1 < GRAYSCALE_LEVELS.length && !append("$")) {
        return { ok: false, reason: "output-limit" };
      }
    }
    if (band + 1 < bandCount && !append("-")) {
      return { ok: false, reason: "output-limit" };
    }
  }

  if (!append("\u001b\\")) return { ok: false, reason: "output-limit" };
  return {
    ok: true,
    sequence: chunks.join(""),
    encodedBytes,
    width: input.width,
    height: input.height,
  };
}

/**
 * Returns terminal-cell dimensions for a bounded raster and bounded positive cell metrics.
 * Invalid input is represented by `undefined` so placement code can fall back without throwing.
 */
export function imageCellSize(
  width: number,
  height: number,
  cellPixelWidth: number,
  cellPixelHeight: number,
): ImageCellSize | undefined {
  if (
    !isPositiveBoundedInteger(width, MAX_SIXEL_WIDTH) ||
    !isPositiveBoundedInteger(height, MAX_SIXEL_HEIGHT) ||
    width * height > MAX_SIXEL_AREA ||
    !isPositiveBoundedInteger(cellPixelWidth, MAX_SIXEL_WIDTH) ||
    !isPositiveBoundedInteger(cellPixelHeight, MAX_SIXEL_WIDTH)
  ) {
    return undefined;
  }
  return {
    width: Math.ceil(width / cellPixelWidth),
    height: Math.ceil(height / cellPixelHeight),
  };
}

function normalizeInput(
  inputOrPixels: SixelImage | Uint8Array,
  width: number | undefined,
  height: number | undefined,
): SixelImage | undefined {
  if (inputOrPixels instanceof Uint8Array) {
    if (width === undefined || height === undefined) return undefined;
    return { pixels: inputOrPixels, width, height };
  }
  if (inputOrPixels === null || typeof inputOrPixels !== "object") return undefined;
  const candidate = inputOrPixels as {
    readonly pixels?: unknown;
    readonly width?: unknown;
    readonly height?: unknown;
  };
  if (!(candidate.pixels instanceof Uint8Array)) return undefined;
  return {
    pixels: candidate.pixels,
    width: candidate.width as number,
    height: candidate.height as number,
  };
}

function validateDimensions(width: number, height: number): SixelFailureReason | undefined {
  if (
    !isPositiveBoundedInteger(width, MAX_SIXEL_WIDTH) ||
    !isPositiveBoundedInteger(height, MAX_SIXEL_HEIGHT)
  ) {
    return "invalid-dimensions";
  }
  if (width * height > MAX_SIXEL_AREA) return "area-limit";
  return undefined;
}

function isPositiveBoundedInteger(value: number, maximum: number): boolean {
  return Number.isFinite(value) && Number.isInteger(value) && value > 0 && value <= maximum;
}

function fillBandPixels(
  bandPixels: Uint8Array,
  pixels: Uint8Array,
  width: number,
  firstRow: number,
  rows: number,
): void {
  for (let row = 0; row < rows; row += 1) {
    const sourceRow = firstRow + row;
    const sourceOffset = sourceRow * width * RGBA_CHANNELS;
    const bandOffset = row * width;
    for (let column = 0; column < width; column += 1) {
      const pixelOffset = sourceOffset + column * RGBA_CHANNELS;
      bandPixels[bandOffset + column] = grayscalePaletteIndex(
        pixels[pixelOffset] ?? 0,
        pixels[pixelOffset + 1] ?? 0,
        pixels[pixelOffset + 2] ?? 0,
        pixels[pixelOffset + 3] ?? 0,
      );
    }
  }
  // The final band can be shorter than six rows. Clear the unused rows so they cannot contribute
  // stale bits if this reusable band buffer is read by a caller-modified implementation later.
  for (let row = rows; row < SIXEL_BAND_HEIGHT; row += 1) {
    bandPixels.fill(0, row * width, (row + 1) * width);
  }
}

function grayscalePaletteIndex(red: number, green: number, blue: number, alpha: number): number {
  // ITU-R BT.601 luma is deterministic and keeps colored input useful while the output palette is
  // strictly grayscale. Composite over white before quantizing to the nearest of eight levels.
  const luma = Math.round((299 * red + 587 * green + 114 * blue) / 1000);
  const composited = Math.round((luma * alpha + 255 * (255 - alpha)) / 255);
  return Math.max(0, Math.min(GRAYSCALE_LEVELS.length - 1, Math.round((composited * 7) / 255)));
}

function appendPlane(
  append: (value: string) => boolean,
  bandPixels: Uint8Array,
  width: number,
  rows: number,
  palette: number,
): boolean {
  let runCharacter = "";
  let runLength = 0;
  for (let column = 0; column < width; column += 1) {
    let bits = 0;
    for (let row = 0; row < rows; row += 1) {
      if (bandPixels[row * width + column] === palette) bits |= 1 << row;
    }
    const character = String.fromCharCode(SIXEL_DATA_OFFSET + bits);
    if (character === runCharacter) {
      runLength += 1;
    } else {
      if (runLength > 0 && !appendRun(append, runCharacter, runLength)) return false;
      runCharacter = character;
      runLength = 1;
    }
  }
  return runLength === 0 || appendRun(append, runCharacter, runLength);
}

function appendRun(append: (value: string) => boolean, character: string, count: number): boolean {
  const countDigits = String(count).length;
  // `!<count><char>` has two bytes beyond the decimal count. Equal-length RLE is not beneficial
  // and is left raw so the encoder emits the shortest deterministic representation.
  if (countDigits + 2 < count) return append(`!${count}${character}`);
  return append(character.repeat(count));
}
