import { afterEach, describe, expect, it } from "vitest";
import { Worker, type WorkerOptions } from "node:worker_threads";
import {
  LatexRenderBudget,
  latexSvgRendererLimits,
  ManagedLatexRenderer,
  renderTexToSvg,
} from "../src/index.js";

const renderers: ManagedLatexRenderer[] = [];
afterEach(async () => Promise.all(renderers.splice(0).map((renderer) => renderer.close())));

/** Resolves once a worker thread is gone, so a leaked thread fails as an assertion, not a hang. */
async function waitForExit(worker: Worker): Promise<void> {
  await new Promise<void>((resolve) => {
    worker.once("exit", () => resolve());
    // A worker that already exited emits nothing further, so the terminate call settles it.
    void worker.terminate().then(() => resolve());
  });
}

describe("renderTexToSvg", () => {
  it("renders a real MathJax SVG artifact in a worker", async () => {
    const result = await renderTexToSvg({
      tex: "\\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}",
    });

    expect(result).toMatchObject({
      display: true,
      renderer: "mathjax-4.1.3",
      tex: "\\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}",
    });
    expect(result.svg).toMatch(/^<svg\b/u);
    expect(result.svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(result.svg).toContain('role="img"');
    expect(result.svg).toContain("<path");
    expect(result.svg).not.toContain("<mjx-container");
    expect(result.svg).not.toMatch(/<(?:script|foreignObject)\b/iu);
    expect(result.svg).not.toMatch(/\b(?:href|xlink:href)=/iu);
  });

  it("does not enable extension loading or active links through TeX input", async () => {
    const result = await renderTexToSvg({
      display: false,
      tex: "\\href{https://example.invalid}{x}",
    });

    expect(result.display).toBe(false);
    expect(result.svg).not.toMatch(/\b(?:href|xlink:href)=/iu);
    expect(result.svg).not.toMatch(/<(?:script|foreignObject)\b/iu);
  });

  it("rejects empty, unbalanced, over-nested, and oversized input before rendering", async () => {
    await expect(renderTexToSvg({ tex: "" })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(renderTexToSvg({ tex: "{x" })).rejects.toMatchObject({ code: "invalid_input" });

    const excessiveNesting = `${"{".repeat(latexSvgRendererLimits.maximumBraceNesting + 1)}x${"}".repeat(
      latexSvgRendererLimits.maximumBraceNesting + 1,
    )}`;
    await expect(renderTexToSvg({ tex: excessiveNesting })).rejects.toEqual(
      expect.objectContaining({ code: "input_limit" }),
    );

    await expect(
      renderTexToSvg({ tex: "x".repeat(latexSvgRendererLimits.maximumInputBytes + 1) }),
    ).rejects.toEqual(expect.objectContaining({ code: "input_limit" }));
  });

  it("enforces response expression and cumulative render-time budgets", async () => {
    const expressionBudget = new LatexRenderBudget();
    for (let index = 0; index < latexSvgRendererLimits.maximumExpressionsPerResponse; index += 1) {
      expressionBudget.claim();
    }
    expect(() => expressionBudget.claim()).toThrow(
      expect.objectContaining({ code: "expression_limit" }),
    );

    const timeBudget = new LatexRenderBudget();
    timeBudget.record(latexSvgRendererLimits.maximumCumulativeRenderMs);
    expect(() => timeBudget.claim()).toThrow(
      expect.objectContaining({ code: "render_time_limit" }),
    );
  });

  it("constructs pool workers without inheriting host execArgv", async () => {
    const observed: (WorkerOptions | undefined)[] = [];
    class RecordingWorker extends Worker {
      constructor(url: URL, options?: WorkerOptions) {
        observed.push(options);
        super(url, options);
      }
    }
    const renderer = new ManagedLatexRenderer({
      concurrency: 1,
      workerFactory: () =>
        new RecordingWorker(new URL("./fixture-worker.mjs", import.meta.url), {
          execArgv: [],
          workerData: { first: "none", state: new SharedArrayBuffer(4) },
        }),
    });
    renderers.push(renderer);
    await renderer.render({ tex: "x" }, new LatexRenderBudget());

    expect(observed.length).toBeGreaterThan(0);
    for (const options of observed) {
      expect(options?.execArgv).toEqual([]);
      expect(options?.execArgv).not.toBe(process.execArgv);
    }
  });

  it("leaves an idle pool worker unreferenced and refs it only for an active job", async () => {
    const calls: string[] = [];
    const renderer = new ManagedLatexRenderer({
      concurrency: 1,
      workerFactory: () => {
        const worker = new Worker(new URL("./fixture-worker.mjs", import.meta.url), {
          execArgv: [],
          workerData: { first: "none", state: new SharedArrayBuffer(4) },
        });
        const originalRef = worker.ref.bind(worker);
        const originalUnref = worker.unref.bind(worker);
        worker.ref = () => {
          calls.push("ref");
          originalRef();
        };
        worker.unref = () => {
          calls.push("unref");
          originalUnref();
        };
        return worker;
      },
    });
    renderers.push(renderer);

    expect(calls).toEqual(["unref"]);
    await renderer.render({ tex: "x" }, new LatexRenderBudget());
    expect(calls).toEqual(["unref", "ref", "unref"]);
  });

  it.each(["timeout", "crash", "protocol"] as const)(
    "terminates a %s worker, replaces it, and leaks no worker protocol",
    async (first) => {
      const state = new SharedArrayBuffer(4);
      const renderer = new ManagedLatexRenderer({
        concurrency: 1,
        renderTimeoutMs: 25,
        workerFactory: () =>
          new Worker(new URL("./fixture-worker.mjs", import.meta.url), {
            workerData: { first, state },
          }),
      });
      renderers.push(renderer);
      const budget = new LatexRenderBudget();

      await expect(
        renderer.render({ tex: "private protocol input" }, budget),
      ).rejects.toMatchObject({
        code: first === "timeout" ? "timeout" : "worker_failed",
      });
      await expect(renderer.render({ tex: "x" }, budget)).resolves.toMatchObject({ tex: "x" });
      expect(Atomics.load(new Int32Array(state), 0)).toBe(2);
    },
  );

  it("fails initialization when a worker exits before the handshake", async () => {
    const initializationTimeoutMs = 2_000;
    const renderer = new ManagedLatexRenderer({
      concurrency: 1,
      initializationTimeoutMs,
      // An empty module runs to completion and exits, so `exit` is the only event ever emitted.
      workerFactory: () => new Worker("void 0;", { eval: true }),
    });
    renderers.push(renderer);

    const startedAt = performance.now();
    await expect(renderer.render({ tex: "x" }, new LatexRenderBudget())).rejects.toMatchObject({
      code: "worker_failed",
    });

    // The exit listener settles the handshake. Waiting for the unreferenced init timer instead
    // would take the full timeout, and in a one-shot host would not settle at all.
    expect(performance.now() - startedAt).toBeLessThan(initializationTimeoutMs);
  });

  it("rejects an in-flight job when the renderer is closed", async () => {
    const renderer = new ManagedLatexRenderer({
      concurrency: 1,
      renderTimeoutMs: 1_000,
      workerFactory: () =>
        // This worker accepts the request and never answers, so only `close` can settle the job.
        new Worker(new URL("./fixture-worker.mjs", import.meta.url), {
          workerData: { first: "timeout", state: new SharedArrayBuffer(4) },
        }),
    });
    renderers.push(renderer);

    const pending = renderer.render({ tex: "x" }, new LatexRenderBudget());
    const outcome = expect(pending).rejects.toMatchObject({ code: "cancelled" });
    await renderer.close();

    await outcome;
  });

  it("keeps the slot usable when a replacement worker cannot be spawned", async () => {
    let calls = 0;
    const renderer = new ManagedLatexRenderer({
      concurrency: 1,
      renderTimeoutMs: 250,
      workerFactory: () => {
        calls += 1;
        // The first worker warms normally and then poisons itself; every replacement fails to spawn.
        if (calls > 1) throw new Error("synthetic spawn failure");
        return new Worker(new URL("./fixture-worker.mjs", import.meta.url), {
          workerData: { first: "crash", state: new SharedArrayBuffer(4) },
        });
      },
    });
    renderers.push(renderer);
    const budget = new LatexRenderBudget();

    await expect(renderer.render({ tex: "x" }, budget)).rejects.toMatchObject({
      code: "worker_failed",
    });
    // A spawn failure inside the replacement path must not leave the slot wedged busy. If it did,
    // this second render would never be dispatched and would hang instead of rejecting.
    await expect(renderer.render({ tex: "x" }, budget)).rejects.toMatchObject({
      code: "worker_failed",
    });
    expect(calls).toBeGreaterThan(1);
  });

  it("stops re-warming a slot after the retry cap and fails its jobs deterministically", async () => {
    let calls = 0;
    const renderer = new ManagedLatexRenderer({
      concurrency: 1,
      renderTimeoutMs: 250,
      workerFactory: () => {
        calls += 1;
        if (calls > 1) throw new Error("synthetic spawn failure");
        return new Worker(new URL("./fixture-worker.mjs", import.meta.url), {
          workerData: { first: "crash", state: new SharedArrayBuffer(4) },
        });
      },
    });
    renderers.push(renderer);
    const budget = new LatexRenderBudget();

    for (let index = 0; index < 8; index += 1) {
      await expect(renderer.render({ tex: "x" }, budget)).rejects.toMatchObject({
        code: "worker_failed",
      });
    }

    // One successful warm-up plus exactly `maximumWarmRetries` failed retries. The slot then stops
    // spawning and only fails the jobs addressed to it.
    expect(calls).toBe(1 + latexSvgRendererLimits.maximumWarmRetries);
  });

  it("does not spawn a replacement when the renderer closes during termination", async () => {
    const created: Worker[] = [];
    let releaseTerminate!: () => void;
    const terminateGate = new Promise<void>((resolve) => {
      releaseTerminate = resolve;
    });
    const renderer = new ManagedLatexRenderer({
      concurrency: 1,
      renderTimeoutMs: 250,
      workerFactory: () => {
        const worker = new Worker(new URL("./fixture-worker.mjs", import.meta.url), {
          workerData: {
            // Only the first worker poisons itself; a replacement would idle until terminated.
            first: created.length === 0 ? "crash" : "none",
            state: new SharedArrayBuffer(4),
          },
        });
        if (created.length === 0) {
          // Holds the replacement path open at its single await, which is the only point where
          // `close` can interleave, so the closed re-check is exercised deterministically.
          const originalTerminate = worker.terminate.bind(worker);
          worker.terminate = async () => {
            await terminateGate;
            return originalTerminate();
          };
        }
        created.push(worker);
        return worker;
      },
    });
    renderers.push(renderer);

    await expect(renderer.render({ tex: "x" }, new LatexRenderBudget())).rejects.toMatchObject({
      code: "worker_failed",
    });
    const closing = renderer.close();
    releaseTerminate();
    await closing;

    // The slot observed the close and never warmed another worker, so no thread outlives the pool.
    expect(created.length).toBe(1);
    await Promise.all(created.map((worker) => waitForExit(worker)));
  });

  it("honors queued and active cancellation and replaces the active worker", async () => {
    const state = new SharedArrayBuffer(4);
    const renderer = new ManagedLatexRenderer({
      concurrency: 1,
      renderTimeoutMs: 250,
      workerFactory: () =>
        new Worker(new URL("./fixture-worker.mjs", import.meta.url), {
          workerData: { first: "timeout", state },
        }),
    });
    renderers.push(renderer);
    const active = new AbortController();
    const queued = new AbortController();
    const budget = new LatexRenderBudget();
    const first = renderer.render({ tex: "first" }, budget, active.signal);
    const second = renderer.render({ tex: "second" }, budget, queued.signal);
    const firstOutcome = expect(first).rejects.toMatchObject({ code: "cancelled" });
    const secondOutcome = expect(second).rejects.toMatchObject({ code: "cancelled" });
    queued.abort();
    active.abort();

    await firstOutcome;
    await secondOutcome;
    await expect(renderer.render({ tex: "after cancellation" }, budget)).resolves.toMatchObject({
      tex: "after cancellation",
    });
  });
});
