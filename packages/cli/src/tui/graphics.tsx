import type { Writable } from "node:stream";
import { renderTexToPng } from "@researk/latex-renderer";
import { Box, type DOMElement, measureElement, Text, type TextProps } from "ink";
import * as React from "react";
import { buildKittyPng, kittyDeleteById } from "../rendering/kitty.js";
import {
  encodeSixel,
  type ImageCellSize,
  imageCellSize,
  type SixelEncodeResult,
} from "../rendering/sixel.js";
import type { TerminalCapability, TerminalGraphicsProtocol } from "../rendering/terminal.js";
import type {
  CellPixelDimensions,
  TerminalCapabilityProbeResult,
} from "../rendering/terminal-query.js";
import {
  type FormulaRaster,
  FormulaRasterCache,
  type FormulaRasterCacheOptions,
  type FormulaRasterOutcome,
  type FormulaRasterRenderer,
  type FormulaRasterRenderOptions,
} from "./formula-renderer.js";
import { displayText } from "./state.js";

const ESC = "\u001b";
const SAVE_CURSOR = `${ESC}[s`;
const RESTORE_CURSOR = `${ESC}[u`;
// Windows Terminal DECSDM: reset (?80l) is cursor-relative/scrolling; set (?80h) clamps to the
// top-left. We CUP to a pre-clipped cell, so leave the terminal in the reset/default mode.
const SIXEL_SCROLL_RESET = `${ESC}[?80l`;
const DEFAULT_KITTY_CELL_WIDTH = 10;
const DEFAULT_KITTY_CELL_HEIGHT = 20;
const DEFAULT_MAX_VISIBLE_SLOTS = 32;
const DEFAULT_MAX_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_VISIBLE_SLOTS = 256;
const MAX_FRAME_BYTES = 256 * 1024 * 1024;
const MAX_TERMINAL_COLUMNS = 4096;
const MAX_TERMINAL_ROWS = 4096;
const MAX_ID = 0xffff_ffff;

/** A minimal stdout surface keeps the runtime friendly to TTY fakes and Ink test harnesses. */
export type FormulaGraphicsStdout = Pick<Writable, "write"> &
  Partial<Pick<Writable, "once" | "off">>;

export interface FormulaGraphicsTerminalSize {
  readonly columns: number;
  readonly rows: number;
}

export type FormulaGraphicsCapability =
  | TerminalCapability
  | TerminalCapabilityProbeResult
  | Readonly<{
      readonly protocol: TerminalGraphicsProtocol;
      readonly reason?: string;
      readonly cellPixels?: CellPixelDimensions;
      readonly kittyResponse?: Readonly<{ readonly explicitOk?: boolean }>;
    }>;

