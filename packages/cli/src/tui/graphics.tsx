import type { Writable } from "node:stream";
import type { LatexRenderBudget } from "@researk/latex-renderer";
import { Box, type DOMElement, measureElement, Text, type TextProps } from "ink";
import * as React from "react";
import {
  createTerminalCapabilities,
  type FormulaRendererDescriptor,
  type FormulaRendererId,
  selectFormulaRenderer,
  type TerminalCapabilities,
} from "../rendering/capabilities.js";
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
  DEFAULT_FORMULA_RENDER_STYLE,
  type FormulaRaster,
  FormulaRasterCache,
  type FormulaRasterCacheOptions,
  type FormulaRasterOutcome,
  type FormulaRasterRenderer,
  type FormulaRasterRenderOptions,
  type FormulaRenderStyle,
  latexFormulaRasterRenderer,
  type NormalizedFormulaRenderStyle,
  normalizeFormulaRenderStyle,
} from "./formula-renderer.js";
import { displayText } from "./state.js";

const ESC = "\u001b";
const SAVE_CURSOR = `${ESC}[s`;
const RESTORE_CURSOR = `${ESC}[u`;
// Windows Terminal DECSDM: reset (?80l) is cursor-relative/scrolling; set (?80h) clamps to the
// top-left. We CUP to a pre-clipped cell, so leave the terminal in the reset/default mode.
const SIXEL_SCROLL_RESET = `${ESC}[?80l`;
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
  | TerminalCapabilities
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
  /** Explicit pixel-affecting style; omitted styles use a foreground-only safe default. */
  readonly style?: FormulaRenderStyle;
  /** Cache/renderer identity used when style.rendererVersion is omitted. */
  readonly rendererVersion?: string;
  readonly measure?: (ref: DOMElement) => FormulaGraphicsMetrics | undefined;
  readonly maxVisibleSlots?: number;
  readonly maxFrameBytes?: number;
  /** Requests one follow-up Ink frame after a raster registration lands after onRender. */
  readonly requestFrame?: () => void;
}

