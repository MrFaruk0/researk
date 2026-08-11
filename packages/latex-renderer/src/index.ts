import { Buffer } from "node:buffer";
import { Worker } from "node:worker_threads";
import {
  latexSvgRendererLimits as coreLimits,
  LatexSvgRenderError,
  type LatexSvgRenderErrorCode,
  type LatexSvgRenderRequest,
  type LatexSvgRenderResult,
} from "./core.js";
import {
  isWorkerReadyMessage,
  maximumRequestId,
  parseWorkerResponse,
  type WorkerErrorCode,
  type WorkerRenderRequest,
} from "./protocol.js";
import {
  type LatexRenderStyle,
  type NormalizedLatexRenderStyle,
  normalizeLatexRenderStyle,
} from "./style.js";

const maximumExpressionsPerResponse = 256;
const maximumCumulativeRenderMs = 5_000;
const maximumConcurrentJobs = 2;
const renderTimeoutMs = 1_000;
const initializationTimeoutMs = 5_000;

/**
 * A slot re-warms itself after a failure, but a slot that cannot start a worker at all must not
 * spawn forever. After this many consecutive failed warm-ups the slot stops retrying on its own and
 * only fails the jobs actually addressed to it.
 */
const maximumWarmRetries = 3;

export type {
  LatexSvgRenderErrorCode,
  LatexSvgRenderRequest,
  LatexSvgRenderResult,
} from "./core.js";
export { LatexSvgRenderError } from "./core.js";
export { latexRendererVersion, rendererIdentity, rendererVersion } from "./protocol.js";
export type {
  FormulaRenderStyle,
  LatexRenderStyle,
  NormalizedLatexRenderStyle,
} from "./style.js";
export { latexRenderStyleLimits, normalizeLatexColor, normalizeLatexRenderStyle } from "./style.js";

export const latexSvgRendererLimits = Object.freeze({
  ...coreLimits,
  initializationTimeoutMs,
  maximumConcurrentJobs,
  maximumCumulativeRenderMs,
  maximumExpressionsPerResponse,
  maximumWarmRetries,
  renderTimeoutMs,
  workerMemoryMiB: 128,
});

export type ManagedLatexRenderErrorCode =
  | LatexSvgRenderErrorCode
  | "cancelled"
  | "expression_limit"
  | "render_time_limit"
  | "timeout"
  | "worker_failed";

export class ManagedLatexRenderError extends Error {
  constructor(
    public readonly code: ManagedLatexRenderErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ManagedLatexRenderError";
  }
}

/** Per-response accounting. Create exactly one for each canonical assistant response. */
export class LatexRenderBudget {
  #expressions = 0;
  #renderTimeMs = 0;

  claim(): void {
    this.#expressions += 1;
    if (this.#expressions > maximumExpressionsPerResponse) {
      throw new ManagedLatexRenderError(
        "expression_limit",
        "The response math-expression limit was reached.",
      );
    }
    if (this.#renderTimeMs >= maximumCumulativeRenderMs) {
      throw new ManagedLatexRenderError(
        "render_time_limit",
        "The response render-time limit was reached.",
      );
    }
  }

  record(milliseconds: number): void {
    this.#renderTimeMs += Math.max(0, milliseconds);
  }

  get expressions(): number {
    return this.#expressions;
  }

  get renderTimeMs(): number {
    return this.#renderTimeMs;
  }
}

export interface LatexRenderOptions {
  readonly budget?: LatexRenderBudget;
  readonly signal?: AbortSignal;
  /** Optional convenience form; an explicit request.style takes precedence. */
  readonly style?: LatexRenderStyle;
}

export interface ManagedLatexRendererOptions {
  /** Primarily for protocol/failure tests; production always uses the packaged worker module. */
  readonly workerUrl?: URL;
  readonly concurrency?: number;
  readonly renderTimeoutMs?: number;
  readonly initializationTimeoutMs?: number;
  /** Test seam for deterministic worker crash/timeout protocol fixtures. */
  readonly workerFactory?: () => Worker;
}

interface Job {
  readonly request: LatexSvgRenderRequest;
  readonly format: "svg" | "png";
  readonly budget: LatexRenderBudget;
  readonly signal?: AbortSignal;
  readonly resolve: (result: LatexSvgRenderResult) => void;
  readonly reject: (error: Error) => void;
}

