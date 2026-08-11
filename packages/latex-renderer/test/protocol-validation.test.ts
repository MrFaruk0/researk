import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";
import {
  LatexRenderBudget,
  type ManagedLatexRenderErrorCode,
  ManagedLatexRenderer,
} from "../src/index.js";
import {
  isWorkerReadyMessage,
  isWorkerRenderRequest,
  maximumRequestId,
  parseWorkerResponse,
  workerErrorCodes,
} from "../src/protocol.js";

/**
 * The worker protocol is a trust boundary. These are negative tests: every malformed message must
 * fail as `worker_failed`, must replace the worker, and must not reflect any worker-supplied text.
 */

/** The fixture embeds this in every field a leak could travel through. */
const secret = "WORKER_INTERNAL_SECRET";

const renderers: ManagedLatexRenderer[] = [];
afterEach(async () => Promise.all(renderers.splice(0).map((renderer) => renderer.close())));

interface Harness {
  readonly renderer: ManagedLatexRenderer;
  readonly attempts: () => number;
}

function createHarness(mode: string, module = "./malformed-worker.mjs"): Harness {
  const state = new SharedArrayBuffer(4);
  const renderer = new ManagedLatexRenderer({
    concurrency: 1,
    renderTimeoutMs: 250,
    initializationTimeoutMs: 250,
    workerFactory: () =>
      new Worker(new URL(module, import.meta.url), {
        execArgv: [],
        workerData: { mode, state },
      }),
  });
  renderers.push(renderer);
  return { renderer, attempts: () => Atomics.load(new Int32Array(state), 0) };
}

/** Every string a caller can reach, so a leak cannot hide in a nested cause. */
function errorSurface(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current instanceof Error && depth < 8; depth += 1) {
    parts.push(current.name, current.message, current.stack ?? "");
    current = current.cause;
  }
  parts.push(JSON.stringify(error, Object.getOwnPropertyNames(error ?? {})));
  return parts.join("\n");
}

const malformedModes = [
  // Discriminator
  "unknown-discriminator",
  "ready-as-response",
  "missing-type",
  "array-message",
  // Bounded, exactly matching request id
  "id-mismatch",
  "id-zero",
  "id-unsafe",
  "id-fractional",
  "id-string",
  // Envelope shape
  "result-extra-field",
  "error-extra-field",
  "result-missing-result",
  "result-null-result",
  // Known error codes and bounded message
  "error-unknown-code",
  "error-pool-owned-code",
  "error-code-not-string",
  "error-message-too-long",
  "error-message-not-string",
  // Payload shape and SVG ceiling
  "payload-extra-field",
  "payload-style-extra-field",
  "payload-missing-svg",
  "payload-svg-not-string",
  "payload-svg-too-long",
  "payload-wrong-renderer",
  "payload-substituted-tex",
  "payload-flipped-display",
  // Operation consistency
  "svg-request-with-raster",
  // Raster payload
  "png-not-uint8array",
  "png-shared-memory",
  "png-empty",
  "pixels-not-uint8array",
  "pixels-shared-memory",
  "pixels-empty",
  "pixels-wrong-length",
  // Dimensions
  "width-zero",
  "width-negative",
  "width-fractional",
  "width-infinite",
  "width-nan",
  "width-not-number",
  "width-over-ceiling",
  "height-zero",
  "height-infinite",
  "height-over-ceiling",
] as const;

/** Modes whose malformed payload is only reachable through a PNG request. */
const pngOnlyModes = new Set<string>([
  "png-not-uint8array",
  "png-shared-memory",
  "png-empty",
  "pixels-not-uint8array",
  "pixels-shared-memory",
  "pixels-empty",
  "pixels-wrong-length",
  "width-zero",
  "width-negative",
  "width-fractional",
  "width-infinite",
  "width-nan",
  "width-not-number",
  "width-over-ceiling",
  "height-zero",
  "height-infinite",
  "height-over-ceiling",
]);

