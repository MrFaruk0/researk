import { describe, expect, it, vi } from "vitest";
import {
  createFormulaRasterCache,
  FormulaRasterCache,
  type FormulaRasterCacheStore,
  type FormulaRasterRenderer,
  type FormulaRasterRequest,
  type FormulaRenderStyle,
} from "../src/tui/formula-renderer.js";

function request(tex: string, display = true): FormulaRasterRequest {
  return { display, tex };
}

function raster(width = 1, height = 1, pngBytes = 2) {
  return {
    height,
    pixels: new Uint8Array(width * height * 4),
    png: new Uint8Array(pngBytes),
    width,
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  reject: (reason?: unknown) => void;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

describe("FormulaRasterCache", () => {
  it("hits the cache and coalesces identical in-flight requests", async () => {
    const pending = deferred<ReturnType<typeof raster>>();
    const renderer = vi.fn<FormulaRasterRenderer>(() => pending.promise);
    const cache = createFormulaRasterCache(renderer);

    const first = cache.render(request("x^2"));
    const second = cache.render(request("x^2"));
    expect(renderer).toHaveBeenCalledTimes(1);
    pending.resolve(raster());

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.ok).toBe(true);
    expect(secondResult.ok).toBe(true);
    expect(cache.getStats()).toMatchObject({ coalesced: 1, entries: 1, hits: 0 });

    const cached = await cache.render(request("x^2"));
    expect(cached.ok).toBe(true);
    expect(renderer).toHaveBeenCalledTimes(1);
    expect(cache.getStats()).toMatchObject({ entries: 1, hits: 1 });
  });

  it("separates exact TeX and inline/display keys", async () => {
    const renderer = vi.fn<FormulaRasterRenderer>(async () => raster());
    const cache = new FormulaRasterCache(renderer);

    await cache.render(request("x", true));
    await cache.render(request("x", false));
    await cache.render(request(" x", true));

    expect(renderer).toHaveBeenCalledTimes(3);
    expect(cache.getStats().entries).toBe(3);
  });

  it("includes every pixel-affecting style and renderer version in the key", async () => {
    const renderer = vi.fn<FormulaRasterRenderer>(async () => raster());
    const cache = new FormulaRasterCache(renderer);
    const base = {
      background: "#101010",
      dpi: 144,
      fontScale: 1.25,
      foreground: "#f0f0f0",
      rendererVersion: "math-pipeline-1",
    } as const;

    await cache.render({ display: true, style: base, tex: "\\frac{a}{b}" });
    await cache.render({ display: true, style: { ...base }, tex: "\\frac{a}{b}" });
    await cache.render({
      display: true,
      style: { ...base, background: "#202020" },
      tex: "\\frac{a}{b}",
    });
    await cache.render({
      display: true,
      style: { ...base, dpi: 150 },
      tex: "\\frac{a}{b}",
    });
    await cache.render({
      display: true,
      style: { ...base, fontScale: 1.5 },
      tex: "\\frac{a}{b}",
    });
    await cache.render({
      display: true,
      style: { ...base, foreground: "#ffffff" },
      tex: "\\frac{a}{b}",
    });
    await cache.render({
      display: true,
      style: { ...base, rendererVersion: "math-pipeline-2" },
      tex: "\\frac{a}{b}",
    });

    expect(renderer).toHaveBeenCalledTimes(6);
  });

  it("rejects unknown style fields before invoking an injected renderer", async () => {
    const renderer = vi.fn<FormulaRasterRenderer>(async () => raster());
    const cache = new FormulaRasterCache(renderer);
    await expect(
      cache.render({
        display: true,
        style: { foreground: "#fff", unsafe: "value" } as FormulaRenderStyle,
        tex: "x",
      }),
    ).resolves.toEqual({ ok: false, reason: "invalid_request" });
    expect(renderer).not.toHaveBeenCalled();
  });

  it("loads a successful raster from an injected persistent store", async () => {
    const stored = new Map<string, ReturnType<typeof raster>>();
    const persistentStore: FormulaRasterCacheStore = {
      delete: async (key) => {
        stored.delete(key);
      },
      get: async (key) => stored.get(key),
      set: async (key, value) => {
        stored.set(key, value);
      },
    };
    const firstRenderer = vi.fn<FormulaRasterRenderer>(async () => raster());
    const first = new FormulaRasterCache(firstRenderer, { persistentStore });
    await first.render({ display: true, tex: "x+y" });
    expect(firstRenderer).toHaveBeenCalledTimes(1);

    const secondRenderer = vi.fn<FormulaRasterRenderer>(async () => raster());
    const second = new FormulaRasterCache(secondRenderer, { persistentStore });
    await expect(second.render({ display: true, tex: "x+y" })).resolves.toMatchObject({ ok: true });
    expect(secondRenderer).not.toHaveBeenCalled();
  });

  it("evicts least-recently-used entries by count and total PNG+RGBA bytes", async () => {
    let calls = 0;
    const renderer = vi.fn<FormulaRasterRenderer>(async () => {
      calls += 1;
      return raster(1, 1, 2);
    });
    const cache = new FormulaRasterCache(renderer, { maxEntries: 2, maxBytes: 12 });

    await cache.render(request("a"));
    await cache.render(request("b"));
    await cache.render(request("a")); // Promote a before c arrives.
    await cache.render(request("c")); // c costs six bytes, evict b first.
    await cache.render(request("b"));

    expect(calls).toBe(4);
    expect(cache.getStats()).toMatchObject({ bytes: 12, entries: 2 });

    const byteLimited = new FormulaRasterCache(
      vi.fn<FormulaRasterRenderer>(async () => raster(1, 1, 9)),
      { maxEntries: 4, maxBytes: 12 },
    );
    const oversized = await byteLimited.render(request("too-large"));
    expect(oversized).toEqual({ ok: false, reason: "budget_exceeded" });
    expect(byteLimited.getStats().entries).toBe(0);
  });

  it.each([
    undefined,
    {},
    { png: new Uint8Array(1), pixels: new Uint8Array(4), width: 0, height: 1 },
    { png: new Uint8Array(1), pixels: new Uint8Array(3), width: 1, height: 1 },
    { png: new Uint8Array(1), pixels: new Uint8Array(4), width: 1.5, height: 1 },
    { png: new Uint8Array(1), pixels: new Uint8Array(4), width: 1, height: 1.5 },
    { png: new Uint8Array(0), pixels: new Uint8Array(4), width: 1, height: 1 },
  ])("rejects malformed raster fields (%j)", async (result) => {
    const renderer = vi.fn<FormulaRasterRenderer>(async () => result);
    const cache = new FormulaRasterCache(renderer);

    await expect(cache.render(request("bad"))).resolves.toEqual({
      ok: false,
      reason: "malformed_result",
    });
    expect(cache.getStats().entries).toBe(0);
  });

  it("rejects non-Uint8Array values and exact RGBA length mismatches", async () => {
    const renderer = vi
      .fn<FormulaRasterRenderer>()
      .mockResolvedValueOnce({ png: [1], pixels: new Uint8Array(4), width: 1, height: 1 })
      .mockResolvedValueOnce({
        png: new Uint8Array(1),
        pixels: new Uint8Array(8),
        width: 1,
        height: 1,
      });
    const cache = new FormulaRasterCache(renderer);

    await expect(cache.render(request("array"))).resolves.toEqual({
      ok: false,
      reason: "malformed_result",
    });
    await expect(cache.render(request("length"))).resolves.toEqual({
      ok: false,
      reason: "malformed_result",
    });
  });

  it("turns renderer throws and budget rejections into stable failures", async () => {
    const renderer = vi
      .fn<FormulaRasterRenderer>()
      .mockRejectedValueOnce(new Error("native renderer failed"))
      .mockRejectedValueOnce(Object.assign(new Error("budget"), { code: "expression_limit" }));
    const cache = new FormulaRasterCache(renderer);

    await expect(cache.render(request("throw"))).resolves.toEqual({
      ok: false,
      reason: "renderer_failed",
    });
    await expect(cache.render(request("budget"))).resolves.toEqual({
      ok: false,
      reason: "budget_exceeded",
    });
    expect(cache.getStats().entries).toBe(0);
  });

  it("aborts one caller without cancelling an active coalesced caller", async () => {
    const pending = deferred<ReturnType<typeof raster>>();
    const renderer = vi.fn<FormulaRasterRenderer>((_request, options) => {
      expect(options.signal?.aborted).toBe(false);
      return pending.promise;
    });
    const cache = new FormulaRasterCache(renderer);
    const firstController = new AbortController();
    const first = cache.render(request("x"), { signal: firstController.signal });
    const second = cache.render(request("x"));

    firstController.abort();
    await expect(first).resolves.toEqual({ ok: false, reason: "aborted" });
    expect(renderer).toHaveBeenCalledTimes(1);
    pending.resolve(raster());
    await expect(second).resolves.toMatchObject({ ok: true });
    await expect(cache.render(request("x"))).resolves.toMatchObject({ ok: true });
    expect(renderer).toHaveBeenCalledTimes(1);
  });

  it("does not retain a failed or all-aborted operation", async () => {
    const firstPending = deferred<ReturnType<typeof raster>>();
    const secondPending = deferred<ReturnType<typeof raster>>();
    const renderer = vi
      .fn<FormulaRasterRenderer>()
      .mockReturnValueOnce(firstPending.promise)
      .mockReturnValueOnce(secondPending.promise);
    const cache = new FormulaRasterCache(renderer);
    const controller = new AbortController();
    const first = cache.render(request("same"), { signal: controller.signal });
    controller.abort();
    await expect(first).resolves.toEqual({ ok: false, reason: "aborted" });

    const retry = cache.render(request("same"));
    expect(renderer).toHaveBeenCalledTimes(2);
    secondPending.resolve(raster());
    await expect(retry).resolves.toMatchObject({ ok: true });
    firstPending.resolve(raster());
    await expect(cache.render(request("same"))).resolves.toMatchObject({ ok: true });
    expect(renderer).toHaveBeenCalledTimes(2);
  });

  it("clear cancels in-flight work and removes all successful entries", async () => {
    const pending = deferred<ReturnType<typeof raster>>();
    const renderer = vi.fn<FormulaRasterRenderer>(() => pending.promise);
    const cache = new FormulaRasterCache(renderer);
    const inFlight = cache.render(request("x"));
    cache.clear();

    await expect(inFlight).resolves.toEqual({ ok: false, reason: "aborted" });
    expect(cache.getStats()).toMatchObject({ bytes: 0, entries: 0, inFlight: 0 });
    pending.resolve(raster());
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(cache.getStats()).toMatchObject({ bytes: 0, entries: 0, inFlight: 0 });
  });
});
