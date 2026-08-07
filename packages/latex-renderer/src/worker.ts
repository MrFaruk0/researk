import { parentPort } from "node:worker_threads";
import { Resvg } from "@resvg/resvg-js";
import { LatexSvgRenderError, renderTexToSvgInWorker } from "./core.js";
import { isWorkerRenderRequest } from "./protocol.js";

if (parentPort === null) throw new Error("The LaTeX renderer must run as a worker thread.");

// The worker has no application callbacks or paths and its dependency graph contains no network,
// filesystem, shell, subprocess, browser, or system-TeX adapter. TeX enters only as message data.
const port = parentPort;
port.on("message", (value: unknown) => {
  if (!isWorkerRenderRequest(value)) return;
  try {
    const result = renderTexToSvgInWorker({ tex: value.tex, display: value.display });
    if (value.format === "png") {
      const viewBox = /\bviewBox="[^" ]+ [^" ]+ ([^" ]+) ([^" ]+)"/u.exec(result.svg);
      const sourceWidth = Number(viewBox?.[1]);
      const sourceHeight = Number(viewBox?.[2]);
      if (!(sourceWidth > 0) || !(sourceHeight > 0)) throw new Error("Invalid SVG dimensions.");
      const targetWidth = 1200;
      const targetHeight = Math.ceil((sourceHeight / sourceWidth) * targetWidth);
      if (targetHeight > 2048 || targetWidth * targetHeight > 8_388_608) {
        throw new Error("Raster dimensions exceed the renderer limit.");
      }
      const image = new Resvg(result.svg, {
        fitTo: { mode: "width", value: targetWidth },
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