describe("worker protocol validation", () => {
  it("accepts a bounded style request and rejects malformed or open style shapes", () => {
    const base = {
      type: "render" as const,
      id: 1,
      tex: "x^2",
      display: true,
      format: "png" as const,
    };

    expect(
      isWorkerRenderRequest({
        ...base,
        style: { foreground: "#5fd7ff", fontScale: 1, dpi: 96 },
      }),
    ).toBe(true);
    expect(
      isWorkerRenderRequest({
        ...base,
        style: { foreground: "not-a-color", fontScale: 1, dpi: 96 },
      }),
    ).toBe(false);
    expect(
      isWorkerRenderRequest({
        ...base,
        style: { foreground: "#fff", fontScale: 0.1, dpi: 96 },
      }),
    ).toBe(false);
    expect(
      isWorkerRenderRequest({
        ...base,
        style: { foreground: "#fff", fontScale: null, dpi: 96 },
      }),
    ).toBe(false);
    expect(
      isWorkerRenderRequest({
        ...base,
        style: { foreground: "#fff", fontScale: 1, dpi: 601 },
      }),
    ).toBe(false);
    expect(
      isWorkerRenderRequest({
        ...base,
        style: { foreground: "#fff", fontScale: 1, dpi: 96, unknown: true },
      }),
    ).toBe(false);
    expect(isWorkerRenderRequest({ ...base, unknown: true })).toBe(false);
    expect(isWorkerRenderRequest({ ...base, tex: "x".repeat(16 * 1024 + 1) })).toBe(false);
  });

  it.each(malformedModes)(
    "rejects a %s message as worker_failed and replaces the worker",
    async (mode) => {
      const format = pngOnlyModes.has(mode) ? "png" : "svg";
      const { renderer, attempts } = createHarness(mode);
      const budget = new LatexRenderBudget();

      const rejection = await renderer.render({ tex: "x^2" }, budget, undefined, format).then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(rejection).toBeInstanceOf(Error);
      expect(rejection).toMatchObject({
        code: "worker_failed" satisfies ManagedLatexRenderErrorCode,
      });
      // No worker-supplied text, in any field, at any depth.
      expect(errorSurface(rejection)).not.toContain(secret);

      // The poisoned worker is gone and a fresh one serves the next expression.
      await expect(renderer.render({ tex: "x" }, budget)).resolves.toMatchObject({ tex: "x" });
      expect(attempts()).toBe(2);
    },
  );

  it("rejects a png request answered without raster fields", async () => {
    const { renderer, attempts } = createHarness("png-request-without-raster");
    const budget = new LatexRenderBudget();

    await expect(renderer.render({ tex: "x^2" }, budget, undefined, "png")).rejects.toMatchObject({
      code: "worker_failed",
    });
    await expect(renderer.render({ tex: "x" }, budget)).resolves.toMatchObject({ tex: "x" });
    expect(attempts()).toBe(2);
  });

  it("rejects an oversized png payload as worker_failed", async () => {
    const { renderer, attempts } = createHarness("png-too-large");
    const budget = new LatexRenderBudget();

    await expect(renderer.render({ tex: "x^2" }, budget, undefined, "png")).rejects.toMatchObject({
      code: "worker_failed",
    });
    await expect(renderer.render({ tex: "x" }, budget)).resolves.toMatchObject({ tex: "x" });
    expect(attempts()).toBe(2);
  });

  it("accepts raster dimensions exactly at the ceiling without replacing the worker", async () => {
    const { renderer, attempts } = createHarness("raster-at-ceiling");

    const result = await renderer.render({ tex: "x^2" }, new LatexRenderBudget(), undefined, "png");

    expect(result).toMatchObject({ width: 4096, height: 2048 });
    // A valid response must not poison the slot.
    expect(attempts()).toBe(1);
  });

  it("maps a valid worker error code to a local sentence and never the worker's text", async () => {
    const { renderer, attempts } = createHarness("error-reflecting-text");
    const budget = new LatexRenderBudget();

    const rejection = await renderer.render({ tex: "x^2" }, budget).then(
      () => undefined,
      (error: unknown) => error,
    );

    // The code is in-contract, so it is preserved rather than downgraded.
    expect(rejection).toMatchObject({ code: "render_failed" });
    expect(errorSurface(rejection)).not.toContain(secret);
    // A reported render failure still poisons the worker.
    await expect(renderer.render({ tex: "x" }, budget)).resolves.toMatchObject({ tex: "x" });
    expect(attempts()).toBe(2);
  });

  it.each(["ready-extra-field", "ready-wrong-type"] as const)(
    "fails initialization when the handshake is %s",
    async (mode) => {
      const { renderer } = createHarness(mode);

      await expect(renderer.render({ tex: "x^2" }, new LatexRenderBudget())).rejects.toMatchObject({
        code: "worker_failed",
      });
    },
  );
});

