import stringWidth from "string-width";
import { displayText } from "./state.js";

/** Terminal tabs are conventionally eight cells wide. Ink does not count them as a width. */
export const TAB_STOP_WIDTH = 8;

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const MAX_DISPLAY_LAYOUT_CHECKPOINTS = 4096;
const MAX_PAGE_ROWS = 8192;
const DISPLAY_LAYOUT_CACHE_SIZE = 4;

export interface DisplayPage {
  /** The first display row represented by `rows`. */
  readonly offset: number;
  /** The total number of display rows in the projected value. */
  readonly totalRows: number;
  /** At most a bounded number of rows; no complete source is retained in this result. */
  readonly rows: readonly string[];
}

/**
 * A memoized safe display layout. The layout retains one projected string and sparse row offsets,
 * never an unbounded array of row strings. Page extraction starts at the nearest checkpoint and
 * scans only the bounded interval to the requested page.
 */
export interface DisplayLayout {
  readonly width: number;
  readonly totalRows: number;
  page(offset?: number, limit?: number): DisplayPage;
}

interface LayoutCheckpoint {
  readonly row: number;
  readonly offset: number;
}

interface LayoutCacheEntry {
  readonly source: string;
  readonly width: number;
  readonly layout: DisplayLayout;
}

const displayLayoutCache: LayoutCacheEntry[] = [];

function finitePositiveInteger(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.trunc(value));
}

