import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

/** Directory name under each platform's per-user data root. */
export const DATA_ROOT_NAME = "researk";

/**
 * Researk's per-user data root for the current platform:
 *
 * - Windows: `%APPDATA%` (normally `C:\Users\<user>\AppData\Roaming`)
 * - macOS: `~/Library/Application Support`
 * - Linux and other POSIX systems: `$XDG_DATA_HOME` when set, otherwise `~/.local/share`
 *
 * The root is a sibling of `config`/`sessions`/etc. (not the root itself), because each child
 * directory lives beside the others and Researk must never write files directly into `researk/`.
 */
export function dataRoot(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.APPDATA !== undefined && env.APPDATA.length > 0) {
    return env.APPDATA;
  }
  if (process.platform === "darwin") {
    const home = env.HOME ?? homedir();
    return home.length > 0 ? path.join(home, "Library", "Application Support") : undefined;
  }
  if (process.platform === "win32") {
    return undefined;
  }
  if (env.XDG_DATA_HOME !== undefined && env.XDG_DATA_HOME.length > 0) {
    return env.XDG_DATA_HOME;
  }
  const home = env.HOME ?? homedir();
  return home.length > 0 ? path.join(home, ".local", "share") : undefined;
}

export interface DataDirs {
  readonly root: string;
  readonly config: string;
  readonly sessions: string;
  readonly credentials: string;
  readonly cache: string;
  readonly logs: string;
}

/**
 * Resolves every Researk data directory. Returns `null` when the current platform has no usable
 * per-user data root (for example Windows without `%APPDATA%`), so callers can degrade cleanly
 * instead of writing into an arbitrary location.
 */
export function dataDirs(env: NodeJS.ProcessEnv = process.env): DataDirs | null {
  const root = dataRoot(env);
  if (root === undefined) return null;
  const base = path.join(root, DATA_ROOT_NAME);
  return Object.freeze({
    root: base,
    config: path.join(base, "config"),
    sessions: path.join(base, "sessions"),
    credentials: path.join(base, "credentials"),
    cache: path.join(base, "cache"),
    logs: path.join(base, "logs"),
  });
}

/**
 * Creates every Researk data directory, including the credentials directory that is deliberately
 * created as an empty dir marker so its presence, permissions, and docs are established before any
 * credential write can happen. Idempotent: existing directories are left untouched.
 */
export async function ensureDataDirs(env: NodeJS.ProcessEnv = process.env): Promise<DataDirs> {
  const dirs = dataDirs(env);
  if (dirs === null) {
    throw new Error(
      "Researk data directories cannot be resolved: no APPDATA, HOME, or XDG_DATA_HOME is set.",
    );
  }
  await mkdir(dirs.root, { recursive: true });
  await Promise.all([
    mkdir(dirs.config, { recursive: true }),
    mkdir(dirs.sessions, { recursive: true }),
    mkdir(dirs.credentials, { recursive: true }),
    mkdir(dirs.cache, { recursive: true }),
    mkdir(dirs.logs, { recursive: true }),
  ]);
  return dirs;
}
