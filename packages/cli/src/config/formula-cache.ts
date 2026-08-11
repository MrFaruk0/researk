import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { dataDirs } from "./paths.js";

/** The on-disk record format. It contains no formula source, only a digest of the cache key. */
export const FORMULA_CACHE_SCHEMA_VERSION = 1;

/** A deliberately conservative file ceiling protects reads before JSON parsing allocates data. */
export const MAX_FORMULA_CACHE_FILE_BYTES = 64 * 1024 * 1024;
export const DEFAULT_FORMULA_CACHE_MAX_ENTRIES = 128;
export const DEFAULT_FORMULA_CACHE_MAX_BYTES = 128 * 1024 * 1024;

const MAX_FORMULA_CACHE_ENTRIES = 512;
const MAX_FORMULA_CACHE_BYTES = 512 * 1024 * 1024;
const MAX_PNG_BYTES = 8 * 1024 * 1024;
const MAX_RASTER_WIDTH = 4096;
const MAX_RASTER_HEIGHT = 2048;
const MAX_RASTER_AREA = 8_388_608;
const MAX_RGBA_BYTES = MAX_RASTER_AREA * 4;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const ENTRY_SUFFIX = ".json";

/** The raster shape is repeated here to keep this storage module independent of TUI code. */
export interface FormulaRasterCacheRecord {
  readonly height: number;
  readonly pixels: Uint8Array;
  readonly png: Uint8Array;
  readonly width: number;
}

/** Injectable persistence seam used by the in-memory formula cache. */
export interface FormulaRasterStore {
  get(key: string): Promise<FormulaRasterCacheRecord | undefined>;
  set(key: string, raster: FormulaRasterCacheRecord): Promise<void>;
  delete?(key: string): Promise<void>;
}

export interface FormulaRasterStoreOptions {
  /** Dedicated per-user directory. It must not be a workspace or session directory. */
  readonly directory: string;
  readonly maxEntries?: number;
  readonly maxBytes?: number;
}

export interface UserFormulaRasterStoreOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly maxEntries?: number;
  readonly maxBytes?: number;
}

/** Resolves the dedicated formula-render cache beneath Researk's per-user cache directory. */
export function formulaRasterCacheDirectory(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const dirs = dataDirs(env);
  return dirs === null ? undefined : path.join(dirs.cache, "formula-raster");
}

/**
 * Creates the production store, or returns undefined when the host has no usable per-user data
 * root. The caller can then continue with the bounded in-memory cache and exact-source fallback.
 */
export function createUserFormulaRasterStore(
  options: UserFormulaRasterStoreOptions = {},
): PersistentFormulaRasterStore | undefined {
  const directory = formulaRasterCacheDirectory(options.env);
  return directory === undefined
    ? undefined
    : new PersistentFormulaRasterStore({
        directory,
        ...(options.maxEntries === undefined ? {} : { maxEntries: options.maxEntries }),
        ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
      });
}

/**
 * A bounded, corruption-tolerant file store for raster output.
 *
 * Files are named by SHA-256(key), never by TeX. Each write uses a private temporary file followed
 * by rename, and malformed/oversized entries are discarded on read. The store is intentionally
 * independent of conversation/session persistence.
 */
export class PersistentFormulaRasterStore implements FormulaRasterStore {
  readonly #directory: string;
  readonly #maxBytes: number;
  readonly #maxEntries: number;

