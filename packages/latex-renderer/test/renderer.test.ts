import { afterEach, describe, expect, it } from "vitest";
import { Worker, type WorkerOptions } from "node:worker_threads";
import { renderTexToValidatedSvgInWorker } from "../src/core.js";
import {
  getManagedLatexRenderer,
  LatexRenderBudget,
  latexSvgRendererLimits,
  ManagedLatexRenderer,
  ManagedLatexRenderError,
  renderTexToPng,
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
  const typesetFixtures = [
    [
      "aligned multi-line equation",
      String.raw`\begin{aligned}
        a &= b + c \\
        d &= e - f
      \end{aligned}`,
    ],
    ["cases", String.raw`\begin{cases}x^2 & x > 0 \\ 0 & x \le 0\end{cases}`],
    ["matrix", String.raw`\begin{pmatrix}a & b \\ c & d\end{pmatrix}`],
    ["operatorname", String.raw`\operatorname{rank}(A) = n`],
    ["sum with bounds", String.raw`\sum_{\pi\in C_t} \operatorname{sgn}(\pi)\varphi^\lambda_\pi`],
    ["quadratic", `2x^{2}-4x-6=0`],
    ["fraction and square root", String.raw`x=\frac{-(-4)\pm\sqrt{64}}{2(2)}`],
    ["quadratic roots", String.raw`x=\frac{12}{4}=3\quad\text{or}\quad x=\frac{-4}{4}=-1`],
  ] as const;

  it.each(typesetFixtures)("produces actual bounded typeset pixels for %s", async (_label, tex) => {
    const svg = await renderTexToSvg({ tex });
    expect(svg.svg).toContain("<path");
    expect(svg.svg).not.toMatch(/data-mjx-error|<text\b/iu);

    const image = await renderTexToPng({ tex });
    expect(image.width).toBeGreaterThan(1);
    expect(image.height).toBeGreaterThan(1);
    // Natural 2x raster scale: no expression is stretched to the former fixed 1200px width.
    expect(image.width).toBeLessThan(1200);
    expect(image.pixels.byteLength).toBe(image.width * image.height * 4);
    expect(image.png.byteLength).toBeGreaterThan(0);
  });

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

  /**
   * Rasterization must not depend on host font state.
   *
   * The worker previously rasterized with resvg's system-font loading left enabled, which made PNG
   * rendering perform host-font enumeration. That is unbounded work charged to the per-render
   * timeout, and on a font-heavy host it pushed the first render past the ceiling, so the CLI fell
   * back to exact LaTeX and only the macOS CI job saw missing graphics.
   *
   * The invariant asserted here is behavioral rather than timing-based: a PNG is produced only from
   * an SVG that no font can influence. That is what makes disabling system fonts lossless, and it is
   * the property that would break if font-backed content were ever rasterized instead of refused.
   */
  it("rasterizes only from an SVG that no font can influence", async () => {
    const result = await getManagedLatexRenderer().render(
      { tex: "E = mc^2", display: true },
      new LatexRenderBudget(),
      undefined,
      "png",
    );

    expect(result.svg).toContain("<path");
    expect(result.svg).not.toMatch(/<text\b/iu);
    expect(result.svg).not.toMatch(/font-family/iu);
    expect(result.png?.byteLength).toBeGreaterThan(0);
    expect(result.width).toBeGreaterThan(0);
    expect(result.height).toBeGreaterThan(0);
  });

  it("returns opaque white RGBA pixels with visible dark formula glyphs", async () => {
    const result = await renderTexToPng({ tex: String.raw`\frac{-b\pm\sqrt{b^2-4ac}}{2a}` });
    let hasWhite = false;
    let hasDarkInk = false;
    for (let index = 0; index < result.pixels.length; index += 4) {
      const red = result.pixels[index];
      const green = result.pixels[index + 1];
      const blue = result.pixels[index + 2];
      const alpha = result.pixels[index + 3];
      expect(alpha).toBe(255);
      if (red === 255 && green === 255 && blue === 255) hasWhite = true;
      if (red < 100 && green < 100 && blue < 100) hasDarkInk = true;
    }
    expect(hasWhite).toBe(true);
    expect(hasDarkInk).toBe(true);
  });

  it("keeps a deterministic opaque-white margin around the rasterized ink", async () => {
    const result = await renderTexToPng({ tex: `x^2` });
    expect(result.width).toBeGreaterThan(8);
    expect(result.height).toBeGreaterThan(8);

    const edgePixels: number[] = [];
    for (let x = 0; x < result.width; x += 1) {
      edgePixels.push(x, 0, x, result.height - 1);
    }
    for (let y = 1; y < result.height - 1; y += 1) {
      edgePixels.push(0, y, result.width - 1, y);
    }
    for (let index = 0; index < edgePixels.length; index += 2) {
      const x = edgePixels[index];
      const y = edgePixels[index + 1];
      const pixel = (y * result.width + x) * 4;
      expect(Array.from(result.pixels.slice(pixel, pixel + 4))).toEqual([255, 255, 255, 255]);
    }
  });

  it("preserves the input ceiling before entering the padded raster path", async () => {
    await expect(
      renderTexToPng({ tex: "x".repeat(latexSvgRendererLimits.maximumInputBytes + 1) }),
    ).rejects.toMatchObject({ code: "input_limit" });
  });

  /**
   * The refusal must key on parsed markup, not on the serialized string.
   *
   * Every MathJax element carries a `data-latex` attribute that echoes the caller's TeX verbatim,
   * so an expression whose *source* contains `font-family` puts those exact bytes into output that
   * is still pure `<path>` geometry. A substring test over the serialization cannot tell that from a
   * real glyph run and refuses valid math, which is a silent loss of graphics for ordinary input.
   *
   * Each case below was confirmed against this MathJax configuration to serialize with the literal
   * bytes `font-family` present while parsing to zero `<text>` elements and zero real `font-family`
   * attributes or declarations. The last case additionally contains `font-family:` — declaration
   * shaped — inside a `data-latex` value, which is the exact string a naive `style` scan would trip
   * on. All of them must rasterize.
   */
  it.each([
    ["a subscript whose source echoes the property name", "x_{font-family}"],
    ["a fraction whose source echoes the property name", "\\frac{font-family}{2}"],
    ["a source containing a declaration-shaped `font-family:`", "\\mbox{font-family: serif}"],
  ])("rasterizes %s because it is structurally path-only", async (_label, tex) => {
    // The serialization really does carry the bytes the old string test matched on, so this case
    // is only passing because the decision is structural.
    const svgResult = await renderTexToSvg({ tex });
    expect(svgResult.svg).toMatch(/font-family/iu);
    // ...while containing no glyph run at all: no `<text>` element and no real attribute.
    expect(svgResult.svg).not.toMatch(/<text\b/iu);
    expect(svgResult.svg).not.toMatch(/font-family\s*=/iu);
    expect(svgResult.svg).toContain("<path");

    const png = await renderTexToPng({ tex });
    expect(png.png.byteLength).toBeGreaterThan(0);
    expect(png.width).toBeGreaterThan(0);
    expect(png.height).toBeGreaterThan(0);
  });

  /**
   * MathJax does not always emit path-only geometry. Anything outside its bundled math font, and
   * every `merror` marker, becomes a `<text>` run backed by a real font: CJK and emoji carry a
   * `font-family` attribute on the `<text>` element itself, and a `merror` marker carries a
   * `style="font-family: serif;"` declaration on the wrapping `<mtext>` group. Rasterizing that
   * with host fonts disabled drops the glyphs, and rasterizing it with host fonts enabled makes the
   * image depend on host font state. ADR 0006 permits neither, so PNG rendering fails closed and
   * the caller presents exact source.
   *
   * The CJK and emoji cases were confirmed to rasterize to a different, smaller PNG with system
   * fonts disabled, which is the silent glyph loss this refusal prevents.
   */
  it.each([
    ["CJK outside the math font", "x = 中文"],
    ["an emoji symbol", "x = 😀"],
    ["a MathJax error marker for invalid TeX", "\\frac{1}"],
    ["a MathJax error marker for an undefined macro", "\\notarealmacro{x}"],
  ])("refuses to rasterize %s instead of returning an incomplete image", async (_label, tex) => {
    // The SVG path still succeeds: only rasterization is refused, so nothing else regresses.
    const svgResult = await renderTexToSvg({ tex });
    // A real glyph run, proven structurally: an actual `<text>` element is present.
    expect(svgResult.svg).toMatch(/<text\b/iu);

    await expect(renderTexToPng({ tex })).rejects.toMatchObject({ code: "render_failed" });
  });

  it.each([
    ["require package loading", String.raw`\require{html}x`],
    ["HTML macro", String.raw`\htmlClass{evil}{x}`],
    ["URL macro", String.raw`\url{https://example.invalid}`],
    ["undefined macro", String.raw`\notarealmacro{x}`],
  ])("fails closed for %s instead of rasterizing unsafe input", async (_label, tex) => {
    await expect(renderTexToPng({ tex })).rejects.toMatchObject({ code: "render_failed" });
  });

  it("keeps a font-backed refusal from poisoning later renders on the same pool", async () => {
    const budget = new LatexRenderBudget();

    await expect(renderTexToPng({ tex: "x = 中文" }, { budget })).rejects.toMatchObject({
      code: "render_failed",
    });
    // A refusal is an ordinary in-contract render failure for the caller, so the very next PNG
    // still succeeds. The pool reaches that state by replacing the worker, not by keeping it.
    await expect(renderTexToPng({ tex: "E = mc^2" }, { budget })).resolves.toMatchObject({
      tex: "E = mc^2",
    });
  });

  /**
   * The pool's own reaction to a refusal, pinned explicitly.
   *
   * `ManagedLatexRenderer.#run` sets `replace = true` for every `type: "error"` response, so an
   * in-contract `render_failed` refusal discards and re-warms the worker exactly like a protocol
   * failure. That is pre-existing pool behavior which the refusal path inherits rather than changes,
   * and it is asserted here because this file previously documented the opposite.
   */
  it("replaces the worker after a refusal even though the caller sees a render failure", async () => {
    const created: Worker[] = [];
    const renderer = new ManagedLatexRenderer({
      concurrency: 1,
      workerFactory: () => {
        // The real packaged worker, so this exercises the production refusal path end to end.
        const worker = new Worker(new URL("../dist/worker.js", import.meta.url), { execArgv: [] });
        created.push(worker);
        return worker;
      },
    });
    renderers.push(renderer);
    const budget = new LatexRenderBudget();

    await expect(
      renderer.render({ tex: "E = mc^2" }, budget, undefined, "png"),
    ).resolves.toMatchObject({ tex: "E = mc^2" });
    const beforeRefusal = created.length;

    await expect(
      renderer.render({ tex: "x = 中文" }, budget, undefined, "png"),
    ).rejects.toMatchObject({ code: "render_failed" });

    // The replacement serves the next job normally, which is the property that actually matters.
    await expect(
      renderer.render({ tex: "E = mc^2" }, budget, undefined, "png"),
    ).resolves.toMatchObject({ tex: "E = mc^2" });

    // The refused worker was discarded and a replacement warmed in its place. This is asserted
    // after the following render rather than immediately: `#run` rejects the caller before
    // `#replace` awaits `terminate()` and spawns, so checking straight after the rejection races
    // that window. The next successful render is the point where the replacement provably exists.
    expect(created.length).toBe(beforeRefusal + 1);
    // ...and the original worker really was retired, not merely supplemented.
    const [retired] = created;
    expect(retired).toBeDefined();
    await waitForExit(retired as Worker);
  });

  it("reports a refusal with a redacted message that leaks no TeX or host detail", async () => {
    const tex = "\\notarealmacro{secret-marker}";

    const error = await renderTexToPng({ tex }).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(ManagedLatexRenderError);
    const message = (error as ManagedLatexRenderError).message;
    expect(message).toBe("The isolated LaTeX renderer could not render the expression.");
    expect(message).not.toContain("secret-marker");
    expect(message).not.toMatch(/font|resvg|mathjax|[/\\]/iu);
  });

  /**
   * The structural metadata itself, read straight off the validator, with no worker or rasterizer in
   * the way. This is the decision input the PNG path branches on, so it is asserted directly: the
   * table above proves the outcome, this proves the reason.
   */
  it.each([
    ["x_{font-family}", false, false],
    ["\\frac{font-family}{2}", false, false],
    ["\\mbox{font-family: serif}", false, false],
    ["\\text{font-family:}", false, false],
    ["E = mc^2", false, false],
    ["x = 中文", true, true],
    ["x = 😀", true, true],
    // A `merror` marker has no `font-family` attribute; it carries a real CSS declaration in a
    // real `style` attribute, so the declaration parser is what has to catch it.
    ["\\frac{1}", true, true],
    ["\\notarealmacro{x}", true, true],
  ])(
    "reports structural text/font facts for %j as text=%s font-family=%s",
    (tex, hasTextElement, hasFontFamily) => {
      const { result, structure } = renderTexToValidatedSvgInWorker({ tex });

      expect(structure).toEqual({ hasTextElement, hasFontFamily });
      // The public result shape is unchanged and carries no extra field.
      expect(Object.keys(result).sort()).toEqual(["display", "renderer", "svg", "tex"]);
      expect(result.tex).toBe(tex);
    },
  );

  it("does not treat an echoed TeX source string as a font-family declaration", () => {
    const echoed = renderTexToValidatedSvgInWorker({ tex: "\\mbox{font-family: serif}" });
    const real = renderTexToValidatedSvgInWorker({ tex: "\\frac{1}" });

    // Both serializations contain the substring `font-family:`, and only one is a real declaration.
    expect(echoed.result.svg).toContain("font-family:");
    expect(real.result.svg).toContain("font-family:");
    expect(echoed.structure.hasFontFamily).toBe(false);
    expect(real.structure.hasFontFamily).toBe(true);
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
