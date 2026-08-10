import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileCredentialStore } from "../../src/config/credentials.js";

const cleanups: string[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((value) => rm(value, { recursive: true, force: true })));
});

/** The backing filename a reference maps to, mirroring the store's encoding. */
function backingFile(directory: string, ref: string): string {
  return path.join(directory, `${encodeURIComponent(ref)}.txt`);
}

async function fixture(): Promise<{ directory: string; store: FileCredentialStore }> {
  const directory = await mkdtemp(path.join(tmpdir(), "researk-credentials-"));
  cleanups.push(directory);
  return { directory, store: new FileCredentialStore(directory) };
}

describe("FileCredentialStore", () => {
  it("stores and reads a credential by reference", async () => {
    const { store } = await fixture();
    await store.set("OPENROUTER_API_KEY", "sk-synthetic-123");
    await expect(store.get("OPENROUTER_API_KEY")).resolves.toBe("sk-synthetic-123");
  });

  it("overwrites an existing credential", async () => {
    const { store } = await fixture();
    await store.set("OPENAI_API_KEY", "first");
    await store.set("OPENAI_API_KEY", "second");
    await expect(store.get("OPENAI_API_KEY")).resolves.toBe("second");
  });

  it("returns null for a missing credential", async () => {
    const { store } = await fixture();
    await expect(store.get("DOES_NOT_EXIST")).resolves.toBeNull();
  });

  it("deletes a credential", async () => {
    const { directory, store } = await fixture();
    await store.set("OPENROUTER_API_KEY", "sk-synthetic-123");
    await store.delete("OPENROUTER_API_KEY");
    await expect(store.get("OPENROUTER_API_KEY")).resolves.toBeNull();
    const { stat } = await import("node:fs/promises");
    await expect(stat(backingFile(directory, "OPENROUTER_API_KEY"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("deleting a missing credential is a no-op", async () => {
    const { store } = await fixture();
    await expect(store.delete("NEVER_SET")).resolves.toBeUndefined();
  });

  it("returns null for a non-readable file", async () => {
    const { directory, store } = await fixture();
    await store.set("OPENROUTER_API_KEY", "sk-synthetic-123");
    if (process.platform === "win32") {
      // Windows access control is not reliably scriptable from a test; keep the read path simple.
      await expect(store.get("OPENROUTER_API_KEY")).resolves.toBe("sk-synthetic-123");
      return;
    }
    const backing = backingFile(directory, "OPENROUTER_API_KEY");
    await chmod(backing, 0o000);
    try {
      await expect(store.get("OPENROUTER_API_KEY")).resolves.toBeNull();
    } finally {
      await chmod(backing, 0o600);
    }
  });

  it("masks secrets in its toString representation", async () => {
    const { store } = await fixture();
    await store.set("OPENROUTER_API_KEY", "super-secret-value");
    const representation = String(store);
    expect(representation).toContain("MASKED");
    expect(representation).not.toContain("super-secret-value");
  });
});