interface Slot {
  worker: Worker;
  ready: Promise<void>;
  busy: boolean;
  generation: number;
  /** Consecutive failed warm-ups for this slot. Reset by any worker that completes a handshake. */
  warmFailures: number;
  /** Set once `warmFailures` reaches the retry cap. A disabled slot never spawns another worker. */
  disabled: boolean;
}

/** A bounded, pre-warmed pool. A failed, cancelled, or timed-out worker is never reused. */
export class ManagedLatexRenderer {
  readonly #workerUrl: URL;
  readonly #concurrency: number;
  readonly #timeout: number;
  readonly #initializationTimeout: number;
  readonly #workerFactory: (() => Worker) | undefined;
  readonly #slots: Slot[] = [];
  readonly #queue: Job[] = [];
  /**
   * Jobs already handed to a slot. A terminated worker is not guaranteed to emit `exit` or `error`,
   * so `close` settles these explicitly rather than waiting for an event that may never arrive.
   */
  readonly #active = new Set<Job>();
  #nextId = 1;
  #closed = false;

  constructor(options: ManagedLatexRendererOptions = {}) {
    this.#workerUrl =
      options.workerUrl ??
      new URL(
        import.meta.url.includes("/src/") ? "../dist/worker.js" : "./worker.js",
        import.meta.url,
      );
    this.#concurrency = Math.max(
      1,
      Math.min(maximumConcurrentJobs, options.concurrency ?? maximumConcurrentJobs),
    );
    this.#timeout = Math.max(
      1,
      Math.min(renderTimeoutMs, options.renderTimeoutMs ?? renderTimeoutMs),
    );
    this.#initializationTimeout = Math.max(
      1,
      Math.min(initializationTimeoutMs, options.initializationTimeoutMs ?? initializationTimeoutMs),
    );
    this.#workerFactory = options.workerFactory;
    for (let index = 0; index < this.#concurrency; index += 1) this.#slots.push(this.#createSlot());
  }

  render(
    request: LatexSvgRenderRequest,
    budget: LatexRenderBudget,
    signal?: AbortSignal,
    format: "svg" | "png" = "svg",
  ): Promise<LatexSvgRenderResult> {
    if (this.#closed)
      return Promise.reject(new ManagedLatexRenderError("worker_failed", "Renderer is closed."));
    if (signal?.aborted === true) return Promise.reject(cancelledError());
    let normalizedRequest: LatexSvgRenderRequest;
    try {
      normalizedRequest = normalizePublicRequest(request);
    } catch (error) {
      return Promise.reject(
        new ManagedLatexRenderError("invalid_input", "LaTeX render request is invalid.", {
          cause: error instanceof Error ? error : undefined,
        }),
      );
    }
    // Enforce the byte ceiling before an untrusted payload is copied into worker messaging.
    if (Buffer.byteLength(normalizedRequest.tex, "utf8") > coreLimits.maximumInputBytes) {
      return Promise.reject(
        new ManagedLatexRenderError("input_limit", "TeX input exceeds the renderer limit."),
      );
    }
    try {
      budget.claim();
    } catch (error) {
      return Promise.reject(error);
    }
    return new Promise((resolve, reject) => {
      const job: Job = {
        request: normalizedRequest,
        format,
        budget,
        ...(signal === undefined ? {} : { signal }),
        resolve,
        reject,
      };
      this.#queue.push(job);
      const removeQueued = () => {
        const index = this.#queue.indexOf(job);
        if (index >= 0) {
          this.#queue.splice(index, 1);
          reject(cancelledError());
        }
      };
      signal?.addEventListener("abort", removeQueued, { once: true });
      this.#dispatch();
    });
  }

  async close(): Promise<void> {
    this.#closed = true;
    for (const job of this.#queue.splice(0)) job.reject(cancelledError());
    // An in-flight job is settled here rather than left to a termination event, so no caller is
    // left awaiting a promise that a terminated worker will never settle.
    for (const job of [...this.#active]) job.reject(cancelledError());
    await Promise.all(
      this.#slots.map(async (slot) => {
        slot.disabled = true;
        await slot.worker.terminate().catch(() => undefined);
      }),
    );
    // A replacement may have been created while the terminations above were awaited. The slot's
    // worker reference is authoritative at this point, so re-terminating it collects any late one.
    await Promise.all(
      this.#slots.map(async (slot) => void (await slot.worker.terminate().catch(() => undefined))),
    );
  }

  #createSlot(): Slot {
    const worker =
      this.#workerFactory?.() ??
      // `execArgv` is deliberately empty. Inheriting `process.execArgv` propagates host flags that
      // are invalid for a file-URL worker entry, most notably `--input-type=module`, which fails
      // worker construction with ERR_INPUT_TYPE_NOT_ALLOWED. The worker needs no host flags.
      new Worker(this.#workerUrl, {
        execArgv: [],
        resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16 },
      });
    // A renderer worker must never hold a one-shot CLI process open. The pool refs a worker only
    // while a job is actually in flight, and unrefs it again as soon as the slot goes idle.
    unref(worker);
    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    // An idle pool must not delay process exit, and an unobserved initialization failure must not
    // surface as an unhandled rejection that changes a one-shot exit code.
    void ready.catch(() => undefined);
    // Exactly one of these listeners decides the handshake. Whichever fires first releases the
    // timer and the other two, so a settled slot holds no timer and no listener on a dead worker.
    const settle = (error?: Error) => {
      clearTimeout(timer);
      worker.off("message", onMessage);
      worker.off("error", onError);
      worker.off("exit", onExit);
      if (error === undefined) resolveReady();
      else rejectReady(error);
    };
    const onMessage = (message: unknown) => {
      if (isWorkerReadyMessage(message)) {
        settle();
      } else {
        // A worker whose first message is not an exact ready handshake never becomes usable.
        settle(new ManagedLatexRenderError("worker_failed", "Renderer worker protocol failed."));
        void worker.terminate();
      }
    };
    const onError = (error: Error) => {
      settle(
        new ManagedLatexRenderError("worker_failed", "Renderer worker failed to initialize.", {
          cause: error,
        }),
      );
    };
    // A worker can exit before it ever emits `message` or `error`. Without this the handshake would
    // stay pending until the unreferenced init timer fired, which a one-shot host may never reach.
    const onExit = () => {
      settle(
        new ManagedLatexRenderError("worker_failed", "Renderer worker exited before it was ready."),
      );
    };
    const timer = setTimeout(() => {
      settle(
        new ManagedLatexRenderError("worker_failed", "Renderer worker initialization timed out."),
      );
      void worker.terminate();
    }, this.#initializationTimeout);
    timer.unref?.();
    worker.on("message", onMessage);
    worker.once("error", onError);
    worker.once("exit", onExit);
    return { worker, ready, busy: false, generation: 0, warmFailures: 0, disabled: false };
  }

  #dispatch(): void {
    if (this.#closed) return;
    for (const slot of this.#slots) {
      if (slot.busy) continue;
      const job = this.#queue.shift();
      if (job === undefined) return;
      if (job.signal?.aborted === true) {
        job.reject(cancelledError());
        continue;
      }
      slot.busy = true;
      this.#active.add(job);
      void this.#run(slot, job);
    }
  }

  async #run(slot: Slot, job: Job): Promise<void> {
    let started: number | undefined;
    const generation = ++slot.generation;
    let replace = false;
    // Hold the event loop open only for the duration of this job, including worker startup, so an
    // in-flight render cannot be dropped by process exit and an idle pool cannot delay it.
    const refed = slot.worker;
    ref(refed);
    try {
      await slot.ready;
      // A completed handshake proves the slot can start a worker, so the retry budget is restored.
      slot.warmFailures = 0;
      if (job.signal?.aborted === true) throw cancelledError();
      started = performance.now();
      const id = this.#nextId;
      // A bounded, wrapping counter keeps every id an exact small integer the validator can check.
      this.#nextId = id >= maximumRequestId ? 1 : id + 1;
      const display = job.request.display ?? true;
      const result = await new Promise<LatexSvgRenderResult>((resolve, reject) => {
        const finish = (error?: Error, value?: LatexSvgRenderResult) => {
          clearTimeout(timer);
          job.signal?.removeEventListener("abort", onAbort);
          slot.worker.off("message", onMessage);
          slot.worker.off("error", onError);
          slot.worker.off("exit", onExit);
          if (error !== undefined) reject(error);
          else if (value !== undefined) resolve(value);
        };
        const onMessage = (message: unknown) => {
          // Every field is validated against this exact in-flight request before it is used. A
          // malformed message is a worker failure, never a render failure, and never reflected.
          const response = parseWorkerResponse(message, {
            id,
            format: job.format,
            tex: job.request.tex,
            display,
          });
          if (response === undefined) {
            replace = true;
            finish(
              new ManagedLatexRenderError("worker_failed", "Renderer worker protocol failed."),
            );
          } else if (response.type === "error") {
            replace = true;
            // The code is validated against the closed set; the sentence is pool-authored so no
            // worker-supplied text can reach a caller or a log.
            finish(new ManagedLatexRenderError(response.code, describeWorkerError(response.code)));
          } else {
            finish(undefined, response.result);
          }
        };
        const onError = (error: Error) => {
          replace = true;
          finish(
            new ManagedLatexRenderError("worker_failed", "Renderer worker crashed.", {
              cause: error,
            }),
          );
        };
        const onExit = () => {
          replace = true;
          finish(new ManagedLatexRenderError("worker_failed", "Renderer worker exited."));
        };
        const onAbort = () => {
          replace = true;
          finish(cancelledError());
        };
        const timer = setTimeout(() => {
          replace = true;
          finish(new ManagedLatexRenderError("timeout", "LaTeX rendering timed out."));
        }, this.#timeout);
        timer.unref?.();
        slot.worker.on("message", onMessage);
        slot.worker.once("error", onError);
        slot.worker.once("exit", onExit);
        job.signal?.addEventListener("abort", onAbort, { once: true });
        const message: WorkerRenderRequest = {
          type: "render",
          id,
          tex: job.request.tex,
          display,
          format: job.format,
          ...(job.request.style === undefined ? {} : { style: job.request.style }),
        };
        slot.worker.postMessage(message);
      });
      if (Buffer.byteLength(result.svg, "utf8") > coreLimits.maximumOutputBytes) {
        replace = true;
        throw new ManagedLatexRenderError("output_limit", "Renderer output exceeds the SVG limit.");
      }
      if (result.png !== undefined && result.png.byteLength > 8 * 1024 * 1024) {
        replace = true;
        throw new ManagedLatexRenderError(
          "output_limit",
          "Renderer payload exceeds the image limit.",
        );
      }
      job.resolve(result);
    } catch (error) {
      // Initialization failure also poisons the slot; no expression follows a failed worker.
      replace = true;
      job.reject(
        error instanceof Error
          ? error
          : new ManagedLatexRenderError("worker_failed", "Renderer failed."),
      );
    } finally {
      this.#active.delete(job);
      if (started !== undefined) job.budget.record(performance.now() - started);
      unref(refed);
      // A replacement failure must never wedge the slot. `#replace` is already total, but this
      // guard keeps the two statements below reachable even if it is changed later.
      if (replace && !this.#closed && slot.generation === generation) {
        await this.#replace(slot).catch(() => undefined);
      }
      slot.busy = false;
      this.#dispatch();
    }
  }

  /**
   * Retires a poisoned worker and warms a fresh one. Total by construction: a spawn failure is
   * recorded against the slot's retry budget and surfaced to the next job through `ready`, never
   * thrown at the caller of this method.
   */
  async #replace(slot: Slot): Promise<void> {
    await slot.worker.terminate().catch(() => undefined);
    // `close` can complete while the termination above is awaited. Spawning here would leak a
    // thread that nothing terminates, so the closed state is re-checked at the last moment.
    if (this.#closed || slot.disabled) return;
    let replacement: Slot;
    try {
      replacement = this.#createSlot();
    } catch (error) {
      // The slot cannot start a worker at all. Fail the jobs addressed to it deterministically
      // instead of spawning forever, and stop retrying once the cap is reached.
      slot.warmFailures += 1;
      if (slot.warmFailures >= maximumWarmRetries) slot.disabled = true;
      const failure = new ManagedLatexRenderError(
        "worker_failed",
        "Renderer worker could not be started.",
        { cause: error instanceof Error ? error : undefined },
      );
      slot.ready = Promise.reject(failure);
      void slot.ready.catch(() => undefined);
      return;
    }
    // A replacement created concurrently with `close` is terminated rather than installed.
    if (this.#closed) {
      void replacement.worker.terminate().catch(() => undefined);
      return;
    }
    slot.worker = replacement.worker;
    slot.ready = replacement.ready;
  }
}

