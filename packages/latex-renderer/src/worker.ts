import { parentPort } from "node:worker_threads";
import { Resvg } from "@resvg/resvg-js";
import {
  type LatexSvgStructure,
  LatexSvgRenderError,
  renderTexToValidatedSvgInWorker,
} from "./core.js";
import {
  isWorkerRenderRequest,
  maximumPngBytes,
  maximumRasterArea,
  maximumRasterHeight,
  maximumRasterWidth,
  maximumRgbaBytes,
} from "./protocol.js";

if (parentPort === null) throw new Error("The LaTeX renderer must run as a worker thread.");

/**
 * Raster scale is deliberately fixed at 2x MathJax's natural SVG size. This keeps ordinary
 * expressions close to their source dimensions while giving terminal protocols enough pixels for
 * clean glyph edges (for example, the formula-example fixture is about 380px wide), and avoids
 * stretching every short expression to one arbitrary 1200px canvas. The protocol ceilings remain
 * authoritative for the resulting dimensions, area, and encoded payload.
 */
const rasterScale = 2;

/** Fixed opaque raster margin, in final pixels, on every side of the formula canvas. */
const rasterPadding = 4;

/**
 * Decides whether a validated SVG can be rasterized without any font.
 *
 * Most MathJax output under `fontCache: "none"` is pure `<path>` geometry, and such an SVG
 * rasterizes to a byte-identical PNG whether or not host fonts are loaded. That is *not* universal.
 * MathJax falls back to a real glyph run, emitting a `<text>` element with a `font-family` attribute
 * or an `<mtext>` wrapper carrying `style="font-family: serif;"`, for at least:
 *
 * - CJK and other characters outside the bundled math font, e.g. `x = 中文`
 * - emoji and pictographic symbols, e.g. `x = 😀`
 * - `merror` markers for invalid TeX, e.g. `\frac{1}` or an undefined control sequence
 *
 * Such an SVG cannot be rasterized correctly here. Loading host fonts is rejected because it makes
 * the image depend on host font state and charges unbounded enumeration time to the render timeout;
 * rasterizing without them silently drops every glyph and produces a wrong or empty image. ADR 0006
 * requires exact source on any unsafe or unreliable graphical render, so this case fails closed and
 * the CLI presents canonical LaTeX instead.
 *
 * The decision reads structural facts collected by the SVG validator's own parse. It must not be a
 * substring test over the serialization: every MathJax element carries a `data-latex` attribute that
 * echoes the caller's TeX verbatim, so `x_{font-family}`, `\frac{font-family}{2}`, and
 * `\mbox{font-family: serif}` all put those exact bytes into pure-path output and a string test
 * refuses valid math. `font-family` is still checked independently of `<text>` so a future MathJax
 * revision that paints a font-backed glyph through a different element still fails closed.
 */
function requiresFontBackedText(structure: LatexSvgStructure): boolean {
  return structure.hasTextElement || structure.hasFontFamily;
}

