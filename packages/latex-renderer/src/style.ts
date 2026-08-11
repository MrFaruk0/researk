/**
 * Pixel-affecting presentation options for a formula raster.
 *
 * The style is deliberately data-only. Theme resolution belongs to the caller; this package only
 * accepts a bounded CSS color and applies it to MathJax's `currentColor` glyphs. `background` is
 * optional so a styled formula can retain the terminal's own background through alpha.
 */
export interface LatexRenderStyle {
  readonly foreground: string;
  readonly background?: string;
  readonly fontScale?: number;
  readonly dpi?: number;
}

/** Domain-facing alias matching the formula renderer terminology used by presentation layers. */
export type FormulaRenderStyle = LatexRenderStyle;

/** The fully populated, canonical form sent across the worker boundary. */
export interface NormalizedLatexRenderStyle {
  readonly foreground: string;
  readonly background?: string;
  readonly fontScale: number;
  readonly dpi: number;
}

export const latexRenderStyleLimits = Object.freeze({
  defaultDpi: 96,
  defaultFontScale: 1,
  maximumDpi: 600,
  maximumFontScale: 4,
  minimumDpi: 72,
  minimumFontScale: 0.5,
});

/**
 * A compatibility-only identity for requests that predate the style contract. It intentionally
 * remains separate from `normalizeLatexRenderStyle(undefined)`: the new styled path has no default
 * background, while legacy PNG calls retain their established opaque-white canvas.
 */
export const legacyLatexRasterStyle = Object.freeze({
  dpi: latexRenderStyleLimits.defaultDpi,
  fontScale: latexRenderStyleLimits.defaultFontScale,
});

const styleKeys = new Set(["foreground", "background", "fontScale", "dpi"]);

/** A conservative CSS color grammar suitable for an SVG attribute and Resvg option. */
const hexadecimalColorPattern = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/iu;
const rgbColorPattern = /^rgba?\((.*)\)$/iu;
const hslColorPattern = /^hsla?\((.*)\)$/iu;

// CSS color keywords accepted by Resvg. Keeping this closed prevents CSS declarations, URLs, and
// terminal escape fragments from crossing into SVG or the native rasterizer.
const cssColorKeywords = new Set([
  "aliceblue",
  "antiquewhite",
  "aqua",
  "aquamarine",
  "azure",
  "beige",
  "bisque",
  "black",
  "blanchedalmond",
  "blue",
  "blueviolet",
  "brown",
  "burlywood",
  "cadetblue",
  "chartreuse",
  "chocolate",
  "coral",
  "cornflowerblue",
  "cornsilk",
  "crimson",
  "cyan",
  "darkblue",
  "darkcyan",
  "darkgoldenrod",
  "darkgray",
  "darkgreen",
  "darkgrey",
  "darkkhaki",
  "darkmagenta",
  "darkolivegreen",
  "darkorange",
  "darkorchid",
  "darkred",
  "darksalmon",
  "darkseagreen",
  "darkslateblue",
  "darkslategray",
  "darkslategrey",
  "darkturquoise",
  "darkviolet",
  "deeppink",
  "deepskyblue",
  "dimgray",
  "dimgrey",
  "dodgerblue",
  "firebrick",
  "floralwhite",
  "forestgreen",
  "fuchsia",
  "gainsboro",
  "ghostwhite",
  "gold",
  "goldenrod",
  "gray",
  "green",
  "greenyellow",
  "grey",
  "honeydew",
  "hotpink",
  "indianred",
  "indigo",
  "ivory",
  "khaki",
  "lavender",
  "lavenderblush",
  "lawngreen",
  "lemonchiffon",
  "lightblue",
  "lightcoral",
  "lightcyan",
  "lightgoldenrodyellow",
  "lightgray",
  "lightgreen",
  "lightgrey",
  "lightpink",
  "lightsalmon",
  "lightseagreen",
  "lightskyblue",
  "lightslategray",
  "lightslategrey",
  "lightsteelblue",
  "lightyellow",
  "lime",
  "limegreen",
  "linen",
  "magenta",
  "maroon",
  "mediumaquamarine",
  "mediumblue",
  "mediumorchid",
  "mediumpurple",
  "mediumseagreen",
  "mediumslateblue",
  "mediumspringgreen",
  "mediumturquoise",
  "mediumvioletred",
  "midnightblue",
  "mintcream",
  "mistyrose",
  "moccasin",
  "navajowhite",
  "navy",
  "oldlace",
  "olive",
  "olivedrab",
  "orange",
  "orangered",
  "orchid",
  "palegoldenrod",
  "palegreen",
  "paleturquoise",
  "palevioletred",
  "papayawhip",
  "peachpuff",
  "peru",
  "pink",
  "plum",
  "powderblue",
  "purple",
  "rebeccapurple",
  "red",
  "rosybrown",
  "royalblue",
  "saddlebrown",
  "salmon",
  "sandybrown",
  "seagreen",
  "seashell",
  "sienna",
  "silver",
  "skyblue",
  "slateblue",
  "slategray",
  "slategrey",
  "snow",
  "springgreen",
  "steelblue",
  "tan",
  "teal",
  "thistle",
  "tomato",
  "transparent",
  "turquoise",
  "violet",
  "wheat",
  "white",
  "whitesmoke",
  "yellow",
  "yellowgreen",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactStyleKeys(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value);
  if (keys.length < 1 || keys.length > styleKeys.size) return false;
  return keys.every((key) => styleKeys.has(key));
}

function isBoundedRgb(value: string): boolean {
  const match = rgbColorPattern.exec(value);
  if (match?.[1] === undefined) return false;
  const channels = match[1].split(",").map((channel) => channel.trim());
  if (channels.length !== 3 && channels.length !== 4) return false;
  for (const channel of channels.slice(0, 3)) {
    const parsed = /^(\d{1,3})(%)?$/u.exec(channel);
    if (parsed?.[1] === undefined) return false;
    const numeric = Number(parsed[1]);
    const maximum = parsed[2] === undefined ? 255 : 100;
    if (numeric > maximum) return false;
  }
  if (channels.length === 4) {
    const alpha = channels[3];
    if (alpha === undefined) return false;
    if (/^\d+(?:\.\d+)?%$/u.test(alpha)) {
      if (Number.parseFloat(alpha) > 100) return false;
    } else if (/^(?:0|1|0?\.\d+)$/u.test(alpha)) {
      if (Number(alpha) > 1) return false;
    } else {
      return false;
    }
  }
  return true;
}

function isBoundedHsl(value: string): boolean {
  const match = hslColorPattern.exec(value);
  if (match?.[1] === undefined) return false;
  const channels = match[1].split(",").map((channel) => channel.trim());
  if (channels.length !== 3 && channels.length !== 4) return false;
  if (!/^[-+]?\d+(?:\.\d+)?(?:deg|grad|rad|turn)?$/iu.test(channels[0] ?? "")) {
    return false;
  }
  for (const channel of channels.slice(1, 3)) {
    const parsed = /^(\d+(?:\.\d+)?)%$/u.exec(channel);
    if (parsed?.[1] === undefined || Number(parsed[1]) > 100) return false;
  }
  if (channels.length === 4) {
    const alpha = channels[3];
    if (alpha === undefined) return false;
    if (/^\d+(?:\.\d+)?%$/u.test(alpha)) {
      if (Number.parseFloat(alpha) > 100) return false;
    } else if (/^(?:0|1|0?\.\d+)$/u.test(alpha)) {
      if (Number(alpha) > 1) return false;
    } else {
      return false;
    }
  }
  return true;
}

/**
 * Returns a canonical lowercase color when the value is a bounded CSS color accepted by Resvg.
 * Numeric function channels are range-checked as part of the grammar's bounded integer limits;
 * malformed or unsupported CSS is rejected instead of being passed to the native parser.
 */
export function normalizeLatexColor(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length < 1 || value.length > 64) return undefined;
  const color = value.trim();
  if (color.length !== value.length) return undefined;
  const lower = color.toLowerCase();
  if (
    cssColorKeywords.has(lower) ||
    hexadecimalColorPattern.test(color) ||
    isBoundedRgb(color) ||
    isBoundedHsl(color)
  ) {
    return lower;
  }
  return undefined;
}