let sharedRenderer: ManagedLatexRenderer | undefined;

export function getManagedLatexRenderer(): ManagedLatexRenderer {
  sharedRenderer ??= new ManagedLatexRenderer();
  return sharedRenderer;
}

/**
 * Deterministically tears down the shared pool. Idle workers are already unreferenced, so a
 * one-shot process exits without this call; a long-lived host uses it to release threads eagerly.
 */
export async function closeManagedLatexRenderer(): Promise<void> {
  const renderer = sharedRenderer;
  sharedRenderer = undefined;
  await renderer?.close();
}

export async function renderTexToSvg(
  request: LatexSvgRenderRequest,
  options: LatexRenderOptions = {},
): Promise<LatexSvgRenderResult> {
  return getManagedLatexRenderer().render(
    requestWithStyleOption(request, options.style),
    options.budget ?? new LatexRenderBudget(),
    options.signal,
  );
}

export interface LatexPngRenderResult extends LatexSvgRenderResult {
  readonly png: Uint8Array;
  /** RGBA pixels matching width × height, for bounded non-PNG terminal protocols. */
  readonly pixels: Uint8Array;
  readonly width: number;
  readonly height: number;
}

export async function renderTexToPng(
  request: LatexSvgRenderRequest,
  options: LatexRenderOptions = {},
): Promise<LatexPngRenderResult> {
  const result = await getManagedLatexRenderer().render(
    requestWithStyleOption(request, options.style),
    options.budget ?? new LatexRenderBudget(),
    options.signal,
    "png",
  );
  if (
    result.png === undefined ||
    result.pixels === undefined ||
    result.width === undefined ||
    result.height === undefined
  ) {
    throw new ManagedLatexRenderError("worker_failed", "Renderer returned an incomplete image.");
  }
  return result as LatexPngRenderResult;
}