describe("parseWorkerResponse", () => {
  const expected = { id: 7, format: "svg", tex: "x^2", display: true } as const;
  const payload = {
    display: true,
    renderer: "mathjax-4.1.3",
    svg: "<svg/>",
    tex: "x^2",
  } as const;
  const pngPayload = {
    ...payload,
    png: new Uint8Array([1, 2, 3]),
    pixels: new Uint8Array(8 * 4 * 4),
    width: 8,
    height: 4,
  } as const;

  it("accepts an exact in-contract result and error", () => {
    expect(parseWorkerResponse({ type: "result", id: 7, result: payload }, expected)).toMatchObject(
      {
        type: "result",
      },
    );
    expect(
      parseWorkerResponse({ type: "error", id: 7, code: "unsafe_svg", message: "no" }, expected),
    ).toMatchObject({ code: "unsafe_svg" });
  });

  it("accepts a bounded RGBA pixel plane alongside a PNG result", () => {
    expect(
      parseWorkerResponse(
        { type: "result", id: 7, result: pngPayload },
        { ...expected, format: "png" },
      ),
    ).toMatchObject({ type: "result" });
  });

  it.each([undefined, null, 0, "result", [], () => undefined])(
    "rejects the non-record message %s",
    (value) => {
      expect(parseWorkerResponse(value, expected)).toBeUndefined();
    },
  );

  it("rejects an id above the bound even when it is a safe integer", () => {
    expect(
      parseWorkerResponse(
        { type: "result", id: maximumRequestId + 1, result: payload },
        { ...expected, id: maximumRequestId + 1 },
      ),
    ).toBeUndefined();
  });

  it("accepts every code in the closed set and rejects everything else", () => {
    for (const code of workerErrorCodes) {
      expect(
        parseWorkerResponse({ type: "error", id: 7, code, message: "m" }, expected),
      ).toMatchObject({ code });
    }
    for (const code of ["worker_failed", "timeout", "cancelled", "expression_limit", ""]) {
      expect(
        parseWorkerResponse({ type: "error", id: 7, code, message: "m" }, expected),
      ).toBeUndefined();
    }
  });
});

describe("isWorkerReadyMessage", () => {
  it("accepts only the exact handshake", () => {
    expect(isWorkerReadyMessage({ type: "ready" })).toBe(true);
    expect(isWorkerReadyMessage({ type: "ready", extra: 1 })).toBe(false);
    expect(isWorkerReadyMessage({ type: "result" })).toBe(false);
    expect(isWorkerReadyMessage(null)).toBe(false);
  });
});

describe("isWorkerRenderRequest", () => {
  const request = { type: "render", id: 1, tex: "x", display: true, format: "svg" } as const;

  it("accepts a well-formed request and rejects malformed ones", () => {
    expect(isWorkerRenderRequest(request)).toBe(true);
    expect(isWorkerRenderRequest({ ...request, type: "eval" })).toBe(false);
    expect(isWorkerRenderRequest({ ...request, id: 0 })).toBe(false);
    expect(isWorkerRenderRequest({ ...request, id: 1.5 })).toBe(false);
    expect(isWorkerRenderRequest({ ...request, format: "pdf" })).toBe(false);
    expect(isWorkerRenderRequest({ ...request, display: "yes" })).toBe(false);
    expect(isWorkerRenderRequest({ ...request, tex: 1 })).toBe(false);
    expect(isWorkerRenderRequest(null)).toBe(false);
  });
});