export interface FormulaGraphicsMetrics {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export type FormulaGraphicsRef = DOMElement | null | undefined;
export type FormulaGraphicsRefLike =
  | FormulaGraphicsRef
  | Readonly<{ readonly current: FormulaGraphicsRef }>;

export interface FormulaGraphicsRegistration {
  /** Stable application key. It is never interpolated into terminal control bytes. */
  readonly key: string;
  readonly ref: FormulaGraphicsRefLike;
  readonly raster: FormulaRaster;
  readonly clipRef?: FormulaGraphicsRefLike;
  /** Test and embedding seam for a measured Ink node. */
  readonly metrics?: FormulaGraphicsMetrics;
  /** Test and embedding seam for a measured clipping Ink node. */
  readonly clipMetrics?: FormulaGraphicsMetrics;
}

export interface FormulaGraphicsPlacement {
  readonly column: number;
  readonly columns: number;
  readonly imageId?: number;
  readonly placementId?: number;
  readonly row: number;
  readonly rows: number;
}

export interface FormulaGraphicsRuntimeOptions {
  readonly stdout: FormulaGraphicsStdout;
  readonly capability: FormulaGraphicsCapability;
  readonly columns?: number;
  readonly rows?: number;
  readonly terminalSize?: FormulaGraphicsTerminalSize;
  readonly cache?: FormulaRasterCache;
  readonly rasterCache?: FormulaRasterCache;
  readonly renderer?: FormulaRasterRenderer;
  readonly cacheOptions?: FormulaRasterCacheOptions;
  readonly measure?: (ref: DOMElement) => FormulaGraphicsMetrics | undefined;
  readonly maxVisibleSlots?: number;
  readonly maxFrameBytes?: number;
}

export interface FormulaGraphicsRenderRequest {
  readonly tex: string;
  readonly display: boolean;
}

interface RegisteredFormula extends FormulaGraphicsRegistration {
  readonly refNode: DOMElement;
  readonly clipNode: DOMElement | undefined;
}

type GraphicsWriteResult = "written" | "stale";

interface SnapshotFormula {
  readonly registration: RegisteredFormula;
  readonly cellSize: ImageCellSize;
  readonly metrics: FormulaGraphicsMetrics;
}

interface SnapshotFrame {
  readonly generation: number;
  readonly formulas: readonly SnapshotFormula[];
}

type BuiltPlacement =
  | {
      readonly bytes: number;
      readonly placement: KittyPlaced;
      readonly protocol: "kitty";
      readonly sequence: string;
    }
  | {
      readonly bytes: number;
      readonly placement: SixelPlaced;
      readonly protocol: "sixel";
      readonly sequence: string;
    };

interface KittyPlaced extends FormulaGraphicsPlacement {
  readonly imageId: number;
  readonly placementId: number;
  readonly placementKey: string;
}

interface SixelPlaced extends FormulaGraphicsPlacement {
  readonly placementKey: string;
}

type PlacedFormula =
  | { readonly protocol: "kitty"; readonly placement: KittyPlaced }
  | { readonly protocol: "sixel"; readonly placement: SixelPlaced };

type RuntimeListener = () => void;

/**
 * Owns all live terminal graphics state for formula components.
 *
 * Ink only receives normal Box/Text nodes from `FormulaGraphic`; this class is the sole owner of
 * Kitty APC and Windows Terminal Sixel control bytes. A frame is measured before it is emitted,
 * so a graphic that is clipped, on the scroll row, or beyond a configured bound remains source.
 */
export class FormulaGraphicsRuntime {
  readonly #stdout: FormulaGraphicsStdout;
  readonly #capability: FormulaGraphicsCapability;
  readonly #cache: FormulaRasterCache;
  readonly #measure: (ref: DOMElement) => FormulaGraphicsMetrics | undefined;
  readonly #maxVisibleSlots: number;
  readonly #maxFrameBytes: number;
  readonly #registrations = new Map<string, RegisteredFormula>();
  readonly #listeners = new Set<RuntimeListener>();
  readonly #controllers = new Set<AbortController>();
  #columns: number;
  #rows: number;
  #generation = 0;
  #snapshot: SnapshotFrame | undefined;
  #visibleKeys = new Set<string>();
  #placed: PlacedFormula[] = [];
  #nextImageId = 1;
  #nextPlacementId = 1;
  #writeTail: Promise<unknown> | undefined;
  #afterFrameTail: Promise<void> = Promise.resolve();
  #afterFrameBusy = false;
  #afterFrameMarker: object | undefined;
  #writeBroken = false;
  #disposed = false;