export interface FormulaGraphicsRenderRequest {
  readonly tex: string;
  readonly display: boolean;
  readonly style?: FormulaRenderStyle;
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
  readonly #rendererSelection: FormulaRendererDescriptor;
  readonly #cache: FormulaRasterCache;
  readonly #measure: (ref: DOMElement) => FormulaGraphicsMetrics | undefined;
  readonly #maxVisibleSlots: number;
  readonly #maxFrameBytes: number;
  readonly #requestFrame: (() => void) | undefined;
  readonly #registrations = new Map<string, RegisteredFormula>();
  readonly #listeners = new Set<RuntimeListener>();
  readonly #controllers = new Set<AbortController>();
  #columns: number;
  #rows: number;
  #generation = 0;
  #styleRevision = 0;
  #style: NormalizedFormulaRenderStyle = DEFAULT_FORMULA_RENDER_STYLE;
  #snapshot: SnapshotFrame | undefined;
  #visibleKeys = new Set<string>();
  #visibleRegistrations = new Map<string, RegisteredFormula>();
  #placed: PlacedFormula[] = [];
  /** Confirmed placements waiting for a source frame before their cleanup is emitted. */
  #pendingCleanup = new Set<PlacedFormula>();
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
    this.#rendererSelection = selectFormulaRenderer(rendererCapabilityInput(options.capability));
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
    this.#requestFrame = options.requestFrame;
    const rendererVersion =
      options.rendererVersion ??
      options.cacheOptions?.rendererVersion ??
      DEFAULT_FORMULA_RENDER_STYLE.rendererVersion;
    // No terminal background is knowable at runtime unless the semantic theme supplies one.
    // Keep the compatibility foreground default for direct embedders, but never manufacture a
    // dark/white Sixel canvas; P2=1 leaves transparent raster padding untouched.
    const initialStyle = options.style ?? { foreground: DEFAULT_FORMULA_RENDER_STYLE.foreground };
    const normalizedStyle = normalizeFormulaRenderStyle(
      { display: true, style: initialStyle, tex: "x" },
      {},
      rendererVersion,
    );
    if (normalizedStyle === undefined) throw new TypeError("Invalid formula graphics style");
    this.#style = normalizedStyle;
    this.#cache =
      options.cache ??
      options.rasterCache ??
      new FormulaRasterCache(options.renderer ?? latexFormulaRasterRenderer, options.cacheOptions);
  }

  public get capability(): FormulaGraphicsCapability {
    return this.#capability;
  }

  /** The central capability layer's selected protocol, or exact-source when graphics are unsafe. */
  public get rendererId(): FormulaRendererId {
    return this.#rendererSelection.id;
  }

  public get renderer(): FormulaRendererDescriptor {
    return this.#rendererSelection;
  }

  /** Current validated pixel-affecting style used by formula renders. */
  public get style(): FormulaRenderStyle {
    return this.#style;
  }

  /** Increments when a style update invalidates existing raster registrations. */
  public get styleRevision(): number {
    return this.#styleRevision;
  }

  /**
   * Update the style without remounting the runtime. Existing registrations and placements are
   * removed, in-flight renders are aborted, and subscribed FormulaGraphic nodes rerender against a
   * cache key containing the new style and renderer version. Invalid styles fail closed.
   */
  public setStyle(style: FormulaRenderStyle): boolean {
    if (this.#disposed) return false;
    const normalized = normalizeFormulaRenderStyle(
      { display: true, style, tex: "x" },
      {},
      this.#style.rendererVersion,
    );
    if (normalized === undefined || sameFormulaStyle(this.#style, normalized)) return false;
    this.#style = normalized;
    this.#styleRevision += 1;
    this.#generation += 1;
    this.#snapshot = undefined;
    this.#registrations.clear();
    this.#visibleKeys.clear();
    this.#visibleRegistrations.clear();
    for (const controller of this.#controllers) controller.abort();
    this.#controllers.clear();
    this.#scheduleAllPlacementCleanup();
    this.#notify();
    try {
      this.#requestFrame?.();
    } catch {
      // A frame scheduler belongs to the embedding lifecycle and cannot invalidate the style.
    }
    return true;
  }

  /** Descriptive alias for integrations that call theme changes an update. */
  public updateStyle(style: FormulaRenderStyle): boolean {
    return this.setStyle(style);
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
    // The live overlay owns Kitty/Sixel placement bytes. iTerm2 remains available to the one-shot
    // renderer, but without a live placement implementation it must stay exact-source here.
    return (
      (this.#rendererSelection.id === "kitty" || this.#rendererSelection.id === "sixel") &&
      this.#cellPixels() !== undefined
    );
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
    const style = request.style ?? options.style ?? this.#style;
    return this.#cache.render(
      { display: request.display, style, tex: request.tex },
      { ...options, style },
    );
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
    try {
      this.#requestFrame?.();
    } catch {
      // A frame scheduler belongs to the embedding lifecycle and cannot invalidate registration.
    }
    return true;
  }

  public unregister(key: string, ref?: FormulaGraphicsRefLike): boolean {
    const current = this.#registrations.get(key);
    if (current === undefined) return false;
    if (ref !== undefined && resolveRef(ref) !== current.refNode) return false;
    this.#registrations.delete(key);
    this.#visibleKeys.delete(key);
    this.#visibleRegistrations.delete(key);
    for (const placed of this.#placed) {
      if (placed.placement.placementKey === key) this.#pendingCleanup.add(placed);
    }
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
    // A prior fallback frame has already exposed exact source. Only then is it safe to remove a
    // placement that was not replaced. While a write is blocked, retain the confirmed image so a
    // stale generation cannot leave the FormulaGraphic source suppressed over a blank terminal.
    if (!this.#afterFrameBusy) this.#flushPendingPlacementCleanup();

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
        if (!isContainedByClip(metrics, cellSize, clipMetrics)) continue;
        if (registration.raster.png.byteLength > this.#maxFrameBytes) continue;
        formulas.push({ cellSize, metrics, registration });
      }
    }
    const retainedKeys = new Set<string>();
    for (const formula of formulas) {
      if (
        this.#visibleKeys.has(formula.registration.key) &&
        this.#visibleRegistrations.get(formula.registration.key) === formula.registration
      ) {
        retainedKeys.add(formula.registration.key);
      }
    }
    for (const placed of this.#placed) {
      if (!retainedKeys.has(placed.placement.placementKey)) this.#pendingCleanup.add(placed);
    }
    this.#snapshot = { generation: this.#generation, formulas };
    // Preserve already-successful graphical boxes that remain eligible. New/unproven formulas
    // remain exact-source until this generation's protocol write succeeds.
    this.#setVisibleKeys(retainedKeys);
    return this.#generation;
  }

  /**
   * Emit a snapshot after the caller confirms Ink's frame flush. Calls are serialized and stale
   * generations are discarded before every write, so a resize/scroll cannot leak old placement.
   */
  public afterFrame(generation: number, inkFlush?: PromiseLike<unknown> | boolean): Promise<void> {
    const run = async (): Promise<void> => {
      if (inkFlush === false) {
        this.#fallbackSnapshot(generation);
        return;
      }
      if (inkFlush !== undefined && typeof inkFlush !== "boolean") {
        try {
          await inkFlush;
        } catch {
          this.#fallbackSnapshot(generation);
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
    this.#visibleRegistrations.clear();
    this.#snapshot = undefined;
    this.#pendingCleanup.clear();
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
    if (this.#disposed || generation !== this.#generation) return;
    if (this.#writeBroken) {
      this.#fallbackSnapshot(generation);
      return;
    }
    const snapshot = this.#snapshot;
    if (snapshot === undefined || snapshot.generation !== generation) return;

    const previousByKey = new Map<string, PlacedFormula>();
    for (const placed of this.#placed) previousByKey.set(placed.placement.placementKey, placed);
    let frameBytes = 0;
    for (const item of snapshot.formulas) {
      if (this.#disposed || generation !== this.#generation) return;
      if (this.#registrations.get(item.registration.key) !== item.registration) {
        this.#setVisible(item.registration.key, false);
        continue;
      }
      const previous = previousByKey.get(item.registration.key);
      const built = this.#buildPlacement(item, frameBytes);
      if (built === undefined) {
        // A confirmed placement is safer than suppressing source while a replacement cannot be
        // emitted. A changed registration cannot reuse the old pixels, so it remains source-only
        // and its old placement is cleaned after that source frame is visible.
        if (
          previous !== undefined &&
          this.#visibleKeys.has(item.registration.key) &&
          this.#visibleRegistrations.get(item.registration.key) === item.registration
        ) {
          continue;
        }
        if (previous !== undefined) this.#pendingCleanup.add(previous);
        this.#setVisible(item.registration.key, false);
        continue;
      }
      const placed: PlacedFormula =
        built.protocol === "kitty"
          ? { placement: built.placement, protocol: "kitty" }
          : { placement: built.placement, protocol: "sixel" };
      const sequence = this.#replacementSequence(previous, built.sequence);
      if (
        sequence === undefined ||
        !withinFrameBudget(frameBytes, sequence.length, this.#maxFrameBytes)
      ) {
        // Keep the prior confirmed image in place when a replacement would exceed a protocol or
        // frame bound. It is preferable to exact source being temporarily hidden over nothing.
        if (
          previous === undefined ||
          !this.#visibleKeys.has(item.registration.key) ||
          this.#visibleRegistrations.get(item.registration.key) !== item.registration
        ) {
          if (previous !== undefined) this.#pendingCleanup.add(previous);
          this.#setVisible(item.registration.key, false);
        }
        continue;
      }
      frameBytes += sequence.length;
      // Track before the write can yield on backpressure. A resize/dispose can therefore clear an
      // image whose stdout.write returned false, while generation-aware queued writes are skipped.
      this.#placed.push(placed);
      try {
        const result = await this.#queueWrite(sequence, generation);
        if (result === "stale") {
          this.#removePlaced(placed);
          // A newer beforeFrame owns visibility now; an old stale continuation must not clear it.
          if (generation === this.#generation && previous === undefined) {
            this.#setVisible(item.registration.key, false);
          }
          continue;
        }
      } catch {
        this.#removePlaced(placed);
        if (previous !== undefined) this.#pendingCleanup.add(previous);
        this.#fallbackSnapshot(generation);
        return;
      }
      if (this.#disposed || generation !== this.#generation) {
        this.#pendingCleanup.add(placed);
        return;
      }
      this.#confirmReplacement(previous, placed);
      this.#setVisible(item.registration.key, true, item.registration);
    }
  }

  #buildPlacement(item: SnapshotFormula, frameBytes: number): BuiltPlacement | undefined {
    const row = item.metrics.y + 1;
    const column = item.metrics.x + 1;
    if (this.#rendererSelection.id === "kitty") {
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

    if (this.#rendererSelection.id !== "sixel") return undefined;
    const encoded = encodeSixel({
      ...item.registration.raster,
      ...(this.#style.background === undefined ? {} : { background: this.#style.background }),
    });
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
    if (this.#rendererSelection.id === "kitty") {
      const capability = this.#capability as FormulaGraphicsCapability & {
        readonly evidence?: Readonly<{
          readonly kittyResponse?: Readonly<{ readonly explicitOk?: boolean }>;
          readonly cellPixels?: CellPixelDimensions;
        }>;
        readonly kittyResponse?: Readonly<{ readonly explicitOk?: boolean }>;
        readonly cellPixels?: CellPixelDimensions;
      };
      const explicit =
        capability.kittyResponse?.explicitOk ?? capability.evidence?.kittyResponse?.explicitOk;
      if (explicit === false) return undefined;
      const returned = capability.cellPixels ?? capability.evidence?.cellPixels;
      return isCellPixels(returned) ? returned : undefined;
    }
    if (this.#rendererSelection.id === "sixel") {
      const capability = this.#capability as FormulaGraphicsCapability & {
        readonly cellPixels?: CellPixelDimensions;
        readonly evidence?: Readonly<{ readonly cellPixels?: CellPixelDimensions }>;
      };
      const cellPixels = capability.cellPixels ?? capability.evidence?.cellPixels;
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
    this.#pendingCleanup.delete(target);
  }

  #replacementSequence(previous: PlacedFormula | undefined, sequence: string): string | undefined {
    if (previous === undefined || previous.protocol !== "sixel") return sequence;
    const clear = sixelClearSequence(previous.placement);
    if (clear === undefined) return undefined;
    // Sixel has no image identity. Clear and replacement must cross the stream in this order as a
    // single queued write, so backpressure cannot expose a blank interval between them.
    return clear + sequence;
  }

  #confirmReplacement(previous: PlacedFormula | undefined, replacement: PlacedFormula): void {
    if (previous === undefined || previous === replacement) return;
    if (previous.protocol === "kitty") {
      const sequence = kittyDeleteById(previous.placement.imageId);
      if (sequence !== undefined) this.#writeCleanupSynchronously(sequence);
    }
    // Sixel cleanup was ordered inside the replacement write. Kitty cleanup was emitted only after
    // the new image write completed, so either path now has one confirmed placement per key.
    this.#removePlaced(previous);
  }

  #scheduleAllPlacementCleanup(): void {
    for (const placed of this.#placed) this.#pendingCleanup.add(placed);
  }

  #flushPendingPlacementCleanup(): void {
    if (this.#writeBroken || this.#pendingCleanup.size === 0) return;
    for (const placed of [...this.#pendingCleanup]) {
      if (!this.#placed.includes(placed)) {
        this.#pendingCleanup.delete(placed);
        continue;
      }
      this.#clearPlacementSynchronously(placed);
    }
  }

  #clearPlacementSynchronously(placed: PlacedFormula): void {
    if (this.#writeBroken) return;
    if (placed.protocol === "kitty") {
      const sequence = kittyDeleteById(placed.placement.imageId);
      if (sequence !== undefined) this.#writeCleanupSynchronously(sequence);
    } else {
      const sequence = sixelClearSequence(placed.placement);
      if (sequence !== undefined) this.#writeCleanupSynchronously(sequence);
    }
    this.#removePlaced(placed);
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
    this.#pendingCleanup.clear();
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

  #fallbackSnapshot(generation: number): void {
    if (this.#disposed || generation !== this.#generation) return;
    const snapshot = this.#snapshot;
    if (snapshot === undefined || snapshot.generation !== generation) return;
    for (const formula of snapshot.formulas) {
      for (const placed of this.#placed) {
        if (placed.placement.placementKey === formula.registration.key) {
          this.#pendingCleanup.add(placed);
        }
      }
      this.#setVisible(formula.registration.key, false);
    }
  }

  #setVisible(key: string, visible: boolean, registration?: RegisteredFormula): void {
    const had = this.#visibleKeys.has(key);
    const sameRegistration =
      !visible ||
      registration === undefined ||
      this.#visibleRegistrations.get(key) === registration;
    if (had === visible && sameRegistration) return;
    if (visible) {
      this.#visibleKeys.add(key);
      if (registration !== undefined) this.#visibleRegistrations.set(key, registration);
    } else {
      this.#visibleKeys.delete(key);
      this.#visibleRegistrations.delete(key);
    }
    this.#notify();
  }

  #setVisibleKeys(keys: Set<string>): void {
    for (const key of this.#visibleRegistrations.keys()) {
      if (!keys.has(key)) this.#visibleRegistrations.delete(key);
    }
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
  /** Stable response/message budget shared by every formula slot in the assistant entry. */
  readonly renderBudget?: LatexRenderBudget;
  /** Explicit validated style for this raster; runtime style is used when omitted. */
  readonly renderStyle?: FormulaRenderStyle;
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
  const styleRevision = React.useSyncExternalStore(
    (listener) => props.runtime.subscribe(listener),
    () => props.runtime.styleRevision,
    () => 0,
  );
  const visible = React.useSyncExternalStore(
    (listener) => props.runtime.subscribe(listener),
    () => props.runtime.isVisible(formulaKey),
    () => false,
  );
  const renderStyle = props.renderStyle;

  // styleRevision is an external-store invalidation token. It intentionally reruns this effect
  // even though the render request itself only captures the validated style object.
  // biome-ignore lint/correctness/useExhaustiveDependencies: styleRevision invalidates the raster without changing props
  React.useEffect(() => {
    setOutcome(undefined);
    if (!supported || props.runtime.disposed || tex.length === 0) return undefined;
    const controller = new AbortController();
    const release = props.runtime.trackRender(controller);
    let mounted = true;
    void props.runtime
      .renderFormula(
        {
          display,
          ...(renderStyle === undefined ? {} : { style: renderStyle }),
          tex,
        },
        {
          ...(props.renderBudget === undefined ? {} : { budget: props.renderBudget }),
          signal: controller.signal,
        },
      )
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
  }, [display, props.renderBudget, props.runtime, renderStyle, styleRevision, supported, tex]);

  const raster = outcome?.ok === true ? outcome.raster : undefined;
  const cellSize = raster === undefined ? undefined : props.runtime.cellSize(raster);
  const cellWidth = cellSize?.width;
  const cellHeight = cellSize?.height;
  const placeable = raster !== undefined && cellSize !== undefined && visible;

  React.useLayoutEffect(() => {
    if (
      raster === undefined ||
      cellWidth === undefined ||
      cellHeight === undefined ||
      props.runtime.disposed
    ) {
      return undefined;
    }
    const accepted = props.runtime.register({
      clipRef: props.clipRef,
      key: formulaKey,
      raster,
      ref,
    });
    return () => {
      if (accepted) props.runtime.unregister(formulaKey, ref);
    };
  }, [cellHeight, cellWidth, formulaKey, props.clipRef, props.runtime, raster]);

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

/** Adapt the legacy/minimal runtime seam while keeping protocol precedence centralized. */
function rendererCapabilityInput(
  capability: FormulaGraphicsCapability,
): TerminalCapabilities | TerminalCapability | TerminalCapabilityProbeResult {
  if (isTerminalCapabilities(capability)) return capability;
  if (isTerminalCapabilityProbeResult(capability)) return capability;
  if ("reason" in capability && capability.reason !== undefined) {
    return { protocol: capability.protocol, reason: capability.reason };
  }
  return createTerminalCapabilities({
    protocol: capability.protocol,
    reason: capability.reason ?? "runtime capability input",
  });
}

function isTerminalCapabilities(value: FormulaGraphicsCapability): value is TerminalCapabilities {
  return "kittyGraphics" in value && "sixel" in value && "itermImages" in value;
}

function isTerminalCapabilityProbeResult(
  value: FormulaGraphicsCapability,
): value is TerminalCapabilityProbeResult {
  return "timedOut" in value && "replay" in value;
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
  cellSize: ImageCellSize,
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
    metrics.x + cellSize.width <= clip.x + clip.width &&
    metrics.y + cellSize.height <= clip.y + clip.height
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

function sameFormulaStyle(
  left: NormalizedFormulaRenderStyle,
  right: NormalizedFormulaRenderStyle,
): boolean {
  return (
    left.background === right.background &&
    left.dpi === right.dpi &&
    left.fontScale === right.fontScale &&
    left.foreground === right.foreground &&
    left.rendererVersion === right.rendererVersion
  );
}
