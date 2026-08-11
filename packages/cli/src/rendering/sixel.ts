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
const MAX_SIXEL_COLORS = 16;
const HISTOGRAM_BITS = 5;
const HISTOGRAM_SIDE = 1 << HISTOGRAM_BITS;
const HISTOGRAM_SIZE = HISTOGRAM_SIDE * HISTOGRAM_SIDE * HISTOGRAM_SIDE;
// This sentinel is never a valid palette index (the palette is bounded to 16 colors). Keeping it
// in the band buffer lets P2=1 leave fully transparent source pixels untouched instead of drawing
// a background plane over the entire raster.
const TRANSPARENT_PIXEL = 0xff;
interface RgbColor {
  readonly red: number;
  readonly green: number;
  readonly blue: number;
}

export interface SixelImage {
  /** Resolved terminal background used to composite source alpha before quantization. */
  readonly background?: string;
  readonly pixels: Uint8Array;
  readonly width: number;
  readonly height: number;
}

export type SixelFailureReason =
  | "invalid-pixels"
  | "invalid-dimensions"
  | "pixels-length"
  | "area-limit"
  | "no-visible-pixels"
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
 * sixels untouched. Fully transparent source pixels therefore remain unset; non-transparent pixels
 * are assigned to exactly one bounded palette plane rather than relying on terminal background
 * clearing. When no terminal background is known, source RGB values are retained without an
 * invented white/dark canvas.
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

  const background = resolveBackground(input.background);
  const palette = buildPalette(input.pixels, input.width, input.height, background);
  if (palette.length === 0) return { ok: false, reason: "no-visible-pixels" };

  // P1=0 selects the standard sixel mode; P2=1 keeps unset sixels transparent. Raster attributes
  // provide fixed 1:1 pixels and the bounded image dimensions. All values are local integers.
  if (!append(`\u001bP0;1q"1;1;${input.width};${input.height}`)) {
    return { ok: false, reason: "output-limit" };
  }
  for (let index = 0; index < palette.length; index += 1) {
    const color = palette[index];
    if (color === undefined || !append(paletteDefinition(index, color))) {
      return { ok: false, reason: "output-limit" };
    }
  }

  const bandPixels = new Uint8Array(SIXEL_BAND_HEIGHT * input.width);
  const bandCount = Math.ceil(input.height / SIXEL_BAND_HEIGHT);
  for (let band = 0; band < bandCount; band += 1) {
    const firstRow = band * SIXEL_BAND_HEIGHT;
    const rows = Math.min(SIXEL_BAND_HEIGHT, input.height - firstRow);
    fillBandPixels(bandPixels, input.pixels, input.width, firstRow, rows, palette, background);

    for (let index = 0; index < palette.length; index += 1) {
      if (!append(`#${index}`)) return { ok: false, reason: "output-limit" };
      if (!appendPlane(append, bandPixels, input.width, rows, index)) {
        return { ok: false, reason: "output-limit" };
      }
      if (index + 1 < palette.length && !append("$")) {
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
    readonly background?: unknown;
    readonly pixels?: unknown;
    readonly width?: unknown;
    readonly height?: unknown;
  };
  if (!(candidate.pixels instanceof Uint8Array)) return undefined;
  return {
    ...(typeof candidate.background === "string" ? { background: candidate.background } : {}),
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
  palette: readonly RgbColor[],
  background: RgbColor | undefined,
): void {
  for (let row = 0; row < rows; row += 1) {
    const sourceRow = firstRow + row;
    const sourceOffset = sourceRow * width * RGBA_CHANNELS;
    const bandOffset = row * width;
    for (let column = 0; column < width; column += 1) {
      const pixelOffset = sourceOffset + column * RGBA_CHANNELS;
      const color = compositePixel(
        pixels[pixelOffset] ?? 0,
        pixels[pixelOffset + 1] ?? 0,
        pixels[pixelOffset + 2] ?? 0,
        pixels[pixelOffset + 3] ?? 0,
        background,
      );
      bandPixels[bandOffset + column] =
        color === undefined ? TRANSPARENT_PIXEL : nearestPaletteIndex(color, palette);
    }
  }
  // The final band can be shorter than six rows. Clear the unused rows so they cannot contribute
  // stale bits if this reusable band buffer is read by a caller-modified implementation later.
  for (let row = rows; row < SIXEL_BAND_HEIGHT; row += 1) {
    bandPixels.fill(TRANSPARENT_PIXEL, row * width, (row + 1) * width);
  }
}

function buildPalette(
  pixels: Uint8Array,
  width: number,
  height: number,
  background: RgbColor | undefined,
): readonly RgbColor[] {
  // A 5-bit/channel histogram is a fixed ~128 KiB structure even for the largest accepted raster.
  // It gives small formulas a faithful foreground color without retaining unbounded source data.
  const histogram = new Uint32Array(HISTOGRAM_SIZE);
  for (let row = 0; row < height; row += 1) {
    const sourceOffset = row * width * RGBA_CHANNELS;
    for (let column = 0; column < width; column += 1) {
      const pixelOffset = sourceOffset + column * RGBA_CHANNELS;
      const color = compositePixel(
        pixels[pixelOffset] ?? 0,
        pixels[pixelOffset + 1] ?? 0,
        pixels[pixelOffset + 2] ?? 0,
        pixels[pixelOffset + 3] ?? 0,
        background,
      );
      if (color === undefined) continue;
      const bin = colorBin(color);
      histogram[bin] = (histogram[bin] ?? 0) + 1;
    }
  }

  const candidates: Array<{ readonly bin: number; readonly count: number }> = [];
  for (let bin = 0; bin < histogram.length; bin += 1) {
    const count = histogram[bin] ?? 0;
    if (count > 0) candidates.push({ bin, count });
  }
  candidates.sort((left, right) => right.count - left.count || left.bin - right.bin);

  const palette: RgbColor[] = background === undefined ? [] : [background];
  for (const candidate of candidates) {
    if (palette.length >= MAX_SIXEL_COLORS) break;
    const color = colorFromBin(candidate.bin);
    if (palette.some((selected) => colorDistanceSquared(selected, color) < 18 * 18)) continue;
    palette.push(color);
  }
  // If every source pixel is the resolved background, a one-color plane is enough and keeps the
  // protocol compact. Otherwise include the strongest source color even when it is close to the
  // background; anti-aliased light glyphs should not disappear into a light surface.
  if (background !== undefined && palette.length === 1 && candidates.length > 0) {
    const strongest = colorFromBin(candidates[0]?.bin ?? 0);
    if (colorDistanceSquared(strongest, background) > 0) palette.push(strongest);
  }
  return palette;
}

function compositePixel(
  red: number,
  green: number,
  blue: number,
  alpha: number,
  background: RgbColor | undefined,
): RgbColor | undefined {
  const boundedAlpha = Math.max(0, Math.min(255, alpha));
  if (boundedAlpha === 0) return undefined;
  // A system terminal does not expose its background reliably. Preserve source RGB for every
  // visible pixel rather than compositing against a guessed dark/white surface. This is bounded
  // and hue-preserving; P2=1 still keeps zero-alpha padding transparent.
  if (background === undefined) return { blue, green, red };
  const inverseAlpha = 255 - boundedAlpha;
  return {
    blue: Math.round((blue * boundedAlpha + background.blue * inverseAlpha) / 255),
    green: Math.round((green * boundedAlpha + background.green * inverseAlpha) / 255),
    red: Math.round((red * boundedAlpha + background.red * inverseAlpha) / 255),
  };
}

function nearestPaletteIndex(color: RgbColor, palette: readonly RgbColor[]): number {
  let bestIndex = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < palette.length; index += 1) {
    const candidate = palette[index];
    if (candidate === undefined) continue;
    const distance = colorDistanceSquared(color, candidate);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  }
  return bestIndex;
}

function colorDistanceSquared(left: RgbColor, right: RgbColor): number {
  const red = left.red - right.red;
  const green = left.green - right.green;
  const blue = left.blue - right.blue;
  return red * red + green * green + blue * blue;
}

function colorBin(color: RgbColor): number {
  return ((color.red >> 3) << 10) | ((color.green >> 3) << 5) | (color.blue >> 3);
}

function colorFromBin(bin: number): RgbColor {
  return {
    blue: ((bin & 0x1f) << 3) | 4,
    green: (((bin >> 5) & 0x1f) << 3) | 4,
    red: (((bin >> 10) & 0x1f) << 3) | 4,
  };
}

function paletteDefinition(index: number, color: RgbColor): string {
  return `#${index};2;${Math.round((color.red * 100) / 255)};${Math.round(
    (color.green * 100) / 255,
  )};${Math.round((color.blue * 100) / 255)}`;
}

function resolveBackground(value: string | undefined): RgbColor | undefined {
  if (value === undefined) return undefined;
  return parseBackgroundColor(value);
}

function parseBackgroundColor(value: string): RgbColor | undefined {
  const hexadecimal = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/iu.exec(value);
  if (hexadecimal?.[1] !== undefined) {
    const digits = hexadecimal[1];
    const expanded =
      digits.length === 3 || digits.length === 4
        ? [...digits].map((digit) => digit + digit).join("")
        : digits;
    const red = Number.parseInt(expanded.slice(0, 2), 16);
    const green = Number.parseInt(expanded.slice(2, 4), 16);
    const blue = Number.parseInt(expanded.slice(4, 6), 16);
    const alpha = expanded.length === 8 ? Number.parseInt(expanded.slice(6, 8), 16) : 255;
    if (alpha !== 255) return undefined;
    return { blue, green, red };
  }

  const rgb = /^rgba?\(([^)]+)\)$/iu.exec(value);
  if (rgb?.[1] !== undefined) {
    const channels = rgb[1].split(",").map((channel) => channel.trim());
    if (channels.length !== 3 && channels.length !== 4) return undefined;
    const parsed = channels.slice(0, 3).map(parseColorChannel);
    if (parsed.some((channel) => channel === undefined)) return undefined;
    const alpha = channels[3] === undefined ? 255 : parseAlpha(channels[3]);
    if (alpha === undefined) return undefined;
    if (alpha !== 255) return undefined;
    return { blue: parsed[2] ?? 0, green: parsed[1] ?? 0, red: parsed[0] ?? 0 };
  }

  const named = value.toLowerCase();
  return Object.hasOwn(NAMED_BACKGROUND_COLORS, named) ? NAMED_BACKGROUND_COLORS[named] : undefined;
}