  public constructor(options: FormulaRasterStoreOptions) {
    this.#directory = path.resolve(options.directory);
    this.#maxEntries = boundedOption(
      options.maxEntries,
      DEFAULT_FORMULA_CACHE_MAX_ENTRIES,
      MAX_FORMULA_CACHE_ENTRIES,
    );
    this.#maxBytes = boundedOption(
      options.maxBytes,
      DEFAULT_FORMULA_CACHE_MAX_BYTES,
      MAX_FORMULA_CACHE_BYTES,
    );
  }

  public async get(key: string): Promise<FormulaRasterCacheRecord | undefined> {
    const filePath = this.#filePath(key);
    let bytes: Uint8Array;
    try {
      const details = await stat(filePath);
      if (!details.isFile() || details.size < 1 || details.size > MAX_FORMULA_CACHE_FILE_BYTES) {
        await this.#discard(filePath);
        return undefined;
      }
      bytes = await readFile(filePath);
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === "ENOENT") return undefined;
      return undefined;
    }

    if (bytes.byteLength < 1 || bytes.byteLength > MAX_FORMULA_CACHE_FILE_BYTES) {
      await this.#discard(filePath);
      return undefined;
    }

    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const value: unknown = JSON.parse(text);
      const raster = decodeRecord(value, digestKey(key));
      if (raster === undefined) await this.#discard(filePath);
      return raster;
    } catch {
      await this.#discard(filePath);
      return undefined;
    }
  }

  public async set(key: string, raster: FormulaRasterCacheRecord): Promise<void> {
    const digest = digestKey(key);
    const encoded = encodeRecord(digest, raster);
    if (encoded === undefined) return;

    const bytes = Buffer.from(`${JSON.stringify(encoded)}\n`, "utf8");
    if (bytes.byteLength > MAX_FORMULA_CACHE_FILE_BYTES || bytes.byteLength > this.#maxBytes)
      return;

    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    await makePrivate(this.#directory, 0o700);
    const filePath = this.#filePathFromDigest(digest);
    const temporaryPath = path.join(
      this.#directory,
      `.${path.basename(filePath)}.${randomUUID()}.tmp`,
    );
    try {
      await writeFile(temporaryPath, bytes, { flag: "wx", mode: 0o600 });
      await makePrivate(temporaryPath, 0o600);
      await rename(temporaryPath, filePath);
      await makePrivate(filePath, 0o600);
      await this.#prune();
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }

  public async delete(key: string): Promise<void> {
    await this.#discard(this.#filePath(key));
  }

  get directory(): string {
    return this.#directory;
  }

  #filePath(key: string): string {
    return this.#filePathFromDigest(digestKey(key));
  }

  #filePathFromDigest(digest: string): string {
    return path.join(this.#directory, `${digest}${ENTRY_SUFFIX}`);
  }

  async #discard(filePath: string): Promise<void> {
    await rm(filePath, { force: true }).catch(() => undefined);
  }

  async #prune(): Promise<void> {
    let names: string[];
    try {
      names = await readdir(this.#directory);
    } catch {
      return;
    }
    const entries: Array<{
      readonly name: string;
      readonly bytes: number;
      readonly mtimeMs: number;
    }> = [];
    for (const name of names) {
      if (
        !name.endsWith(ENTRY_SUFFIX) ||
        !DIGEST_PATTERN.test(name.slice(0, -ENTRY_SUFFIX.length))
      ) {
        continue;
      }
      try {
        const details = await stat(path.join(this.#directory, name));
        if (details.isFile()) entries.push({ name, bytes: details.size, mtimeMs: details.mtimeMs });
      } catch {
        // A concurrent cleanup is harmless; the next write will prune again.
      }
    }
    entries.sort(
      (left, right) => left.mtimeMs - right.mtimeMs || left.name.localeCompare(right.name),
    );
    let bytes = entries.reduce((total, entry) => total + entry.bytes, 0);
    while (entries.length > this.#maxEntries || bytes > this.#maxBytes) {
      const oldest = entries.shift();
      if (oldest === undefined) break;
      bytes -= oldest.bytes;
      await this.#discard(path.join(this.#directory, oldest.name));
    }
  }
}

interface DiskFormulaRaster {
  readonly height: number;
  readonly keyDigest: string;
  readonly pixels: string;
  readonly png: string;
  readonly schemaVersion: number;
  readonly width: number;
}

function encodeRecord(
  keyDigest: string,
  raster: FormulaRasterCacheRecord,
): DiskFormulaRaster | undefined {
  if (!isValidRaster(raster)) return undefined;
  return {
    height: raster.height,
    keyDigest,
    pixels: Buffer.from(raster.pixels).toString("base64"),
    png: Buffer.from(raster.png).toString("base64"),
    schemaVersion: FORMULA_CACHE_SCHEMA_VERSION,
    width: raster.width,
  };
}

function decodeRecord(
  value: unknown,
  expectedDigest: string,
): FormulaRasterCacheRecord | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const expectedKeys = ["height", "keyDigest", "pixels", "png", "schemaVersion", "width"];
  const keys = Object.keys(record);
  if (keys.length !== expectedKeys.length || !keys.every((key) => expectedKeys.includes(key))) {
    return undefined;
  }
  if (
    record.schemaVersion !== FORMULA_CACHE_SCHEMA_VERSION ||
    record.keyDigest !== expectedDigest ||
    typeof record.keyDigest !== "string" ||
    !DIGEST_PATTERN.test(record.keyDigest)
  ) {
    return undefined;
  }
  if (
    !isPositiveIntegerWithin(record.width, MAX_RASTER_WIDTH) ||
    !isPositiveIntegerWithin(record.height, MAX_RASTER_HEIGHT) ||
    typeof record.png !== "string" ||
    typeof record.pixels !== "string"
  ) {
    return undefined;
  }
  const png = decodeBase64(record.png, 1, MAX_PNG_BYTES);
  const pixels = decodeBase64(record.pixels, record.width * record.height * 4, MAX_RGBA_BYTES);
  if (png === undefined || pixels === undefined) return undefined;
  return {
    height: record.height,
    pixels: new Uint8Array(pixels),
    png: new Uint8Array(png),
    width: record.width,
  };
}

function decodeBase64(value: string, minimum: number, maximum: number): Buffer | undefined {
  if (value.length === 0 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(value)) {
    return undefined;
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.byteLength < minimum || bytes.byteLength > maximum) return undefined;
  return bytes.toString("base64") === value ? bytes : undefined;
}

function isValidRaster(value: FormulaRasterCacheRecord): boolean {
  if (
    !isPositiveIntegerWithin(value.width, MAX_RASTER_WIDTH) ||
    !isPositiveIntegerWithin(value.height, MAX_RASTER_HEIGHT) ||
    !(value.png instanceof Uint8Array) ||
    !(value.pixels instanceof Uint8Array) ||
    value.png.byteLength < 1 ||
    value.png.byteLength > MAX_PNG_BYTES
  ) {
    return false;
  }
  const area = value.width * value.height;
  return (
    area <= MAX_RASTER_AREA &&
    value.pixels.byteLength === area * 4 &&
    value.pixels.byteLength <= MAX_RGBA_BYTES
  );
}

function isPositiveIntegerWithin(value: unknown, maximum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= maximum;
}

function boundedOption(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(1, Math.trunc(value)));
}

function digestKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

async function makePrivate(filePath: string, mode: number): Promise<void> {
  await chmod(filePath, mode).catch(() => undefined);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
