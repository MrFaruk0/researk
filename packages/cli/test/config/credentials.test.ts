import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSecureCredentialStore,
  FileCredentialStore,
  KeyringCredentialStore,
  type KeyringEntry,
  type KeyringModule,
} from "../../src/config/credentials.js";

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

describe("KeyringCredentialStore", () => {
  class FakeEntry implements KeyringEntry {
    static readonly values = new Map<string, string>();
    readonly account: string;

    constructor(_service: string, account: string) {
      this.account = account;
    }

    getPassword(): string | null {
      return FakeEntry.values.get(this.account) ?? null;
    }

    setPassword(password: string): void {
      FakeEntry.values.set(this.account, password);
    }

    deletePassword(): boolean {
      return FakeEntry.values.delete(this.account);
    }
  }

  afterEach(() => {
    FakeEntry.values.clear();
  });

  it("uses provider-scoped native entries without exposing the secret", async () => {
    const store = new KeyringCredentialStore(FakeEntry, { service: "synthetic-service" });
    await store.set("provider/openrouter", "synthetic-keyring-secret");
    await expect(store.get("provider/openrouter")).resolves.toBe("synthetic-keyring-secret");
    expect(FakeEntry.values.has("provider:provider/openrouter")).toBe(true);
    expect(String(store)).not.toContain("synthetic-keyring-secret");
    await store.delete("provider/openrouter");
    await expect(store.get("provider/openrouter")).resolves.toBeNull();
  });

  it("can be constructed through an injected loader without touching a real keychain", async () => {
    const module: KeyringModule = { Entry: FakeEntry };
    const created = await createSecureCredentialStore({
      loader: async () => module,
      service: "synthetic-service",
    });
    expect(created.available).toBe(true);
    await created.store.set("provider/test", "synthetic-key");
    await expect(created.store.get("provider/test")).resolves.toBe("synthetic-key");
  });

  it("falls back safely when the native keyring cannot initialize", async () => {
    const secret = "synthetic-loader-secret";
    const created = await createSecureCredentialStore({
      loader: async () => {
        throw new Error(`native failure ${secret}`);
      },
    });
    expect(created.available).toBe(false);
    await expect(created.store.get("provider/test")).resolves.toBeNull();
    await expect(created.store.set("provider/test", secret)).rejects.toThrow(
      /OS secure credential storage is unavailable/u,
    );
    await expect(created.store.set("provider/test", secret)).rejects.not.toThrow(secret);
    expect(String(created.store)).not.toContain(secret);
  });
});