// The worker has no application callbacks or paths and its dependency graph contains no network,
// filesystem, shell, subprocess, browser, or system-TeX adapter. TeX enters only as message data.
const port = parentPort;
port.on("message", (value: unknown) => {
  if (!isWorkerRenderRequest(value)) return;
  try {
    const { result, structure } = renderTexToValidatedSvgInWorker({
      tex: value.tex,
      display: value.display,
    });
    if (value.format === "png") {
      // Fail closed before rasterizing anything font-backed. Producing a PNG here would mean
      // either a host-dependent image or one with glyphs silently missing; ADR 0006 requires the
      // caller to fall back to exact source instead. `render_failed` is the in-contract code for
      // "this expression has no reliable graphical form", which is exactly the situation.
      if (requiresFontBackedText(structure)) {
        throw new LatexSvgRenderError(
          "render_failed",
          "The expression requires font-backed text that the renderer cannot rasterize safely.",
        );
      }
      // The SVG is proven path-only above, so no font can participate in this image and disabling
      // system fonts is lossless: PNG output is byte-identical with enumeration on and off. It also
      // removes resvg's host-font enumeration, which is unbounded work charged to the per-render
      // timeout and is the platform-dependent cost that made rasterization fail on font-heavy hosts.
      // A white background is explicit because terminal image protocols otherwise preserve
      // transparent pixels, which makes dark formula glyphs disappear into a dark TUI.
      const rasterizer = new Resvg(result.svg, {
        fitTo: { mode: "zoom", value: rasterScale },
        background: "#ffffff",
        font: { loadSystemFonts: false },
      });
      // Resvg's public width/height properties describe the unscaled SVG. Its normalized SVG
      // serialization carries the fractional natural dimensions, so derive the exact rounded
      // 2x source canvas before allocating any native pixel buffer.
      const normalizedSvg = rasterizer.toString();
      const naturalDimensions = readNormalizedDimensions(normalizedSvg);
      const sourceWidth = scaleDimension(naturalDimensions.width);
      const sourceHeight = scaleDimension(naturalDimensions.height);
      const paddedWidth = sourceWidth + rasterPadding * 2;
      const paddedHeight = sourceHeight + rasterPadding * 2;
      assertRasterDimensions(sourceWidth, sourceHeight);
      assertRasterDimensions(paddedWidth, paddedHeight);

      // The nested SVG keeps the exact path geometry at its already selected natural scale. Only
      // the outer viewport grows, so no expression is stretched to fill a larger canvas.
      const paddedSvg = addRasterPadding(
        normalizedSvg,
        sourceWidth,
        sourceHeight,
        paddedWidth,
        paddedHeight,
      );
      const paddedRasterizer = new Resvg(paddedSvg, {
        fitTo: { mode: "original" },
        background: "#ffffff",
        font: { loadSystemFonts: false },
      });
      if (paddedRasterizer.width !== paddedWidth || paddedRasterizer.height !== paddedHeight) {
        throw new Error("Raster dimensions changed while applying padding.");
      }
      const image = paddedRasterizer.render();
      assertRasterDimensions(image.width, image.height);
      const png = image.asPng();
      if (png.byteLength > maximumPngBytes)
        throw new Error("Raster payload exceeds the renderer limit.");
      const pixels = new Uint8Array(image.pixels);
      if (
        pixels.byteLength > maximumRgbaBytes ||
        pixels.byteLength !== image.width * image.height * 4
      ) {
        throw new Error("Raster pixel payload has an unexpected size.");
      }
      port.postMessage({
        type: "result",
        id: value.id,
        result: { ...result, png, pixels, width: image.width, height: image.height },
      });
    } else {
      port.postMessage({ type: "result", id: value.id, result });
    }
  } catch (error) {
    port.postMessage({
      type: "error",
      id: value.id,
      code: error instanceof LatexSvgRenderError ? error.code : "render_failed",
      message: "The isolated LaTeX renderer could not render the expression.",
    });
  }
});
port.postMessage({ type: "ready" });

interface NormalizedDimensions {
  readonly height: number;
  readonly width: number;
}

/** Reads dimensions only from Resvg's own normalized, already-validated SVG serialization. */
function readNormalizedDimensions(svg: string): NormalizedDimensions {
  const match = /^<svg\s+width="([0-9]+(?:\.[0-9]+)?)"\s+height="([0-9]+(?:\.[0-9]+)?)"/u.exec(svg);
  const width = Number(match?.[1]);
  const height = Number(match?.[2]);
  if (!(width > 0) || !(height > 0) || !Number.isFinite(width) || !Number.isFinite(height)) {
    throw new Error("Raster dimensions are invalid.");
  }
  return { height, width };
}

function scaleDimension(value: number): number {
  const scaled = Math.round(value * rasterScale);
  if (!Number.isSafeInteger(scaled) || scaled < 1) {
    throw new Error("Raster dimensions are invalid.");
  }
  return scaled;
}

function assertRasterDimensions(width: number, height: number): void {
  if (
    width < 1 ||
    height < 1 ||
    width > maximumRasterWidth ||
    height > maximumRasterHeight ||
    width * height > maximumRasterArea
  ) {
    throw new Error("Raster dimensions exceed the renderer limit.");
  }
}

/**
 * Wraps Resvg's normalized path SVG in a larger opaque viewport. The inner dimensions are explicit
 * pixels, preserving the selected scale; the caller's validated SVG is never altered or returned.
 */
function addRasterPadding(
  svg: string,
  sourceWidth: number,
  sourceHeight: number,
  paddedWidth: number,
  paddedHeight: number,
): string {
  const openingEnd = svg.indexOf(">");
  const closingStart = svg.lastIndexOf("</svg>");
  if (openingEnd < 0 || closingStart <= openingEnd || !svg.startsWith("<svg")) {
    throw new Error("Raster SVG has invalid root markup.");
  }

  const openingAttributes = svg
    .slice("<svg".length, openingEnd)
    .replace(/\s(?:width|height|x|y|preserveAspectRatio)="[^"]*"/gu, "");
  const body = svg.slice(openingEnd + 1, closingStart);
  const inner = `<svg${openingAttributes} x="${rasterPadding}" y="${rasterPadding}" width="${sourceWidth}" height="${sourceHeight}">${body}</svg>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${paddedWidth}" height="${paddedHeight}" viewBox="0 0 ${paddedWidth} ${paddedHeight}">${inner}</svg>`;
}