function requestWithStyleOption(
  request: LatexSvgRenderRequest,
  style: LatexRenderOptions["style"],
): LatexSvgRenderRequest {
  if (
    style === undefined ||
    typeof request !== "object" ||
    request === null ||
    request.style !== undefined
  ) {
    return request;
  }
  return { ...request, style };
}

/**
 * `ref`/`unref` are optional on a `Worker`-shaped test double and a terminated worker, so both are
 * applied defensively. Losing a ref must never fail a render.
 */
function ref(worker: Worker): void {
  try {
    worker.ref?.();
  } catch {
    // A terminated or replaced worker cannot be referenced; the job outcome is unaffected.
  }
}

function unref(worker: Worker): void {
  try {
    worker.unref?.();
  } catch {
    // As above: an already-terminated worker holds no handle to release.
  }
}

function cancelledError(): ManagedLatexRenderError {
  return new ManagedLatexRenderError("cancelled", "LaTeX rendering was cancelled.");
}

/**
 * Maps a validated worker error code to a fixed local sentence. Worker-supplied text is never used,
 * so untrusted TeX, MathJax internals, and host paths cannot reach a caller through an error.
 */
function describeWorkerError(code: WorkerErrorCode): string {
  switch (code) {
    case "invalid_input":
      return "The LaTeX expression is not valid input for the renderer.";
    case "input_limit":
      return "The LaTeX expression exceeds a renderer input limit.";
    case "output_limit":
      return "The rendered output exceeds a renderer output limit.";
    case "unsafe_svg":
      return "The rendered output failed renderer safety validation.";
    case "render_failed":
      return "The isolated LaTeX renderer could not render the expression.";
  }
}

/**
 * Validates caller input before it enters the queue and canonicalizes style values once. This keeps
 * malformed styles from poisoning a worker and ensures the strict worker request contains the same
 * pixel-affecting values that the caller supplied, even if the input object is mutated later.
 */
function normalizePublicRequest(request: LatexSvgRenderRequest): LatexSvgRenderRequest {
  if (typeof request !== "object" || request === null || Array.isArray(request)) {
    throw new LatexSvgRenderError("invalid_input", "LaTeX render request must be an object.");
  }
  if (typeof request.tex !== "string" || request.tex.length === 0) {
    throw new LatexSvgRenderError("invalid_input", "TeX input must be a non-empty string.");
  }
  if (request.display !== undefined && typeof request.display !== "boolean") {
    throw new LatexSvgRenderError("invalid_input", "LaTeX display mode must be a boolean.");
  }

  const style: NormalizedLatexRenderStyle | undefined = normalizeLatexRenderStyle(request.style);
  return Object.freeze({
    ...(request.display === undefined ? {} : { display: request.display }),
    ...(style === undefined ? {} : { style }),
    tex: request.tex,
  });
}
