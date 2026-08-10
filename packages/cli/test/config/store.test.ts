import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type ConfigStore,
  CURRENT_SCHEMA_VERSION,
  FileConfigStore,
} from "../../src/config/store.js";

interface TestConfig {
  schemaVersion: number;
  name: string;
  theme: string;
  active: boolean;
}

const cleanups: string[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((value) => rm(value, { recursive: true, force: true })));
});

async function fixture(): Promise<{ directory: string; store: ConfigStore<TestConfig> }> {
  const directory = await mkdtemp(path.join(tmpdir(), "researk-store-"));
  cleanups.push(directory);
  return { directory, store: new FileConfigStore<TestConfig>(directory, "test-config") };
}

const defaults: TestConfig = {
  schemaVersion: CURRENT_SCHEMA_VERSION,
  name: "default-name",
  theme: "dark",
  active: true,
};

describe("FileConfigStore", () => {
  it("loads fresh defaults when no file exists", async () => {
    const { store } = await fixture();
    await expect(store.load(defaults)).resolves.toEqual(defaults);
  });

  it("round-trips save then load", async () => {
    const { store } = await fixture();
    const value: TestConfig = { ...defaults, name: "saved", theme: "nord" };
    await store.save(value);
    await expect(store.load(defaults)).resolves.toEqual(value);
  });

  it("merges defaults over a partial saved file, keeping saved values", async () => {
    const { directory, store } = await fixture();
    await writeFile(
      path.join(directory, "test-config.json"),
      JSON.stringify({ schemaVersion: 1, name: "kept" }),
      "utf8",
    );
    const loaded = await store.load(defaults);
    expect(loaded).toEqual({ ...defaults, name: "kept" });
  });

  it("keeps saved fields that defaults also define", async () => {
    const { directory, store } = await fixture();
    await writeFile(
      path.join(directory, "test-config.json"),
      JSON.stringify({ schemaVersion: 1, active: false }),
      "utf8",
    );
    const loaded = await store.load(defaults);
    expect(loaded.active).toBe(false);
    expect(loaded.theme).toBe("dark");
  });

  it("returns defaults and warns for an unknown schemaVersion", async () => {
    const { directory } = await fixture();
    await writeFile(
      path.join(directory, "test-config.json"),
      JSON.stringify({ schemaVersion: 999, name: "future" }),
      "utf8",
    );
    const warn = vi.fn();
    const store = new FileConfigStore<TestConfig>(directory, "test-config", warn);
    await expect(store.load(defaults)).resolves.toEqual(defaults);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("schemaVersion"));
  });

  it("returns defaults when the saved file is corrupted JSON", async () => {
    const { directory, store } = await fixture();
    await writeFile(path.join(directory, "test-config.json"), "{ not json", "utf8");
    await expect(store.load(defaults)).rejects.toThrow();
  });

  it("writes atomically and leaves no temporary file behind", async () => {
    const { directory, store } = await fixture();
    await store.save(defaults);
    const names = await readdir(directory);
    expect(names).toEqual(["test-config.json"]);
    expect(names.some((name) => name.endsWith(".tmp"))).toBe(false);

    const written = await readFile(path.join(directory, "test-config.json"), "utf8");
    expect(JSON.parse(written)).toEqual(defaults);
  });

  it("serializes overlapping saves in invocation order without temporary-file collisions", async () => {
    const { directory, store } = await fixture();
    await writeFile(path.join(directory, "test-config.json.tmp"), "stale", "utf8");

    const first = { ...defaults, name: "first" };
    const second = { ...defaults, name: "second" };
    const third = { ...defaults, name: "third" };
    await Promise.all([store.save(first), store.save(second), store.save(third)]);

    await expect(store.load(defaults)).resolves.toEqual(third);
    await rm(path.join(directory, "test-config.json.tmp"), { force: true });
    const names = await readdir(directory);
    expect(names.some((name) => name.endsWith(".tmp"))).toBe(false);
  });

  it("cleans a failed write and recovers the queue for the next write", async () => {
    const { directory, store } = await fixture();
    const target = path.join(directory, "test-config.json");
    await mkdir(target);

    await expect(store.save(defaults)).rejects.toThrow();
    const failedNames = await readdir(directory);
    expect(failedNames.filter((name) => name.endsWith(".tmp"))).toEqual([]);

    await rm(target, { recursive: true, force: true });
    await expect(store.save({ ...defaults, name: "recovered" })).resolves.toBeUndefined();
    await expect(store.load(defaults)).resolves.toMatchObject({ name: "recovered" });
  });

  it("does not let a stale legacy temporary file block a save", async () => {
    const { directory, store } = await fixture();
    const stalePath = path.join(directory, "test-config.json.tmp");
    await writeFile(stalePath, "stale", "utf8");
    await expect(store.save({ ...defaults, name: "new-value" })).resolves.toBeUndefined();
    await expect(store.load(defaults)).resolves.toMatchObject({ name: "new-value" });
    await rm(stalePath, { force: true });
    const names = await readdir(directory);
    expect(names.some((name) => name.endsWith(".tmp"))).toBe(false);
  });
});
