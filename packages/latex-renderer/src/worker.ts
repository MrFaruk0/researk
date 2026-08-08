import { parentPort } from "node:worker_threads";
import { Resvg } from "@resvg/resvg-js";
import {
  type LatexSvgStructure,
  LatexSvgRenderError,
  renderTexToValidatedSvgInWorker,
} from "./core.js";
import { isWorkerRenderRequest } from "./protocol.js";

if (parentPort === null) throw new Error("The LaTeX renderer must run as a worker thread.");

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
      const viewBox = /\bviewBox="[^" ]+ [^" ]+ ([^" ]+) ([^" ]+)"/u.exec(result.svg);
      const sourceWidth = Number(viewBox?.[1]);
      const sourceHeight = Number(viewBox?.[2]);
      if (!(sourceWidth > 0) || !(sourceHeight > 0)) throw new Error("Invalid SVG dimensions.");
      const targetWidth = 1200;
      const targetHeight = Math.ceil((sourceHeight / sourceWidth) * targetWidth);
      if (targetHeight > 2048 || targetWidth * targetHeight > 8_388_608) {
        throw new Error("Raster dimensions exceed the renderer limit.");
      }
      // The SVG is proven path-only above, so no font can participate in this image and disabling
      // system fonts is lossless: PNG output is byte-identical with enumeration on and off. It also
      // removes resvg's host-font enumeration, which is unbounded work charged to the per-render
      // timeout and is the platform-dependent cost that made rasterization fail on font-heavy hosts.
      const image = new Resvg(result.svg, {
        fitTo: { mode: "width", value: targetWidth },
        font: { loadSystemFonts: false },
      }).render();
      if (image.width > 4096 || image.height > 2048 || image.width * image.height > 8_388_608) {
        throw new Error("Raster dimensions exceed the renderer limit.");
      }
      const png = image.asPng();
      if (png.byteLength > 8 * 1024 * 1024)
        throw new Error("Raster payload exceeds the renderer limit.");
      port.postMessage({
        type: "result",
        id: value.id,
        result: { ...result, png, width: image.width, height: image.height },
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
