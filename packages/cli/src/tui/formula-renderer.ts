import type { LatexRenderBudget } from "@researk/latex-renderer";

/**
 * A deliberately small raster contract. The renderer may return a richer
 * `LatexPngRenderResult`; only these four fields cross the cache boundary.
 */
export interface FormulaRaster {
  readonly height: number;
  readonly pixels: Uint8Array;
  readonly png: Uint8Array;
  readonly width: number;
}

export interface FormulaRasterRequest {
  readonly display: boolean;
  readonly tex: string;
}

export interface FormulaRasterRenderOptions {
  readonly budget?: LatexRenderBudget;
  readonly signal?: AbortSignal;
}

/** The seam keeps cache tests independent of MathJax, workers, and native image bindings. */
export type FormulaRasterRenderer = (
  request: FormulaRasterRequest,
  options: FormulaRasterRenderOptions,
) => PromiseLike<unknown>;

export type FormulaRasterFailureCode =
  | "aborted"
  | "budget_exceeded"
  | "invalid_request"
  | "malformed_result"
  | "renderer_failed";

export interface FormulaRasterFailure {
  readonly ok: false;
  readonly reason: FormulaRasterFailureCode;
}

export interface FormulaRasterSuccess {
  readonly ok: true;
  readonly raster: FormulaRaster;
}

export type FormulaRasterOutcome = FormulaRasterFailure | FormulaRasterSuccess;

export const DEFAULT_FORMULA_RASTER_CACHE_MAX_ENTRIES = 32;
export const DEFAULT_FORMULA_RASTER_CACHE_MAX_BYTES = 64 * 1024 * 1024;

const MAX_CONFIGURED_ENTRIES = 256;
const MAX_CONFIGURED_BYTES = 256 * 1024 * 1024;
const MAX_PNG_BYTES = 8 * 1024 * 1024;
const MAX_RASTER_WIDTH = 4096;
const MAX_RASTER_HEIGHT = 2048;
const MAX_RASTER_AREA = 8_388_608;
const MAX_RGBA_BYTES = MAX_RASTER_AREA * 4;

export interface FormulaRasterCacheOptions {
  /** Maximum number of successful rasters retained. Defaults to 32. */
  readonly maxEntries?: number;
  /** Maximum sum of PNG and RGBA bytes retained. Defaults to 64 MiB. */
  readonly maxBytes?: number;
}

export interface FormulaRasterCacheStats {
  readonly bytes: number;
  readonly coalesced: number;
  readonly entries: number;
  readonly evictions: number;
  readonly failures: number;
  readonly hits: number;
  readonly inFlight: number;
  readonly misses: number;
}

interface CacheEntry {
  readonly bytes: number;
  readonly raster: FormulaRaster;
}

interface InFlight {
  readonly controller: AbortController;
  readonly key: string;
  readonly promise: Promise<FormulaRasterOutcome>;
  readonly cancellations: Set<() => void>;
  consumers: number;
  settled: boolean;
}

interface MutableStats {
  bytes: number;
  coalesced: number;
  evictions: number;
  failures: number;
  hits: number;
  misses: number;
}

/**
 * A bounded LRU for successful formula rasters.
 *
 * Each caller owns its abort outcome. Coalesced callers share only the renderer operation, and an
 * internal controller is aborted when the last caller leaves. Failed operations are never cached.
 */