function nonNegativeInteger(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

function pageLimit(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(MAX_PAGE_ROWS, Math.max(0, Math.trunc(value)));
}

function segmentDisplayWidth(segment: string, startingColumn: number): number {
  if (segment === "\t") {
    return TAB_STOP_WIDTH - (startingColumn % TAB_STOP_WIDTH);
  }
  return Math.max(0, stringWidth(segment));
}

/** Returns a single display-cell width, with tabs measured against the current row column. */
export function displayCellWidth(value: string, startingColumn = 0): number {
  let column = Math.max(0, Math.trunc(startingColumn));
  for (const item of graphemeSegmenter.segment(value)) {
    column += segmentDisplayWidth(item.segment, column);
  }
  return column - Math.max(0, Math.trunc(startingColumn));
}

function countProjectedRows(value: string, width: number): number {
  let row = "";
  let column = 0;
  let totalRows = 0;
  const emitRow = (): void => {
    totalRows += 1;
    row = "";
    column = 0;
  };

  for (const item of graphemeSegmenter.segment(value)) {
    const segment = item.segment;
    if (segment === "\n") {
      emitRow();
      continue;
    }
    const widthForSegment = segmentDisplayWidth(segment, column);
    if (row.length > 0 && column + widthForSegment > width) emitRow();
    row += segment;
    column += widthForSegment;
  }
  emitRow();
  return totalRows;
}

function buildCheckpoints(
  value: string,
  width: number,
  totalRows: number,
): readonly LayoutCheckpoint[] {
  const stride = Math.max(1, Math.ceil(totalRows / MAX_DISPLAY_LAYOUT_CHECKPOINTS));
  const checkpoints: LayoutCheckpoint[] = [{ row: 0, offset: 0 }];
  let row = "";
  let column = 0;
  let rowIndex = 0;

  const checkpointAfter = (offset: number): void => {
    if (rowIndex === 0 || rowIndex % stride !== 0) return;
    if (checkpoints.length <= MAX_DISPLAY_LAYOUT_CHECKPOINTS) {
      checkpoints.push({ row: rowIndex, offset });
    }
  };
  const emitRow = (nextOffset: number): void => {
    rowIndex += 1;
    row = "";
    column = 0;
    checkpointAfter(nextOffset);
  };

  for (const item of graphemeSegmenter.segment(value)) {
    const segment = item.segment;
    if (segment === "\n") {
      emitRow(item.index + segment.length);
      continue;
    }
    const widthForSegment = segmentDisplayWidth(segment, column);
    if (row.length > 0 && column + widthForSegment > width) {
      emitRow(item.index);
    }
    row += segment;
    column += widthForSegment;
  }
  emitRow(value.length);
  return checkpoints;
}

function findCheckpoint(checkpoints: readonly LayoutCheckpoint[], row: number): LayoutCheckpoint {
  let low = 0;
  let high = checkpoints.length - 1;
  let best = checkpoints[0] ?? { row: 0, offset: 0 };
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = checkpoints[middle];
    if (candidate === undefined) break;
    if (candidate.row <= row) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best;
}

function extractProjectedPage(
  value: string,
  width: number,
  checkpoints: readonly LayoutCheckpoint[],
  totalRows: number,
  requestedOffset: number,
  requestedLimit: number,
): DisplayPage {
  const requested = nonNegativeInteger(requestedOffset);
  const limit = pageLimit(requestedLimit);
  if (limit === 0) {
    return {
      offset: Math.min(requested, totalRows),
      totalRows,
      rows: [],
    };
  }

  const offset = Math.min(requested, Math.max(0, totalRows - limit));
  const checkpoint = findCheckpoint(checkpoints, offset);
  const suffix = value.slice(checkpoint.offset);
  const rows: string[] = [];
  let row = "";
  let column = 0;
  let rowIndex = checkpoint.row;
  let stopped = false;
  const endRow = offset + limit;

  const emitRow = (): void => {
    if (rowIndex >= offset && rows.length < limit) rows.push(row);
    rowIndex += 1;
    row = "";
    column = 0;
    if (rowIndex >= endRow) stopped = true;
  };

  for (const item of graphemeSegmenter.segment(suffix)) {
    if (stopped) break;
    const segment = item.segment;
    if (segment === "\n") {
      emitRow();
      continue;
    }
    const widthForSegment = segmentDisplayWidth(segment, column);
    if (row.length > 0 && column + widthForSegment > width) {
      emitRow();
      if (stopped) break;
    }
    row += segment;
    column += widthForSegment;
  }
  if (!stopped) emitRow();

  return { offset, totalRows, rows };
}

function buildDisplayLayout(projected: string, width: number): DisplayLayout {
  const totalRows = countProjectedRows(projected, width);
  const checkpoints = buildCheckpoints(projected, width, totalRows);
  return Object.freeze({
    width,
    totalRows,
    page: (offset = 0, limit = 1): DisplayPage =>
      extractProjectedPage(projected, width, checkpoints, totalRows, offset, limit),
  });
}

/** Returns the bounded cached layout for one canonical source and display width. */
export function getDisplayLayout(source: string, width: number): DisplayLayout {
  const normalizedWidth = finitePositiveInteger(width, 1);
  const hit = displayLayoutCache.findIndex(
    (entry) => entry.source === source && entry.width === normalizedWidth,
  );
  if (hit >= 0) {
    const entry = displayLayoutCache.splice(hit, 1)[0];
    if (entry !== undefined) displayLayoutCache.unshift(entry);
    return entry?.layout ?? buildDisplayLayout(displayText(source), normalizedWidth);
  }

  const entry: LayoutCacheEntry = {
    source,
    width: normalizedWidth,
    layout: buildDisplayLayout(displayText(source), normalizedWidth),
  };
  displayLayoutCache.unshift(entry);
  if (displayLayoutCache.length > DISPLAY_LAYOUT_CACHE_SIZE) displayLayoutCache.pop();
  return entry.layout;
}

/** Paginates an already terminal-safe projection without retaining an unbounded row array. */
export function paginateRenderedText(
  value: string,
  width: number,
  offset = 0,
  limit = 1,
): DisplayPage {
  const maxWidth = finitePositiveInteger(width, 1);
  const requested = nonNegativeInteger(offset);
  const requestedLimit = pageLimit(limit);
  let row = "";
  let column = 0;
  let rowIndex = 0;
  const requestedRows: string[] = [];
  const tailRows: string[] = [];

  const emitRow = (): void => {
    if (rowIndex >= requested && requestedRows.length < requestedLimit) requestedRows.push(row);
    if (requestedLimit > 0) {
      tailRows.push(row);
      if (tailRows.length > requestedLimit) tailRows.shift();
    }
    rowIndex += 1;
    row = "";
    column = 0;
  };

  for (const item of graphemeSegmenter.segment(value)) {
    const segment = item.segment;
    if (segment === "\n") {
      emitRow();
      continue;
    }
    const widthForSegment = segmentDisplayWidth(segment, column);
    if (row.length > 0 && column + widthForSegment > maxWidth) emitRow();
    row += segment;
    column += widthForSegment;
  }
  emitRow();

  const totalRows = rowIndex;
  const effectiveOffset = Math.min(requested, Math.max(0, totalRows - requestedLimit));
  const rows = effectiveOffset === requested ? requestedRows : tailRows;
  return { offset: effectiveOffset, totalRows, rows };
}

/** Projects untrusted canonical text once per cached source/width, then extracts one page. */
export function paginateDisplayText(
  value: string,
  width: number,
  offset = 0,
  limit = 1,
): DisplayPage {
  return getDisplayLayout(value, width).page(offset, limit);
}

/** Measures rows for a rendered composer string without retaining the wrapped rows. */
export function renderedRowCount(value: string, width: number): number {
  return paginateRenderedText(value, width, 0, 0).totalRows;
}

/** Measures the source's safe display projection using the cached layout. */
export function displayRowCount(value: string, width: number): number {
  return getDisplayLayout(value, width).totalRows;
}