/**
 * Validates and canonicalizes a caller style. `undefined` is the explicit legacy/no-style path;
 * callers that need transparent output must provide a foreground style object.
 */
export function normalizeLatexRenderStyle(value: unknown): NormalizedLatexRenderStyle | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || !hasExactStyleKeys(value)) {
    throw new Error("Invalid LaTeX render style.");
  }

  const foreground = normalizeLatexColor(value.foreground);
  if (foreground === undefined || foreground === "transparent") {
    throw new Error("LaTeX render style foreground must be a visible CSS color.");
  }

  let background: string | undefined;
  if (value.background !== undefined) {
    background = normalizeLatexColor(value.background);
    if (background === undefined) throw new Error("LaTeX render style background is invalid.");
  }

  const fontScale =
    value.fontScale === undefined ? latexRenderStyleLimits.defaultFontScale : value.fontScale;
  if (
    typeof fontScale !== "number" ||
    !Number.isFinite(fontScale) ||
    fontScale < latexRenderStyleLimits.minimumFontScale ||
    fontScale > latexRenderStyleLimits.maximumFontScale
  ) {
    throw new Error("LaTeX render style fontScale is outside the supported bounds.");
  }

  const dpi = value.dpi === undefined ? latexRenderStyleLimits.defaultDpi : value.dpi;
  if (
    typeof dpi !== "number" ||
    !Number.isInteger(dpi) ||
    dpi < latexRenderStyleLimits.minimumDpi ||
    dpi > latexRenderStyleLimits.maximumDpi
  ) {
    throw new Error("LaTeX render style dpi is outside the supported bounds.");
  }

  return Object.freeze({
    ...(background === undefined ? {} : { background }),
    dpi,
    fontScale,
    foreground,
  });
}

/** Runtime predicate used by the worker protocol before dispatching untrusted messages. */
export function isLatexRenderStyle(value: unknown): value is LatexRenderStyle {
  try {
    return normalizeLatexRenderStyle(value) !== undefined;
  } catch {
    return false;
  }
}
