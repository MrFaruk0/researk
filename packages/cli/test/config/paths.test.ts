import { rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { dataDirs, dataRoot, ensureDataDirs, type DataDirs } from "../../src/config/paths.js";

const originalPlatform = process.platform;
const originalEnv = { ...process.env };
const cleanups: string[] = [];

function stubPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", {
    value: platform,
    configurable: true,
  });
}

function stubEnv(env: Record<string, string | undefined>): void {
  for (const key of Object.keys(originalEnv)) delete process.env[key];
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

/** Asserts the mocked environment resolves a data root and returns the dirs. */
function expectDirs(): DataDirs {
  const dirs = dataDirs();
  if (dirs === null) throw new Error("expected data dirs to resolve");
  return dirs;
}

afterEach(async () => {
  Object.defineProperty(process, "platform", {
    value: originalPlatform,
    configurable: true,
  });
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  await Promise.all(cleanups.splice(0).map((value) => rm(value, { recursive: true, force: true })));
});

describe("data path resolution", () => {
  it("resolves Windows paths from %APPDATA%", () => {
    stubPlatform("win32");
    stubEnv({ APPDATA: "C:\\Users\\alice\\AppData\\Roaming" });
    expect(dataRoot()).toBe("C:\\Users\\alice\\AppData\\Roaming");
    const dirs = expectDirs();
    expect(dirs.root).toBe("C:\\Users\\alice\\AppData\\Roaming\\researk");
    expect(dirs.config).toBe("C:\\Users\\alice\\AppData\\Roaming\\researk\\config");
    expect(dirs.sessions).toBe("C:\\Users\\alice\\AppData\\Roaming\\researk\\sessions");
    expect(dirs.credentials).toBe("C:\\Users\\alice\\AppData\\Roaming\\researk\\credentials");
    expect(dirs.cache).toBe("C:\\Users\\alice\\AppData\\Roaming\\researk\\cache");
    expect(dirs.logs).toBe("C:\\Users\\alice\\AppData\\Roaming\\researk\\logs");
  });

  it("resolves macOS paths from ~/Library/Application Support", () => {
    stubPlatform("darwin");
    stubEnv({ HOME: "/Users/alice" });
    const expected = path.join("/Users/alice", "Library", "Application Support");
    expect(dataRoot()).toBe(expected);
    const dirs = expectDirs();
    expect(dirs.root).toBe(path.join(expected, "researk"));
    expect(dirs.config).toBe(path.join(expected, "researk", "config"));
    expect(dirs.credentials).toBe(path.join(expected, "researk", "credentials"));
  });

  it("resolves Linux paths from XDG_DATA_HOME when set", () => {
    stubPlatform("linux");
    stubEnv({ XDG_DATA_HOME: "/home/alice/.local/share" });
    expect(dataRoot()).toBe("/home/alice/.local/share");
    const dirs = expectDirs();
    expect(dirs.root).toBe(path.join("/home/alice/.local/share", "researk"));
    expect(dirs.sessions).toBe(path.join("/home/alice/.local/share", "researk", "sessions"));
    expect(dirs.cache).toBe(path.join("/home/alice/.local/share", "researk", "cache"));
  });

  it("falls back to ~/.local/share on Linux when XDG_DATA_HOME is unset", () => {
    stubPlatform("linux");
    stubEnv({ HOME: "/home/alice" });
    expect(dataRoot()).toBe(path.join("/home/alice", ".local", "share"));
    expect(expectDirs().root).toBe(path.join("/home/alice", ".local", "share", "researk"));
  });

  it("returns null on Windows without APPDATA", () => {
    stubPlatform("win32");
    stubEnv({});
    expect(dataRoot()).toBeUndefined();
    expect(dataDirs()).toBeNull();
  });

  it("returns null when no home is available", () => {
    stubPlatform("freebsd");
    stubEnv({ HOME: "" });
    expect(dataRoot()).toBeUndefined();
    expect(dataDirs()).toBeNull();
  });
});

describe("ensureDataDirs", () => {
  it("creates every data directory under a real tmpdir", async () => {
    stubPlatform("linux");
    const root = path.join(tmpdir(), "researk-paths-test");
    cleanups.push(root);
    stubEnv({ XDG_DATA_HOME: root });

    const dirs = await ensureDataDirs();
    expect(dirs.root).toBe(path.join(root, "researk"));
    for (const sub of ["config", "sessions", "credentials", "cache", "logs"]) {
      const details = await stat(path.join(root, "researk", sub));
      expect(details.isDirectory()).toBe(true);
    }
  });

  it("rejects when no platform root can be resolved", async () => {
    stubPlatform("win32");
    stubEnv({});
    await expect(ensureDataDirs()).rejects.toThrow(/cannot be resolved/u);
  });

  it("is idempotent across calls", async () => {
    stubPlatform("linux");
    const root = path.join(tmpdir(), "researk-paths-idempotent");
    cleanups.push(root);
    stubEnv({ XDG_DATA_HOME: root });
    const first = await ensureDataDirs();
    const second = await ensureDataDirs();
    expect(second.root).toBe(first.root);
    expect(second).toEqual(first);
  });
});