function parseColorChannel(value: string): number | undefined {
  if (value.endsWith("%")) {
    const percent = Number.parseFloat(value.slice(0, -1));
    return Number.isFinite(percent) && percent >= 0 && percent <= 100
      ? Math.round((percent * 255) / 100)
      : undefined;
  }
  const channel = Number(value);
  return Number.isInteger(channel) && channel >= 0 && channel <= 255 ? channel : undefined;
}

function parseAlpha(value: string): number | undefined {
  if (value.endsWith("%")) {
    const percent = Number.parseFloat(value.slice(0, -1));
    return Number.isFinite(percent) && percent >= 0 && percent <= 100
      ? Math.round((percent * 255) / 100)
      : undefined;
  }
  const alpha = Number(value);
  return Number.isFinite(alpha) && alpha >= 0 && alpha <= 1 ? Math.round(alpha * 255) : undefined;
}

const NAMED_BACKGROUND_COLORS: Readonly<Record<string, RgbColor>> = Object.freeze({
  black: { red: 0, green: 0, blue: 0 },
  blue: { red: 0, green: 0, blue: 255 },
  cyan: { red: 0, green: 255, blue: 255 },
  gray: { red: 128, green: 128, blue: 128 },
  green: { red: 0, green: 128, blue: 0 },
  magenta: { red: 255, green: 0, blue: 255 },
  red: { red: 255, green: 0, blue: 0 },
  white: { red: 255, green: 255, blue: 255 },
  yellow: { red: 255, green: 255, blue: 0 },
});

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
