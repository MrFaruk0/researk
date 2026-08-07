import { parentPort, workerData } from "node:worker_threads";

/**
 * Emits exactly one malformed protocol message on the first attempt, then behaves correctly.
 *
 * The pool must reject the malformed message as a worker failure, terminate and replace the worker,
 * and never surface any field of the malformed message. The shared attempt counter lets a test prove
 * the replacement actually happened.
 */

/** Any occurrence of this in a caller-visible error means worker text leaked through. */
const secret = "WORKER_INTERNAL_SECRET";

const maximumSvgLength = 1024 * 1024;
const maximumPngBytes = 8 * 1024 * 1024;

const attempt = Atomics.add(new Int32Array(workerData.state), 0, 1);
const mode = workerData.mode;

if (mode === "ready-extra-field") {
  // Not an exact ready handshake, so the slot must never become usable.
  parentPort.postMessage({ type: "ready", detail: secret });
} else if (mode === "ready-wrong-type") {
  parentPort.postMessage({ type: "initialized" });
} else {
  parentPort.postMessage({ type: "ready" });
}

function validPayload(request) {
  const base = {
    display: request.display,
    renderer: "mathjax-4.1.3",
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"></svg>',
    tex: request.tex,
  };
  if (request.format !== "png") return base;
  return { ...base, png: new Uint8Array([1, 2, 3, 4]), width: 8, height: 4 };
}

function malformed(request) {
  const id = request.id;
  const payload = validPayload(request);

  switch (mode) {
    // Discriminator
    case "unknown-discriminator":
      return { type: "internal-secret", id, detail: secret };
    case "ready-as-response":
      return { type: "ready", id };
    case "missing-type":
      return { id, result: payload };
    case "array-message":
      return [{ type: "result", id, result: payload }];

    // Request id
    case "id-mismatch":
      return { type: "result", id: id + 1, result: payload };
    case "id-zero":
      return { type: "result", id: 0, result: payload };
    case "id-unsafe":
      return { type: "result", id: Number.MAX_SAFE_INTEGER, result: payload };
    case "id-fractional":
      return { type: "result", id: id + 0.5, result: payload };
    case "id-string":
      return { type: "result", id: String(id), result: payload };

    // Envelope shape
    case "result-extra-field":
      return { type: "result", id, result: payload, detail: secret };
    case "error-extra-field":
      return { type: "error", id, code: "render_failed", message: "nope", detail: secret };
    case "result-missing-result":
      return { type: "result", id };
    case "result-null-result":
      return { type: "result", id, result: null };

    // Error contract
    case "error-unknown-code":
      return { type: "error", id, code: "totally_unknown", message: secret };
    case "error-pool-owned-code":
      return { type: "error", id, code: "worker_failed", message: secret };
    case "error-code-not-string":
      return { type: "error", id, code: 7, message: "nope" };
    case "error-message-too-long":
      return { type: "error", id, code: "render_failed", message: secret.repeat(200) };
    case "error-message-not-string":
      return { type: "error", id, code: "render_failed", message: { detail: secret } };

    // Reflected worker text on an otherwise valid error
    case "error-reflecting-text":
      return { type: "error", id, code: "render_failed", message: secret };

    // Payload shape
    case "payload-extra-field":
      return { type: "result", id, result: { ...payload, detail: secret } };
    case "payload-missing-svg": {
      const { svg: _svg, ...rest } = payload;
      return { type: "result", id, result: rest };
    }
    case "payload-svg-not-string":
      return { type: "result", id, result: { ...payload, svg: { detail: secret } } };
    case "payload-svg-too-long":
      return { type: "result", id, result: { ...payload, svg: "x".repeat(maximumSvgLength + 1) } };
    case "payload-wrong-renderer":
      return { type: "result", id, result: { ...payload, renderer: "mathjax-9.9.9" } };
    case "payload-substituted-tex":
      return { type: "result", id, result: { ...payload, tex: secret } };
    case "payload-flipped-display":
      return { type: "result", id, result: { ...payload, display: !request.display } };

    // Operation consistency
    case "svg-request-with-raster":
      return {
        type: "result",
        id,
        result: { ...payload, png: new Uint8Array([1]), width: 8, height: 4 },
      };
    case "png-request-without-raster": {
      const { png: _png, width: _width, height: _height, ...rest } = payload;
      return { type: "result", id, result: rest };
    }

    // Raster payload
    case "png-not-uint8array":
      return { type: "result", id, result: { ...payload, png: [1, 2, 3, 4] } };
    case "png-shared-memory": {
      const shared = new Uint8Array(new SharedArrayBuffer(4));
      return { type: "result", id, result: { ...payload, png: shared } };
    }
    case "png-empty":
      return { type: "result", id, result: { ...payload, png: new Uint8Array(0) } };
    case "png-too-large":
      return {
        type: "result",
        id,
        result: { ...payload, png: new Uint8Array(maximumPngBytes + 1) },
      };

    // Dimensions
    case "width-zero":
      return { type: "result", id, result: { ...payload, width: 0 } };
    case "width-negative":
      return { type: "result", id, result: { ...payload, width: -8 } };
    case "width-fractional":
      return { type: "result", id, result: { ...payload, width: 8.5 } };
    case "width-infinite":
      return { type: "result", id, result: { ...payload, width: Number.POSITIVE_INFINITY } };
    case "width-nan":
      return { type: "result", id, result: { ...payload, width: Number.NaN } };
    case "width-not-number":
      return { type: "result", id, result: { ...payload, width: "8" } };
    case "width-over-ceiling":
      return { type: "result", id, result: { ...payload, width: 4097 } };
    case "height-zero":
      return { type: "result", id, result: { ...payload, height: 0 } };
    case "height-infinite":
      return { type: "result", id, result: { ...payload, height: Number.POSITIVE_INFINITY } };
    case "height-over-ceiling":
      return { type: "result", id, result: { ...payload, height: 2049 } };

    // Boundary that must be accepted rather than rejected.
    case "raster-at-ceiling":
      return { type: "result", id, result: { ...payload, width: 4096, height: 2048 } };

    default:
      throw new Error(`Unknown malformed-worker mode: ${String(mode)}`);
  }
}

parentPort.on("message", (request) => {
  if (attempt === 0) {
    parentPort.postMessage(malformed(request));
    return;
  }
  parentPort.postMessage({ type: "result", id: request.id, result: validPayload(request) });
});
