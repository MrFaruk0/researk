import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { dataDirs } from "./paths.js";

export interface CredentialStore {
  get(ref: string): Promise<string | null>;
  set(ref: string, secret: string): Promise<void>;
  delete(ref: string): Promise<void>;
}

/** Maps a credential reference to a safe filename inside the credentials directory. */
function credentialFileName(ref: string): string {
  return `${encodeURIComponent(ref)}.txt`;
}

/** A display-only mask for toString/log output. The real value is never written. */
export function maskCredential(_secret: string): string {
  return "••••••••";
}

/**
 * File-backed credential storage, one plaintext file per reference.
 *
 * SECURITY WARNING: this is NOT secure storage. Credentials are stored as plaintext on disk, so
 * anyone with access to the user's home directory can read them. Per ADR 0003 the OS credential
 * store is the intended long-term backend; this file store exists as the explicit, documented
 * fallback for automation and local-first development. Never use it for high-value secrets, never
 * put it behind a backup or log pipeline, and prefer an operating-system keychain where possible.
 */
export class FileCredentialStore implements CredentialStore {
  readonly #directory: string;

  constructor(directory?: string) {
    this.#directory = directory ?? defaultCredentialsDirectory();
  }

  async get(ref: string): Promise<string | null> {
    try {
      return await readFile(path.join(this.#directory, credentialFileName(ref)), "utf8");
    } catch (error) {
      if (isNodeError(error) && (error.code === "ENOENT" || error.code === "EACCES")) {
        return null;
      }
      throw error;
    }
  }

  async set(ref: string, secret: string): Promise<void> {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    const file = path.join(this.#directory, credentialFileName(ref));
    const tmp = `${file}.${randomUUID()}.tmp`;
    await writeFile(tmp, secret, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(tmp, file);
  }

  async delete(ref: string): Promise<void> {
    await rm(path.join(this.#directory, credentialFileName(ref)), { force: true });
  }

  toString(): string {
    return `FileCredentialStore(directory=${this.#directory}, credentials=MASKED)`;
  }
}

function defaultCredentialsDirectory(): string {
  const dirs = dataDirs();
  if (dirs === null) {
    throw new Error(
      "Researk credentials directory cannot be resolved: no APPDATA, HOME, or XDG_DATA_HOME is set.",
    );
  }
  return dirs.credentials;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