  public constructor(options: FormulaGraphicsRuntimeOptions);
  public constructor(
    stdout: FormulaGraphicsStdout,
    capability: FormulaGraphicsCapability,
    terminalSize?: FormulaGraphicsTerminalSize,
    seam?:
      | FormulaRasterCache
      | FormulaRasterRenderer
      | Readonly<{
          readonly cache?: FormulaRasterCache;
          readonly renderer?: FormulaRasterRenderer;
        }>,
  );
  public constructor(
    optionsOrStdout: FormulaGraphicsRuntimeOptions | FormulaGraphicsStdout,
    capability?: FormulaGraphicsCapability,
    terminalSize?: FormulaGraphicsTerminalSize,
    seam?:
      | FormulaRasterCache
      | FormulaRasterRenderer
      | Readonly<{
          readonly cache?: FormulaRasterCache;
          readonly renderer?: FormulaRasterRenderer;
        }>,
  ) {
    const options = normalizeRuntimeOptions(optionsOrStdout, capability, terminalSize, seam);
    this.#stdout = options.stdout;
    this.#capability = options.capability;
    this.#columns = boundedDimension(options.terminalSize?.columns ?? 80, MAX_TERMINAL_COLUMNS);
    this.#rows = boundedDimension(options.terminalSize?.rows ?? 24, MAX_TERMINAL_ROWS);
    this.#measure = options.measure ?? measureElement;
    this.#maxVisibleSlots = boundedOption(
      options.maxVisibleSlots,
      DEFAULT_MAX_VISIBLE_SLOTS,
      MAX_VISIBLE_SLOTS,
    );
    this.#maxFrameBytes = boundedOption(
      options.maxFrameBytes,
      DEFAULT_MAX_FRAME_BYTES,
      MAX_FRAME_BYTES,
    );
    this.#cache =
      options.cache ??
      options.rasterCache ??
      new FormulaRasterCache(options.renderer ?? renderTexToPng, options.cacheOptions);
  }

  public get capability(): FormulaGraphicsCapability {
    return this.#capability;
  }

  public get cache(): FormulaRasterCache {
    return this.#cache;
  }

  public get generation(): number {
    return this.#generation;
  }

  public get disposed(): boolean {
    return this.#disposed;
  }

  public supportsGraphics(): boolean {
    return this.#cellPixels() !== undefined;
  }

  /** Return a bounded cell reservation for a validated raster, or undefined for source fallback. */
  public cellSize(raster: FormulaRaster): ImageCellSize | undefined {
    const cells = this.#cellPixels();
    if (cells === undefined) return undefined;
    return imageCellSize(raster.width, raster.height, cells.width, cells.height);
  }

  public renderFormula(
    request: FormulaGraphicsRenderRequest,
    options: FormulaRasterRenderOptions = {},
  ): Promise<FormulaRasterOutcome> {
    if (this.#disposed || !this.supportsGraphics()) {
      return Promise.resolve({ ok: false, reason: "renderer_failed" });
    }
    return this.#cache.render(request, options);
  }

  /** Alias kept small and convenient for component and embedding callers. */
  public render(
    request: FormulaGraphicsRenderRequest,
    options: FormulaRasterRenderOptions = {},
  ): Promise<FormulaRasterOutcome> {
    return this.renderFormula(request, options);
  }

  /** Track an in-flight component render so dispose() can abort it synchronously. */
  public trackRender(controller: AbortController): () => void {
    if (this.#disposed) {
      controller.abort();
      return () => undefined;
    }
    this.#controllers.add(controller);
    return () => this.#controllers.delete(controller);
  }

  public subscribe(listener: RuntimeListener): () => void {
    if (this.#disposed) return () => undefined;
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  public isVisible(key: string): boolean {
    return !this.#disposed && this.#visibleKeys.has(key);
  }

  public registrationCount(): number {
    return this.#registrations.size;
  }

  public placedCount(): number {
    return this.#placed.length;
  }

  public getPlacement(key: string): FormulaGraphicsPlacement | undefined {
    const placed = this.#placed.find((item) => item.placement.placementKey === key);
    return placed?.placement;
  }

  public register(registration: FormulaGraphicsRegistration): boolean;
  public register(key: string, registration: Omit<FormulaGraphicsRegistration, "key">): boolean;
  public register(
    registrationOrKey: FormulaGraphicsRegistration | string,
    registration?: Omit<FormulaGraphicsRegistration, "key">,
  ): boolean {
    if (this.#disposed) return false;
    const value: FormulaGraphicsRegistration =
      typeof registrationOrKey === "string"
        ? ({ ...registration, key: registrationOrKey } as FormulaGraphicsRegistration)
        : registrationOrKey;
    if (!isSafeRegistration(value)) return false;
    if (this.#registrations.has(value.key)) return false;
    const refNode = resolveRef(value.ref);
    if (refNode === undefined) return false;
    const clipNode = resolveRef(value.clipRef);
    const cellSize = this.cellSize(value.raster);
    if (cellSize === undefined) return false;
    this.#registrations.set(value.key, { ...value, refNode, clipNode });
    return true;
  }

  public unregister(key: string, ref?: FormulaGraphicsRefLike): boolean {
    const current = this.#registrations.get(key);
    if (current === undefined) return false;
    if (ref !== undefined && resolveRef(ref) !== current.refNode) return false;
    this.#registrations.delete(key);
    this.#visibleKeys.delete(key);
    this.#notify();
    return true;
  }

  /**
   * Clear old protocol placements, synchronously advance generation, and snapshot eligible Ink
   * boxes. The caller must invoke afterFrame only after Ink has flushed this frame.
   */
  public beforeFrame(columns = this.#columns, rows = this.#rows): number {
    if (this.#disposed) return this.#generation;
    this.#generation += 1;
    this.#columns = boundedDimension(columns, MAX_TERMINAL_COLUMNS);
    this.#rows = boundedDimension(rows, MAX_TERMINAL_ROWS);
    this.#clearPlacedSynchronously();

    const formulas: SnapshotFormula[] = [];
    if (this.supportsGraphics() && this.#columns > 0 && this.#rows > 1) {
      for (const registration of this.#registrations.values()) {
        if (formulas.length >= this.#maxVisibleSlots) break;
        const cellSize = this.cellSize(registration.raster);
        if (cellSize === undefined) continue;
        const metrics =
          registration.metrics === undefined
            ? this.#safeMeasure(registration.refNode)
            : normalizeMetrics(registration.metrics);
        if (
          metrics === undefined ||
          !isVisibleMetrics(metrics, cellSize, this.#columns, this.#rows)
        ) {
          continue;
        }
        const clipMetrics =
          registration.clipMetrics === undefined
            ? registration.clipNode === undefined
              ? undefined
              : this.#safeMeasure(registration.clipNode)
            : normalizeMetrics(registration.clipMetrics);
        if (
          (registration.clipNode !== undefined || registration.clipMetrics !== undefined) &&
          clipMetrics === undefined
        ) {
          continue;
        }
        if (!isContainedByClip(metrics, clipMetrics)) continue;
        if (registration.raster.png.byteLength > this.#maxFrameBytes) continue;
        formulas.push({ cellSize, metrics, registration });
      }
    }
    this.#snapshot = { generation: this.#generation, formulas };
    // A frame is only graphically visible after its protocol write succeeds. Clearing here keeps
    // pending, failed, and stale generations on exact-source fallback.
    this.#setVisibleKeys(new Set<string>());
    return this.#generation;
  }

  /**
   * Emit a snapshot after the caller confirms Ink's frame flush. Calls are serialized and stale
   * generations are discarded before every write, so a resize/scroll cannot leak old placement.
   */
  public afterFrame(generation: number, inkFlush?: PromiseLike<unknown> | boolean): Promise<void> {
    const run = async (): Promise<void> => {
      if (inkFlush === false) return;
      if (inkFlush !== undefined && typeof inkFlush !== "boolean") {
        try {
          await inkFlush;
        } catch {
          return;
        }
      }
      await this.#emitFrame(generation);
    };
    const wasBusy = this.#afterFrameBusy;
    const marker = {};
    this.#afterFrameBusy = true;
    this.#afterFrameMarker = marker;
    const operation = wasBusy ? this.#afterFrameTail.then(run) : run();
    const completion = operation.catch(() => undefined);
    this.#afterFrameTail = completion.finally(() => {
      if (this.#afterFrameMarker === marker) {
        this.#afterFrameBusy = false;
        this.#afterFrameMarker = undefined;
      }
    });
    return operation;
  }

  /**
   * Synchronously disable writes and tear down active graphics. Cache/render aborts happen before
   * returning; any already queued stream drain is ignored by the disposed write guard.
   */
  public dispose(): void {
    if (this.#disposed) return;
    this.#generation += 1;
    this.#registrations.clear();
    this.#visibleKeys.clear();
    this.#snapshot = undefined;
    for (const controller of this.#controllers) controller.abort();
    this.#controllers.clear();
    this.#clearPlacedSynchronously();
    this.#disposed = true;
    try {
      this.#cache.clear();
    } catch {
      // A test seam or embedders' cache cannot prevent the runtime from becoming inert.
    }
    this.#notify();
  }

  async #emitFrame(generation: number): Promise<void> {
    if (this.#disposed || generation !== this.#generation || this.#writeBroken) return;
    const snapshot = this.#snapshot;
    if (snapshot === undefined || snapshot.generation !== generation) return;

    const nextPlaced: PlacedFormula[] = [];
    let frameBytes = 0;
    for (const item of snapshot.formulas) {
      if (this.#disposed || generation !== this.#generation) return;
      if (this.#registrations.get(item.registration.key) !== item.registration) {
        this.#setVisible(item.registration.key, false);
        continue;
      }
      const built = this.#buildPlacement(item, frameBytes);
      if (built === undefined) {
        this.#setVisible(item.registration.key, false);
        continue;
      }
      frameBytes += built.bytes;
      const placed: PlacedFormula =
        built.protocol === "kitty"
          ? { placement: built.placement, protocol: "kitty" }
          : { placement: built.placement, protocol: "sixel" };
      // Track before the write can yield on backpressure. A resize/dispose can therefore clear an
      // image whose stdout.write returned false, while generation-aware queued writes are skipped.
      this.#placed.push(placed);
      try {
        const result = await this.#queueWrite(built.sequence, generation);
        if (result === "stale") {
          this.#removePlaced(placed);
          this.#setVisible(item.registration.key, false);
          continue;
        }
      } catch {
        this.#setVisible(item.registration.key, false);
        return;
      }
      if (this.#disposed || generation !== this.#generation) return;
      nextPlaced.push(placed);
      this.#setVisible(item.registration.key, true);
    }
    if (!this.#disposed && generation === this.#generation) this.#placed = nextPlaced;
  }

  #buildPlacement(item: SnapshotFormula, frameBytes: number): BuiltPlacement | undefined {
    const row = item.metrics.y + 1;
    const column = item.metrics.x + 1;
    if (this.#capability.protocol === "kitty") {
      const imageId = this.#allocateId("image");
      const placementId = this.#allocateId("placement");
      if (imageId === undefined || placementId === undefined) return undefined;
      const cells = this.#cellPixels();
      const result = buildKittyPng(item.registration.raster.png, {
        ...(cells === undefined ? {} : { cellHeight: cells.height, cellWidth: cells.width }),
        column,
        columns: item.cellSize.width,
        imageId,
        placementId,
        row,
        rows: item.cellSize.height,
      });
      if (
        !result.ok ||
        !withinFrameBudget(frameBytes, result.sequence.length, this.#maxFrameBytes)
      ) {
        return undefined;
      }
      return {
        bytes: result.sequence.length,
        placement: {
          column,
          columns: item.cellSize.width,
          imageId,
          placementId,
          placementKey: item.registration.key,
          row,
          rows: item.cellSize.height,
        },
        protocol: "kitty",
        sequence: result.sequence,
      };
    }

    if (this.#capability.protocol !== "sixel") return undefined;
    const encoded = encodeSixel(item.registration.raster);
    if (!encoded.ok) return undefined;
    const sequence = sixelPlacementSequence(row, column, encoded);
    if (!withinFrameBudget(frameBytes, sequence.length, this.#maxFrameBytes)) return undefined;
    return {
      bytes: sequence.length,
      placement: {
        column,
        columns: item.cellSize.width,
        placementKey: item.registration.key,
        row,
        rows: item.cellSize.height,
      },
      protocol: "sixel",
      sequence,
    };
  }

  #cellPixels(): CellPixelDimensions | undefined {
    if (this.#capability.protocol === "kitty") {
      const capability = this.#capability as FormulaGraphicsCapability & {
        readonly kittyResponse?: Readonly<{ readonly explicitOk?: boolean }>;
        readonly cellPixels?: CellPixelDimensions;
      };
      const explicit = capability.kittyResponse?.explicitOk;
      if (explicit === false) return undefined;
      const returned = capability.cellPixels;
      return isCellPixels(returned)
        ? returned
        : { width: DEFAULT_KITTY_CELL_WIDTH, height: DEFAULT_KITTY_CELL_HEIGHT };
    }
    if (this.#capability.protocol === "sixel") {
      const cellPixels = (
        this.#capability as FormulaGraphicsCapability & {
          readonly cellPixels?: CellPixelDimensions;
        }
      ).cellPixels;
      return isCellPixels(cellPixels) ? cellPixels : undefined;
    }
    return undefined;
  }

  #safeMeasure(ref: DOMElement): FormulaGraphicsMetrics | undefined {
    try {
      return normalizeMetrics(this.#measure(ref));
    } catch {
      return undefined;
    }
  }

  #allocateId(kind: "image" | "placement"): number | undefined {
    if (kind === "image") {
      if (this.#nextImageId > MAX_ID) return undefined;
      const value = this.#nextImageId;
      this.#nextImageId += 1;
      return value;
    }
    if (this.#nextPlacementId > MAX_ID) return undefined;
    const value = this.#nextPlacementId;
    this.#nextPlacementId += 1;
    return value;
  }

  #removePlaced(target: PlacedFormula): void {
    const index = this.#placed.indexOf(target);
    if (index >= 0) this.#placed.splice(index, 1);
  }

  #clearPlacedSynchronously(): void {
    if (this.#placed.length === 0 || this.#writeBroken) return;
    const previous = this.#placed;
    this.#placed = [];
    const seenKitty = new Set<number>();
    for (const item of previous) {
      if (item.protocol === "kitty") {
        if (seenKitty.has(item.placement.imageId)) continue;
        seenKitty.add(item.placement.imageId);
        const sequence = kittyDeleteById(item.placement.imageId);
        if (sequence !== undefined) this.#writeCleanupSynchronously(sequence);
      } else {
        const sequence = sixelClearSequence(item.placement);
        if (sequence !== undefined) this.#writeCleanupSynchronously(sequence);
      }
    }
  }

  /**
   * Cleanup must reach the stream before beforeFrame/dispose returns. Writable backpressure is
   * already ordered by the stream itself; afterFrame remains responsible for awaiting drain when
   * it emits a new image. A failed cleanup permanently disables graphics without throwing.
   */
  #writeCleanupSynchronously(sequence: string): void {
    if (this.#disposed || this.#writeBroken) return;
    try {
      this.#stdout.write(sequence);
    } catch {
      this.#writeBroken = true;
    }
  }

  #queueWrite(sequence: string, generation?: number): Promise<GraphicsWriteResult> {
    if (this.#disposed || this.#writeBroken) return Promise.reject(new Error("graphics disposed"));
    if (this.#writeTail !== undefined) {
      const previous = this.#writeTail;
      const next = previous.then(() => this.#performWrite(sequence, generation));
      this.#writeTail = next.catch(() => {
        this.#writeBroken = true;
      });
      return next;
    }
    try {
      if (generation !== undefined && generation !== this.#generation) {
        return Promise.resolve("stale");
      }
      const accepted = this.#stdout.write(sequence);
      if (accepted !== false) return Promise.resolve("written");
      const pending = this.#waitForDrain().then(() => "written" as const);
      this.#writeTail = pending.catch(() => {
        this.#writeBroken = true;
      });
      return pending;
    } catch {
      this.#writeBroken = true;
      return Promise.reject(new Error("graphics write failed"));
    }
  }

  async #performWrite(sequence: string, generation?: number): Promise<GraphicsWriteResult> {
    if (this.#disposed || this.#writeBroken) throw new Error("graphics disposed");
    if (generation !== undefined && generation !== this.#generation) return "stale";
    const accepted = this.#stdout.write(sequence);
    if (accepted !== false) return "written";
    await this.#waitForDrain();
    return "written";
  }

  #waitForDrain(): Promise<void> {
    const once = this.#stdout.once;
    const off = this.#stdout.off;
    if (once === undefined || off === undefined) return Promise.reject(new Error("no drain sink"));
    return new Promise<void>((resolve, reject) => {
      const onDrain = (): void => {
        cleanup();
        resolve();
      };
      const onError = (error: Error): void => {
        cleanup();
        reject(error);
      };
      const cleanup = (): void => {
        off.call(this.#stdout, "drain", onDrain);
        off.call(this.#stdout, "error", onError);
      };
      once.call(this.#stdout, "drain", onDrain);
      once.call(this.#stdout, "error", onError);
    });
  }

  #setVisible(key: string, visible: boolean): void {
    const had = this.#visibleKeys.has(key);
    if (had === visible) return;
    if (visible) this.#visibleKeys.add(key);
    else this.#visibleKeys.delete(key);
    this.#notify();
  }

  #setVisibleKeys(keys: Set<string>): void {
    if (sameSet(this.#visibleKeys, keys)) return;
    this.#visibleKeys = keys;
    this.#notify();
  }

  #notify(): void {
    for (const listener of this.#listeners) {
      try {
        listener();
      } catch {
        // A component subscriber cannot make terminal cleanup fail.
      }
    }
  }
}

/** Factory form for callers that prefer not to use `new`. */
export function createFormulaGraphicsRuntime(
  options: FormulaGraphicsRuntimeOptions,
): FormulaGraphicsRuntime {
  return new FormulaGraphicsRuntime(options);
}

export interface FormulaGraphicStyle extends Omit<TextProps, "children"> {
  readonly selectedColor?: string;
}

export interface FormulaGraphicProps {
  readonly runtime: FormulaGraphicsRuntime;
  readonly formulaKey?: string;
  readonly key?: string;
  readonly id?: string;
  readonly source?: string;
  readonly exactSource?: string;
  readonly fallbackSource?: string;
  readonly tex?: string;
  readonly innerTex?: string;
  readonly display?: boolean;
  readonly inline?: boolean;
  readonly clipRef?: FormulaGraphicsRefLike;
  readonly selected?: boolean;
  readonly style?: FormulaGraphicStyle;
}

/**
 * Reusable live formula view. It always starts as safe exact source and switches to a measured Box
 * only after a bounded raster succeeds and the runtime confirms the Box is fully placeable.
 */
export function FormulaGraphic(props: FormulaGraphicProps): React.ReactElement {
  const formulaKey = props.formulaKey ?? props.id ?? props.key ?? "formula";
  const exactSource = props.exactSource ?? props.source ?? props.fallbackSource ?? "";
  const tex = props.innerTex ?? props.tex ?? "";
  const display = props.display ?? !props.inline;
  const ref = React.useRef<DOMElement | null>(null);
  const [outcome, setOutcome] = React.useState<FormulaRasterOutcome | undefined>(undefined);
  const supported = props.runtime.supportsGraphics();
  const visible = React.useSyncExternalStore(
    (listener) => props.runtime.subscribe(listener),
    () => props.runtime.isVisible(formulaKey),
    () => false,
  );

  React.useEffect(() => {
    setOutcome(undefined);
    if (!supported || props.runtime.disposed || tex.length === 0) return undefined;
    const controller = new AbortController();
    const release = props.runtime.trackRender(controller);
    let mounted = true;
    void props.runtime
      .renderFormula({ display, tex }, { signal: controller.signal })
      .then((next) => {
        if (mounted) setOutcome(next);
      })
      .catch(() => {
        if (mounted) setOutcome({ ok: false, reason: "renderer_failed" });
      });
    return () => {
      mounted = false;
      release();
      controller.abort();
    };
  }, [display, props.runtime, supported, tex]);

  const raster = outcome?.ok === true ? outcome.raster : undefined;
  const cellSize = raster === undefined ? undefined : props.runtime.cellSize(raster);
  const placeable = raster !== undefined && cellSize !== undefined && visible;

  React.useLayoutEffect(() => {
    if (raster === undefined || cellSize === undefined || props.runtime.disposed) return undefined;
    const accepted = props.runtime.register({
      clipRef: props.clipRef,
      key: formulaKey,
      raster,
      ref,
    });
    return () => {
      if (accepted) props.runtime.unregister(formulaKey, ref);
    };
  }, [cellSize, formulaKey, props.clipRef, props.runtime, raster]);

  const safeSource = displayText(exactSource);
  const style = props.style === undefined ? {} : props.style;
  if (raster === undefined || cellSize === undefined) {
    return <Text {...textStyle(style, props.selected)}>{safeSource}</Text>;
  }

  const reservation = placeable
    ? { flexShrink: 0, height: cellSize.height, width: cellSize.width }
    : {};
  const overflow = placeable ? { overflow: "visible" as const } : {};
  return (
    <Box ref={ref} {...reservation} {...overflow} aria-label={safeSource}>
      {placeable ? null : <Text {...textStyle(style, props.selected)}>{safeSource}</Text>}
    </Box>
  );
}

function textStyle(style: FormulaGraphicStyle, selected: boolean | undefined): TextProps {
  const { selectedColor, ...base } = style;
  if (selected && selectedColor !== undefined) return { ...base, color: selectedColor };
  return base;
}

function normalizeRuntimeOptions(
  optionsOrStdout: FormulaGraphicsRuntimeOptions | FormulaGraphicsStdout,
  capability: FormulaGraphicsCapability | undefined,
  terminalSize: FormulaGraphicsTerminalSize | undefined,
  seam:
    | FormulaRasterCache
    | FormulaRasterRenderer
    | Readonly<{
        readonly cache?: FormulaRasterCache;
        readonly renderer?: FormulaRasterRenderer;
      }>
    | undefined,
): FormulaGraphicsRuntimeOptions {
  if (capability === undefined && "capability" in optionsOrStdout) {
    return optionsOrStdout;
  }
  if (capability === undefined) {
    throw new TypeError("Formula graphics capability is required");
  }
  const cache =
    seam instanceof FormulaRasterCache ? seam : isCacheSeam(seam) ? seam.cache : undefined;
  const renderer =
    typeof seam === "function" ? seam : isCacheSeam(seam) ? seam.renderer : undefined;
  return {
    capability,
    ...(cache === undefined ? {} : { cache }),
    ...(renderer === undefined ? {} : { renderer }),
    stdout: optionsOrStdout as FormulaGraphicsStdout,
    ...(terminalSize === undefined ? {} : { terminalSize }),
  };
}

function isCacheSeam(
  value:
    | FormulaRasterCache
    | FormulaRasterRenderer
    | Readonly<{
        readonly cache?: FormulaRasterCache;
        readonly renderer?: FormulaRasterRenderer;
      }>
    | undefined,
): value is Readonly<{
  readonly cache?: FormulaRasterCache;
  readonly renderer?: FormulaRasterRenderer;
}> {
  return typeof value === "object" && value !== null && !(value instanceof FormulaRasterCache);
}

function isSafeRegistration(value: FormulaGraphicsRegistration): boolean {
  return (
    typeof value.key === "string" &&
    value.key.length > 0 &&
    value.key.length <= 1024 &&
    value.raster instanceof Object &&
    value.raster.png instanceof Uint8Array &&
    value.raster.pixels instanceof Uint8Array
  );
}

function resolveRef(value: FormulaGraphicsRefLike): DOMElement | undefined {
  if (value === null || value === undefined) return undefined;
  if ("current" in value) return value.current ?? undefined;
  return value;
}

function normalizeMetrics(
  value: FormulaGraphicsMetrics | undefined,
): FormulaGraphicsMetrics | undefined {
  if (value === undefined || value === null || typeof value !== "object") return undefined;
  const { height, width, x, y } = value;
  if (
    !Number.isSafeInteger(x) ||
    !Number.isSafeInteger(y) ||
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    x < 0 ||
    y < 0 ||
    width <= 0 ||
    height <= 0
  ) {
    return undefined;
  }
  return { height, width, x, y };
}

function isVisibleMetrics(
  metrics: FormulaGraphicsMetrics,
  cellSize: ImageCellSize,
  columns: number,
  rows: number,
): boolean {
  const x = metrics.x;
  const y = metrics.y;
  return (
    metrics.width > 0 &&
    metrics.height > 0 &&
    x >= 0 &&
    y >= 0 &&
    x + cellSize.width <= columns &&
    // Keep the final row free for Ink's scroll behavior.
    y + cellSize.height < rows
  );
}

function isContainedByClip(
  metrics: FormulaGraphicsMetrics,
  clip: FormulaGraphicsMetrics | undefined,
): boolean {
  if (clip === undefined) return true;
  return (
    clip.width > 0 &&
    clip.height > 0 &&
    clip.x >= 0 &&
    clip.y >= 0 &&
    metrics.x >= clip.x &&
    metrics.y >= clip.y &&
    metrics.x + metrics.width <= clip.x + clip.width &&
    metrics.y + metrics.height <= clip.y + clip.height
  );
}

function isCellPixels(value: CellPixelDimensions | undefined): value is CellPixelDimensions {
  return (
    value !== undefined &&
    Number.isSafeInteger(value.width) &&
    Number.isSafeInteger(value.height) &&
    value.width > 0 &&
    value.height > 0 &&
    value.width <= 4096 &&
    value.height <= 4096
  );
}

function boundedDimension(value: number, maximum: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(maximum, Math.max(0, Math.trunc(value)));
}

function boundedOption(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(1, Math.trunc(value)));
}

function withinFrameBudget(current: number, next: number, maximum: number): boolean {
  return Number.isSafeInteger(next) && next >= 0 && current <= maximum && next <= maximum - current;
}

function sixelPlacementSequence(
  row: number,
  column: number,
  encoded: SixelEncodeResult & { readonly ok: true },
): string {
  return `${SAVE_CURSOR}${SIXEL_SCROLL_RESET}${ESC}[${row};${column}H${encoded.sequence}${SIXEL_SCROLL_RESET}${RESTORE_CURSOR}`;
}

function sixelClearSequence(placement: SixelPlaced): string | undefined {
  const cells = placement.columns * placement.rows;
  if (!Number.isSafeInteger(cells) || cells <= 0 || cells > MAX_FRAME_BYTES) return undefined;
  const spaces = " ".repeat(placement.columns);
  const rows: string[] = [];
  for (let offset = 0; offset < placement.rows; offset += 1) {
    rows.push(`${ESC}[${placement.row + offset};${placement.column}H${spaces}`);
  }
  const sequence = `${SAVE_CURSOR}${rows.join("")}${RESTORE_CURSOR}`;
  return sequence.length <= MAX_FRAME_BYTES ? sequence : undefined;
}

function sameSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) return false;
  for (const value of left) if (!right.has(value)) return false;
  return true;
}
