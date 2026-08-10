import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/** Version of the on-disk config format. Bump it when the layout changes incompatibly. */
export const CURRENT_SCHEMA_VERSION = 1;

/** The JSON key that carries the format version of a stored file. */
export const SCHEMA_VERSION_KEY = "schemaVersion";

/**
 * The queue is keyed by the final target path rather than by a store instance. That keeps two
 * in-process stores opened for the same file from interleaving writes while allowing unrelated
 * files to proceed independently.
 */
const writeQueues = new Map<string, Promise<void>>();

export interface ConfigStore<T extends { readonly [SCHEMA_VERSION_KEY]: number }> {
  load(defaults: T): Promise<T>;
  save(value: T): Promise<void>;
}

/** Produces the base config filename for a store name, e.g. `app` -> `app.json`. */
export function configFileName(name: string): string {
  return `${name}.json`;
}

/**
 * Reads a stored JSON object without requiring a schema key, so partial files and legacy files can
 * be inspected before merging. `null` means the file does not exist.
 */
export async function readConfigJson(filePath: string): Promise<Record<string, unknown> | null> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    throw error;
  }
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Config file is not a JSON object: ${filePath}`);
  }
  return parsed as Record<string, unknown>;
}

/**
 * Versioned config persistence:
 *
 * - `load` merges the saved JSON over the supplied defaults, keeping saved values where present.
 * - A stored `schemaVersion` greater than the current version triggers a migration attempt. Real
 *   migrations are not implemented yet, so an unsupported version returns the supplied defaults
 *   and logs a warning instead of failing or silently corrupting the saved file.
 * - `save` writes atomically: the value is written to a temporary sibling file which is then
 *   renamed over the target, so a crash cannot leave a truncated config behind.
 */
export class FileConfigStore<T extends { readonly [SCHEMA_VERSION_KEY]: number }>
  implements ConfigStore<T>
{
  readonly #filePath: string;
  readonly #warn: (message: string) => void;

  constructor(directory: string, name: string, warn: (message: string) => void = console.warn) {
    this.#filePath = path.join(directory, configFileName(name));
    this.#warn = warn;
  }

  async load(defaults: T): Promise<T> {
    const saved = await readConfigJson(this.#filePath);
    if (saved === null) return { ...defaults };
    if (unsupportedSchemaVersion(saved)) {
      this.#warn(
        `Config ${path.basename(this.#filePath)} has unsupported schemaVersion ` +
          `${String(saved[SCHEMA_VERSION_KEY])}; ignoring it and using defaults. ` +
          `Researk will re-save with the current format on the next write.`,
      );
      return { ...defaults };
    }
    return { ...defaults, ...saved } as T;
  }

  async save(value: T): Promise<void> {
    return enqueueWrite(this.#filePath, () => writeJsonAtomically(this.#filePath, value));
  }

  /** Removes the stored file. Used by the credential store for deletes. */
  async remove(): Promise<void> {
    return enqueueWrite(this.#filePath, () => rm(this.#filePath, { force: true }));
  }
}

/** Runs an operation after all earlier operations for the same target have settled. */
function enqueueWrite<T>(targetPath: string, operation: () => Promise<T>): Promise<T> {
  const previous = writeQueues.get(targetPath) ?? Promise.resolve();
  const result = previous.then(operation);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  writeQueues.set(targetPath, tail);
  void tail.then(() => {
    if (writeQueues.get(targetPath) === tail) writeQueues.delete(targetPath);
  });
  return result;
}

/** Writes a JSON value to a unique sibling temporary file before atomically replacing the target. */
async function writeJsonAtomically(filePath: string, value: unknown): Promise<void> {
  const directory = path.dirname(filePath);
  const temporaryPath = path.join(directory, `${path.basename(filePath)}.${randomUUID()}.tmp`);
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    await rename(temporaryPath, filePath);
  } finally {
    // Once rename succeeds the path is gone; when any earlier step fails this removes a partial
    // temporary file without masking the original persistence error.
    await rm(temporaryPath, { force: true }).catch(() => {});
  }
}

function unsupportedSchemaVersion(value: Record<string, unknown>): boolean {
  const version = value[SCHEMA_VERSION_KEY];
  return (
    typeof version === "number" && Number.isInteger(version) && version > CURRENT_SCHEMA_VERSION
  );
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
