import { createHash } from "node:crypto";
import { mkdtemp, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_FORMULA_CACHE_FILE_BYTES,
  PersistentFormulaRasterStore,
} from "../../src/config/formula-cache.js";

const roots: string[] = [];

function raster() {
  return {
    height: 1,
    pixels: new Uint8Array([1, 2, 3, 4]),
    png: new Uint8Array([137, 80, 78, 71]),
    width: 1,
  };
}

function digest(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

async function store(): Promise<PersistentFormulaRasterStore> {
  const root = await mkdtemp(path.join(tmpdir(), "researk-formula-cache-"));
  roots.push(root);
  return new PersistentFormulaRasterStore({ directory: root });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("PersistentFormulaRasterStore", () => {
  it("survives a new store instance and uses digest-only filenames", async () => {
    const first = await store();
    const key = JSON.stringify({ display: true, tex: "\\frac{alpha}{beta}" });
    await first.set(key, raster());

    const names = await readdir(first.directory);
    expect(names).toHaveLength(1);
    expect(names[0]).toBe(`${digest(key)}.json`);
    expect(names[0]).not.toContain("alpha");

    const second = new PersistentFormulaRasterStore({ directory: first.directory });
    await expect(second.get(key)).resolves.toEqual(raster());
  });

  it("ignores and removes corrupt, mismatched, and oversized entries", async () => {
    const persistent = await store();
    const corruptKey = "corrupt-key";
    const corruptPath = path.join(persistent.directory, `${digest(corruptKey)}.json`);
    await writeFile(corruptPath, "not json", "utf8");
    await expect(persistent.get(corruptKey)).resolves.toBeUndefined();
    await expect(readdir(persistent.directory)).resolves.toEqual([]);

    const originalKey = "original-key";
    const movedKey = "moved-key";
    await persistent.set(originalKey, raster());
    await rename(
      path.join(persistent.directory, `${digest(originalKey)}.json`),
      path.join(persistent.directory, `${digest(movedKey)}.json`),
    );
    await expect(persistent.get(movedKey)).resolves.toBeUndefined();

    const oversizedKey = "oversized-key";
    const oversizedPath = path.join(persistent.directory, `${digest(oversizedKey)}.json`);
    await writeFile(oversizedPath, Buffer.alloc(MAX_FORMULA_CACHE_FILE_BYTES + 1));
    await expect(persistent.get(oversizedKey)).resolves.toBeUndefined();
    await expect(readdir(persistent.directory)).resolves.toEqual([]);
  });

  it("bounds persistent entries and bytes", async () => {
    const persistent = await store();
    const bounded = new PersistentFormulaRasterStore({
      directory: persistent.directory,
      maxBytes: 1_000,
      maxEntries: 2,
    });
    await bounded.set("one", raster());
    await bounded.set("two", raster());
    await bounded.set("three", raster());
    await expect(readdir(persistent.directory)).resolves.toHaveLength(2);
  });
});
