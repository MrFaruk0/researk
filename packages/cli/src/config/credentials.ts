import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { dataDirs } from "./paths.js";

export interface CredentialStore {
  get(ref: string): Promise<string | null>;
  set(ref: string, secret: string): Promise<void>;
  delete(ref: string): Promise<void>;
}

/**
 * The narrow native-keyring surface used by Researk. Keeping this interface local means tests can
 * provide an in-memory entry factory and the rest of the CLI never needs to import a platform
 * binding directly.
 */
export interface KeyringEntry {
  getPassword(): string | null | undefined;
  setPassword(password: string): void;
  deletePassword(): boolean | unknown;
}

export interface KeyringModule {
  readonly Entry: new (service: string, account: string) => KeyringEntry;
}

export type KeyringModuleLoader = () => Promise<KeyringModule>;

export const RESEARK_KEYRING_SERVICE = "Researk";

/** A safe, user-facing error for a credential backend that cannot be used. */
export class CredentialStoreUnavailableError extends Error {
  readonly code = "credential_store_unavailable";

  constructor(message = DEFAULT_UNAVAILABLE_MESSAGE) {
    super(message);
    this.name = "CredentialStoreUnavailableError";
  }
}

export const DEFAULT_UNAVAILABLE_MESSAGE =
  "OS secure credential storage is unavailable; configure the provider's environment variable or enable a system keychain.";

/**
 * Native keyring-backed credential storage. `@napi-rs/keyring` uses Windows Credential Manager,
 * macOS Keychain, and the platform Secret Service where available. The account is namespaced by a
 * fixed service and a caller-provided stable reference; secret values never reach this class's
 * errors or string representations.
 */
export class KeyringCredentialStore implements CredentialStore {
  readonly #Entry: KeyringModule["Entry"];
  readonly #service: string;

  constructor(Entry: KeyringModule["Entry"], options: Readonly<{ service?: string }> = {}) {
    this.#Entry = Entry;
    this.#service = options.service ?? RESEARK_KEYRING_SERVICE;
  }

  /** Performs a harmless read so startup can distinguish an unusable native backend. */
  probe(): void {
    this.#entry("__probe__").getPassword();
  }

  async get(ref: string): Promise<string | null> {
    try {
      const value = this.#entry(ref).getPassword();
      return value === undefined || value === null ? null : value;
    } catch {
      // An unavailable or locked keychain is not fatal to startup: callers can use the explicit
      // environment fallback. Do not expose native error text because some backends include account
      // names or other sensitive metadata.
      return null;
    }
  }

  async set(ref: string, secret: string): Promise<void> {
    if (secret.length === 0) {
      throw new CredentialStoreUnavailableError("Cannot persist an empty provider credential.");
    }
    try {
      this.#entry(ref).setPassword(secret);
    } catch {
      throw new CredentialStoreUnavailableError();
    }
  }

  async delete(ref: string): Promise<void> {
    try {
      this.#entry(ref).deletePassword();
    } catch {
      // Deletion is intentionally idempotent. A missing or unavailable keychain must not make
      // removing a provider profile fail, and native error details are not safe to surface.
    }
  }

  toString(): string {
    return `KeyringCredentialStore(service=${this.#service}, credentials=MASKED)`;
  }

  #entry(ref: string): KeyringEntry {
    return new this.#Entry(this.#service, keyringAccount(ref));
  }
}

/** No-op read / failing write backend used when a platform keychain cannot be initialized. */
export class UnavailableCredentialStore implements CredentialStore {
  readonly #message: string;

  constructor(message = DEFAULT_UNAVAILABLE_MESSAGE) {
    this.#message = message;
  }

  async get(_ref: string): Promise<string | null> {
    return null;
  }

  async set(_ref: string, _secret: string): Promise<void> {
    throw new CredentialStoreUnavailableError(this.#message);
  }

  async delete(_ref: string): Promise<void> {
    // No native credential can be removed when the backend is unavailable.
  }

  toString(): string {
    return "UnavailableCredentialStore(credentials=MASKED)";
  }
}

export interface CredentialStoreCreation {
  readonly store: CredentialStore;
  readonly available: boolean;
}

/**
 * Creates the normal interactive credential backend. Native loading is lazy and injectable so
 * tests do not touch a real keychain. There is deliberately no plaintext-file fallback here.
 */
export async function createSecureCredentialStore(
  options: Readonly<{
    loader?: KeyringModuleLoader;
    service?: string;
  }> = {},
): Promise<CredentialStoreCreation> {
  try {
    const loader = options.loader ?? loadNativeKeyring;
    const module = await loader();
    const store = new KeyringCredentialStore(
      module.Entry,
      options.service === undefined ? {} : { service: options.service },
    );
    store.probe();
    return { store, available: true };
  } catch {
    // Keep the fallback error intentionally generic. Native loader messages can include paths,
    // account names, or platform details that are not useful to a user and may be sensitive.
    return { store: new UnavailableCredentialStore(), available: false };
  }
}

async function loadNativeKeyring(): Promise<KeyringModule> {
  return (await import("@napi-rs/keyring")) as unknown as KeyringModule;
}

/** Stable account namespace helper used by provider-scoped references. */
function keyringAccount(ref: string): string {
  return `provider:${ref}`;
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
