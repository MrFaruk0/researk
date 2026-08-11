import { describe, expect, it } from "vitest";
import {
  encodeSixel,
  imageCellSize,
  MAX_SIXEL_ENCODED_BYTES,
  MAX_SIXEL_HEIGHT,
  MAX_SIXEL_WIDTH,
  type SixelEncodeResult,
} from "../src/rendering/sixel.js";

const ESC = "\u001b";
const ST = `${ESC}\\`;
interface DecodedSixel {
  readonly width: number;
  readonly height: number;
  readonly pixels: number[][];
  readonly palette: readonly number[];
  readonly colors: readonly {
    readonly blue: number;
    readonly green: number;
    readonly red: number;
  }[];
}

function pixelsFor(values: readonly number[], width = values.length): Uint8Array {
  const pixels = new Uint8Array(values.length * 4);
  for (let index = 0; index < values.length; index += 1) {
    const offset = index * 4;
    pixels[offset] = values[index] ?? 0;
    pixels[offset + 1] = values[index] ?? 0;
    pixels[offset + 2] = values[index] ?? 0;
    pixels[offset + 3] = 255;
  }
  expect(values.length % width).toBe(0);
  return pixels;
}

function success(result: SixelEncodeResult): Extract<SixelEncodeResult, { ok: true }> {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("expected a successful Sixel encoding");
  return result;
}

function decodeSixel(sequence: string): DecodedSixel {
  expect(sequence.startsWith(`${ESC}P0;1q"1;1;`)).toBe(true);
  expect(sequence.endsWith(ST)).toBe(true);

  const payload = sequence.slice(2, -ST.length);
  const q = payload.indexOf("q");
  expect(q).toBeGreaterThan(0);
  const firstHash = payload.indexOf("#", q + 1);
  expect(firstHash).toBeGreaterThan(q);
  const raster = payload.slice(q + 1, firstHash);
  const rasterMatch = /^"1;1;(\d+);(\d+)$/u.exec(raster);
  expect(rasterMatch).not.toBeNull();
  if (rasterMatch === null) throw new Error("missing raster attributes");
  const width = Number(rasterMatch[1]);
  const height = Number(rasterMatch[2]);
  const pixels = Array.from({ length: height }, () => Array<number>(width).fill(-1));
  const palette = Array<number>(16).fill(-1);
  const colors: Array<{ blue: number; green: number; red: number }> = [];
  let currentColor = 0;
  let x = 0;
  let y = 0;
  let cursor = firstHash;

  const draw = (character: string, count: number) => {
    const bits = character.charCodeAt(0) - 0x3f;
    for (let repeat = 0; repeat < count; repeat += 1) {
      for (let bit = 0; bit < 6; bit += 1) {
        if ((bits & (1 << bit)) !== 0 && y + bit < height && x < width) {
          const row = pixels[y + bit];
          if (row !== undefined) row[x] = currentColor;
        }
      }
      x += 1;
    }
  };

  while (cursor < payload.length) {
    const character = payload[cursor];
    if (character === undefined) break;
    if (character === "#") {
      let end = cursor + 1;
      while (end < payload.length && /\d/u.test(payload[end] ?? "")) end += 1;
      currentColor = Number(payload.slice(cursor + 1, end));
      if (payload[end] === ";") {
        const definition = /^;2;(\d+);(\d+);(\d+)/u.exec(payload.slice(end));
        expect(definition).not.toBeNull();
        if (definition === null) throw new Error("malformed palette definition");
        palette[currentColor] = Number(definition[1]);
        colors[currentColor] = {
          blue: Number(definition[3]),
          green: Number(definition[2]),
          red: Number(definition[1]),
        };
        cursor = end + definition[0].length;
      } else {
        cursor = end;
      }
      continue;
    }
    if (character === "!") {
      let end = cursor + 1;
      while (end < payload.length && /\d/u.test(payload[end] ?? "")) end += 1;
      const count = Number(payload.slice(cursor + 1, end));
      const dataCharacter = payload[end];
      expect(dataCharacter).toBeDefined();
      if (dataCharacter === undefined) throw new Error("missing RLE data character");
      draw(dataCharacter, count);
      cursor = end + 1;
      continue;
    }
    if (character === "$") {
      x = 0;
      cursor += 1;
      continue;
    }
    if (character === "-") {
      x = 0;
      y += 6;
      cursor += 1;
      continue;
    }
    expect(character.charCodeAt(0)).toBeGreaterThanOrEqual(0x3f);
    expect(character.charCodeAt(0)).toBeLessThanOrEqual(0x7e);
    draw(character, 1);
    cursor += 1;
  }
  return { colors, height, palette, pixels, width };
}