export class FormulaRasterCache {
  readonly #maxBytes: number;
  readonly #maxEntries: number;
  readonly #renderer: FormulaRasterRenderer;
  readonly #cache = new Map<string, CacheEntry>();
  readonly #inFlight = new Map<string, InFlight>();
  readonly #stats: MutableStats = {
    bytes: 0,
    coalesced: 0,
    evictions: 0,
    failures: 0,
    hits: 0,
    misses: 0,
  };

  public constructor(renderer: FormulaRasterRenderer, options: FormulaRasterCacheOptions = {}) {
    this.#renderer = renderer;
    this.#maxEntries = boundedOption(
      options.maxEntries,
      DEFAULT_FORMULA_RASTER_CACHE_MAX_ENTRIES,
      MAX_CONFIGURED_ENTRIES,
    );
    this.#maxBytes = boundedOption(
      options.maxBytes,
      DEFAULT_FORMULA_RASTER_CACHE_MAX_BYTES,
      MAX_CONFIGURED_BYTES,
    );
  }

  /** Renders or retrieves one exact TeX/display-mode key without throwing. */
  public render(
    request: FormulaRasterRequest,
    options: FormulaRasterRenderOptions = {},
  ): Promise<FormulaRasterOutcome> {
    if (!isFormulaRasterRequest(request)) {
      this.#stats.failures += 1;
      return Promise.resolve({ ok: false, reason: "invalid_request" });
    }
    if (options.signal?.aborted === true) {
      this.#stats.failures += 1;
      return Promise.resolve({ ok: false, reason: "aborted" });
    }

    const key = formulaRasterKey(request);
    const cached = this.#cache.get(key);
    if (cached !== undefined) {
      this.#stats.hits += 1;
      this.#cache.delete(key);
      this.#cache.set(key, cached);
      return Promise.resolve({ ok: true, raster: cloneRaster(cached.raster) });
    }

    this.#stats.misses += 1;
    let pending = this.#inFlight.get(key);
    if (pending !== undefined) {
      this.#stats.coalesced += 1;
      return this.#subscribe(pending, options.signal);
    }

    const controller = new AbortController();
    const rendererOptions: FormulaRasterRenderOptions = {
      ...(options.budget === undefined ? {} : { budget: options.budget }),
      signal: controller.signal,
    };
    const promise = this.#renderAndCache(request, key, controller, rendererOptions);
    pending = {
      controller,
      key,
      promise,
      cancellations: new Set(),
      consumers: 0,
      settled: false,
    };
    this.#inFlight.set(key, pending);
    // The operation is total today, but retain a rejection handler so a future change cannot
    // create an unhandled rejection after all callers have aborted.
    void promise.then(
      () => this.#settlePending(pending),
      () => this.#settlePending(pending),
    );
    return this.#subscribe(pending, options.signal);
  }

  /** Removes successful entries and cancels any in-flight renderer work. */
  public clear(): void {
    for (const pending of this.#inFlight.values()) {
      pending.controller.abort();
      for (const cancel of [...pending.cancellations]) cancel();
    }
    this.#inFlight.clear();
    this.#cache.clear();
    this.#stats.bytes = 0;
  }

  public getStats(): FormulaRasterCacheStats {
    return {
      bytes: this.#stats.bytes,
      coalesced: this.#stats.coalesced,
      entries: this.#cache.size,
      evictions: this.#stats.evictions,
      failures: this.#stats.failures,
      hits: this.#stats.hits,
      inFlight: this.#inFlight.size,
      misses: this.#stats.misses,
    };
  }

  async #renderAndCache(
    request: FormulaRasterRequest,
    key: string,
    controller: AbortController,
    options: FormulaRasterRenderOptions,
  ): Promise<FormulaRasterOutcome> {
    try {
      const result = await this.#renderer(request, options);
      if (controller.signal.aborted) return this.#failure("aborted");

      let validated: FormulaRaster | FormulaRasterFailureCode;
      try {
        validated = validateRaster(result);
      } catch {
        return this.#failure("malformed_result");
      }
      if (typeof validated === "string") return this.#failure(validated);
      const raster = validated;

      const bytes = raster.png.byteLength + raster.pixels.byteLength;
      if (bytes > this.#maxBytes) return this.#failure("budget_exceeded");

      this.#insert(key, raster, bytes);
      return { ok: true, raster: cloneRaster(raster) };
    } catch (error: unknown) {
      return this.#failure(classifyRendererFailure(error, controller.signal));
    }
  }

  #subscribe(pending: InFlight, signal: AbortSignal | undefined): Promise<FormulaRasterOutcome> {
    pending.consumers += 1;
    return new Promise<FormulaRasterOutcome>((resolve) => {
      let done = false;
      let cancel!: () => void;

      const finish = (outcome: FormulaRasterOutcome): void => {
        if (done) return;
        done = true;
        pending.cancellations.delete(cancel);
        signal?.removeEventListener("abort", onAbort);
        pending.consumers = Math.max(0, pending.consumers - 1);
        if (signal?.aborted === true) {
          resolve(this.#failure("aborted"));
        } else {
          resolve(outcome.ok ? { ok: true, raster: cloneRaster(outcome.raster) } : outcome);
        }
      };
      cancel = (): void => {
        finish(this.#failure("aborted"));
        if (!pending.settled && pending.consumers === 0) {
          pending.controller.abort();
          if (this.#inFlight.get(pending.key) === pending) this.#inFlight.delete(pending.key);
        }
      };
      const onAbort = (): void => cancel();

      pending.cancellations.add(cancel);
      if (signal?.aborted === true) {
        cancel();
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      void pending.promise.then(finish, () => finish(this.#failure("renderer_failed")));
    });
  }

  #settlePending(pending: InFlight): void {
    pending.settled = true;
    if (this.#inFlight.get(pending.key) === pending) this.#inFlight.delete(pending.key);
  }

  #insert(key: string, raster: FormulaRaster, bytes: number): void {
    const previous = this.#cache.get(key);
    if (previous !== undefined) {
      this.#cache.delete(key);
      this.#stats.bytes -= previous.bytes;
    }

    while (this.#cache.size >= this.#maxEntries || this.#stats.bytes + bytes > this.#maxBytes) {
      const oldestKey = this.#cache.keys().next().value as string | undefined;
      if (oldestKey === undefined) break;
      const oldest = this.#cache.get(oldestKey);
      this.#cache.delete(oldestKey);
      if (oldest !== undefined) this.#stats.bytes -= oldest.bytes;
      this.#stats.evictions += 1;
    }

    this.#cache.set(key, { bytes, raster: cloneRaster(raster) });
    this.#stats.bytes += bytes;
  }

  #failure(reason: FormulaRasterFailureCode): FormulaRasterFailure {
    this.#stats.failures += 1;
    return { ok: false, reason };
  }
}

export function createFormulaRasterCache(
  renderer: FormulaRasterRenderer,
  options: FormulaRasterCacheOptions = {},
): FormulaRasterCache {
  return new FormulaRasterCache(renderer, options);
}

function boundedOption(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(1, Math.trunc(value)));
}

function isFormulaRasterRequest(value: unknown): value is FormulaRasterRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.tex === "string" && typeof record.display === "boolean";
}

function formulaRasterKey(request: FormulaRasterRequest): string {
  // The mode prefix makes the two modes disjoint without normalizing or escaping TeX at all.
  return `${request.display ? "\\u0001" : "\\u0000"}${request.tex}`;
}

function validateRaster(value: unknown): FormulaRaster | FormulaRasterFailureCode {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "malformed_result";
  }
  const record = value as Record<string, unknown>;
  const png = record.png;
  const pixels = record.pixels;
  const width = record.width;
  const height = record.height;
  if (!isPrivateUint8Array(png) || png.byteLength < 1) return "malformed_result";
  if (png.byteLength > MAX_PNG_BYTES) return "budget_exceeded";
  if (!isPrivateUint8Array(pixels)) return "malformed_result";
  if (pixels.byteLength > MAX_RGBA_BYTES) return "budget_exceeded";
  if (!isPositiveBoundedInteger(width, Number.MAX_SAFE_INTEGER)) return "malformed_result";
  if (!isPositiveBoundedInteger(height, Number.MAX_SAFE_INTEGER)) return "malformed_result";
  if (width > MAX_RASTER_WIDTH || height > MAX_RASTER_HEIGHT) return "budget_exceeded";
  const expectedPixels = width * height * 4;
  if (expectedPixels > MAX_RGBA_BYTES) return "budget_exceeded";
  if (pixels.byteLength !== expectedPixels) return "malformed_result";

  return {
    height,
    pixels: new Uint8Array(pixels),
    png: new Uint8Array(png),
    width,
  };
}

function cloneRaster(raster: FormulaRaster): FormulaRaster {
  return {
    height: raster.height,
    pixels: new Uint8Array(raster.pixels),
    png: new Uint8Array(raster.png),
    width: raster.width,
  };
}

function isPrivateUint8Array(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array && value.buffer instanceof ArrayBuffer;
}

function isPositiveBoundedInteger(value: unknown, maximum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= maximum;
}

function classifyRendererFailure(error: unknown, signal: AbortSignal): FormulaRasterFailureCode {
  if (signal.aborted || isAbortError(error)) return "aborted";
  if (isBudgetError(error)) return "budget_exceeded";
  return "renderer_failed";
}

function isAbortError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const record = error as Record<string, unknown>;
  return record.name === "AbortError" || record.code === "cancelled" || record.code === "aborted";
}

function isBudgetError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as Record<string, unknown>).code;
  return (
    code === "budget" ||
    code === "budget_exceeded" ||
    code === "expression_limit" ||
    code === "output_limit" ||
    code === "render_time_limit"
  );
}