describe("bounded pure Sixel encoding", () => {
  it("emits a deterministic complete golden 1x1 black image", () => {
    const input = { background: "#ffffff", pixels: pixelsFor([0]), width: 1, height: 1 } as const;
    const result = success(encodeSixel(input));
    expect(result.sequence).toBe(`${ESC}P0;1q"1;1;1;1#0;2;100;100;100#1;2;2;2;2#0?$#1@${ST}`);
    expect(result.encodedBytes).toBe(result.sequence.length);
    expect(encodeSixel(input)).toEqual(result);
  });

  it("round-trips black, white, grayscale, and transparent pixels through palette planes", () => {
    const source = new Uint8Array([0, 0, 0, 255, 255, 255, 255, 255, 73, 73, 73, 255, 0, 0, 0, 0]);
    const decoded = decodeSixel(
      success(encodeSixel({ pixels: source, width: 4, height: 1 })).sequence,
    );
    expect(decoded.pixels).toEqual([[0, 2, 1, -1]]);
    expect(decoded.palette.slice(0, 3)).toEqual([2, 30, 99]);
  });

  it("maps all six vertical bit positions and preserves a band boundary", () => {
    const sixLevels = [0, 36, 73, 109, 146, 182, 219];
    const source = pixelsFor(sixLevels, 1);
    const decoded = decodeSixel(
      success(encodeSixel({ pixels: source, width: 1, height: 7 })).sequence,
    );
    expect(decoded.pixels).toEqual(sixLevels.map((_value, index) => [index]));
  });

  it("uses RLE only when it reduces the encoded plane", () => {
    const four = success(
      encodeSixel({ background: "#ffffff", pixels: pixelsFor([0, 0, 0, 0]), width: 4, height: 1 }),
    ).sequence;
    expect(four).toContain("#1!4@");
    expect(four).toContain("#0!4?");

    const three = success(
      encodeSixel({ background: "#ffffff", pixels: pixelsFor([0, 0, 0]), width: 3, height: 1 }),
    ).sequence;
    expect(three).toContain("#1@@@");
    expect(three).not.toContain("!3");
  });

  it("composites alpha against white before palette quantization", () => {
    const source = new Uint8Array([0, 0, 0, 0, 0, 0, 0, 128, 0, 0, 0, 255]);
    const decoded = decodeSixel(
      success(encodeSixel({ background: "#ffffff", pixels: source, width: 3, height: 1 })).sequence,
    );
    expect(decoded.pixels).toEqual([[-1, 2, 1]]);
  });

  it("quantizes semantic hues and composites alpha against the resolved dark/light background", () => {
    const source = new Uint8Array([255, 0, 0, 255, 0, 0, 0, 128, 0, 0, 0, 0]);
    const dark = decodeSixel(
      success(encodeSixel({ background: "#101820", height: 1, pixels: source, width: 3 })).sequence,
    );
    const light = decodeSixel(
      success(encodeSixel({ background: "#f5f7fa", height: 1, pixels: source, width: 3 })).sequence,
    );

    // Palette 0 is the resolved background, while the opaque math pixel retains a red semantic
    // hue instead of collapsing into a grayscale luma.
    expect(dark.palette.slice(0, 1)).toEqual([6]);
    const darkRed = dark.colors.findIndex(
      (color, index) => index > 0 && color !== undefined && color.red > 60 && color.green < 40,
    );
    expect(darkRed).toBeGreaterThan(0);
    expect(dark.pixels[0]?.[0]).toBe(darkRed);
    expect(light.palette[0]).toBeGreaterThan(dark.palette[0] ?? -1);
    expect(light.pixels[0]?.[1]).not.toBe(light.pixels[0]?.[2]);
    expect(dark.pixels[0]?.[2]).toBe(-1);
    expect(light.pixels[0]?.[2]).toBe(-1);
  });

  it("leaves transparent padding unset and does not draw a full background plane", () => {
    const source = new Uint8Array([0, 0, 0, 0, 255, 0, 255, 255, 0, 0, 0, 0, 0, 0, 0, 0]);
    const decoded = decodeSixel(
      success(encodeSixel({ background: "#242832", height: 1, pixels: source, width: 4 })).sequence,
    );
    expect(decoded.pixels[0]).toEqual([-1, expect.any(Number), -1, -1]);
    // The semantic background may be defined in the palette for antialias compositing, but its
    // plane must not paint transparent padding.
    const backgroundIndex = decoded.palette.indexOf(14);
    if (backgroundIndex >= 0)
      expect(decoded.pixels[0]?.every((value) => value !== backgroundIndex)).toBe(true);
  });

  it("omits an unknown system background without a white or dark halo", () => {
    const source = new Uint8Array([255, 0, 255, 255, 0, 0, 0, 128, 0, 0, 0, 0]);
    const decoded = decodeSixel(
      success(encodeSixel({ height: 1, pixels: source, width: 3 })).sequence,
    );
    expect(decoded.pixels[0]?.[2]).toBe(-1);
    expect(decoded.colors[0]).not.toEqual({ red: 100, green: 100, blue: 100 });
    expect(
      decoded.colors.some(
        (color) => color?.red === 100 && color.green === 100 && color.blue === 100,
      ),
    ).toBe(false);
    expect(
      decoded.colors.some((color) => color?.red < 10 && color.green < 10 && color.blue < 10),
    ).toBe(true);
  });

  it("fails closed when the entire raster is transparent", () => {
    expect(encodeSixel({ pixels: new Uint8Array([0, 0, 0, 0]), width: 1, height: 1 })).toEqual({
      ok: false,
      reason: "no-visible-pixels",
    });
  });

  it("rejects malformed input and all renderer/output ceilings before success", () => {
    expect(encodeSixel({ pixels: new Uint8Array(0), width: 1, height: 1 })).toMatchObject({
      ok: false,
      reason: "pixels-length",
    });
    expect(encodeSixel({ pixels: new Uint8Array(4), width: 1.5, height: 1 })).toMatchObject({
      ok: false,
      reason: "invalid-dimensions",
    });
    expect(encodeSixel({ pixels: new Uint8Array(4), width: 0, height: 1 })).toMatchObject({
      ok: false,
      reason: "invalid-dimensions",
    });
    expect(
      encodeSixel({ pixels: new Uint8Array(4), width: MAX_SIXEL_WIDTH + 1, height: 1 }),
    ).toMatchObject({
      ok: false,
      reason: "invalid-dimensions",
    });
    expect(
      encodeSixel({ pixels: new Uint8Array(4), width: 1, height: MAX_SIXEL_HEIGHT + 1 }),
    ).toMatchObject({
      ok: false,
      reason: "invalid-dimensions",
    });
    const ignoredText = success(
      encodeSixel({
        pixels: new Uint8Array([0, 0, 0, 255]),
        width: 1,
        height: 1,
        tex: "forged",
      } as never),
    ).sequence;
    expect(ignoredText).not.toContain("forged");

    const width = 4096;
    const height = 256;
    const noisy = new Uint8Array(width * height * 4);
    const levels = [0, 36, 73, 109, 146, 182, 219, 255];
    let state = 0x12345678;
    for (let pixel = 0; pixel < width * height; pixel += 1) {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      const value = levels[state >>> 29] ?? 0;
      noisy[pixel * 4] = value;
      noisy[pixel * 4 + 1] = value;
      noisy[pixel * 4 + 2] = value;
      noisy[pixel * 4 + 3] = 255;
    }
    expect(encodeSixel({ pixels: noisy, width, height })).toMatchObject({
      ok: false,
      reason: "output-limit",
    });
    expect(MAX_SIXEL_ENCODED_BYTES).toBe(1024 * 1024);
  });

  it("returns ceil-divided cell dimensions only for strict bounded metrics", () => {
    expect(imageCellSize(17, 13, 8, 6)).toEqual({ width: 3, height: 3 });
    for (const invalid of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(imageCellSize(invalid, 1, 1, 1)).toBeUndefined();
      expect(imageCellSize(1, invalid, 1, 1)).toBeUndefined();
      expect(imageCellSize(1, 1, invalid, 1)).toBeUndefined();
      expect(imageCellSize(1, 1, 1, invalid)).toBeUndefined();
    }
    expect(imageCellSize(MAX_SIXEL_WIDTH + 1, 1, 1, 1)).toBeUndefined();
    expect(imageCellSize(1, MAX_SIXEL_HEIGHT + 1, 1, 1)).toBeUndefined();
    expect(imageCellSize(1, 1, MAX_SIXEL_WIDTH + 1, 1)).toBeUndefined();
    expect(imageCellSize(1, 1, 1, MAX_SIXEL_WIDTH + 1)).toBeUndefined();
  });

  it("contains only fixed DCS grammar and never source text", () => {
    const sequence = success(
      encodeSixel({
        pixels: pixelsFor([0, 255], 2),
        width: 2,
        height: 1,
      }),
    ).sequence;
    expect(sequence).not.toContain("tex");
    expect(sequence).not.toContain("forged");
    expect(sequence.split(ESC)).toHaveLength(3);
    expect(sequence.slice(1, -ST.length)).not.toContain(ESC);
    expect(
      [...sequence].every(
        (character) => character === ESC || (character >= " " && character <= "~"),
      ),
    ).toBe(true);
  });
});
