import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { autoTitle, type Session, SessionStore } from "../../src/config/sessions.js";

const cleanups: string[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((value) => rm(value, { recursive: true, force: true })));
});

async function fixture(): Promise<{ directory: string; store: SessionStore }> {
  const directory = await mkdtemp(path.join(tmpdir(), "researk-sessions-"));
  cleanups.push(directory);
  return { directory, store: new SessionStore(directory) };
}

function makeSession(overrides: Partial<Session> = {}): Session {
  const id = overrides.id ?? "session-1";
  return {
    schemaVersion: 1,
    id,
    title: "Drafting a hypothesis",
    createdAt: "2026-08-01T10:00:00.000Z",
    updatedAt: "2026-08-01T10:00:00.000Z",
    workspace: "/workspaces/paper",
    providerId: "openrouter",
    modelId: "openai/gpt-4o",
    variantId: null,
    messages: [
      { role: "user", content: "Help me refine a null hypothesis." },
      { role: "assistant", content: "Here is a refined hypothesis." },
    ],
    ...overrides,
  };
}

describe("SessionStore", () => {
  it("creates and loads a session", async () => {
    const { store } = await fixture();
    const session = makeSession();
    await store.saveSession(session);
    await expect(store.loadSession("session-1")).resolves.toEqual(session);
  });

  it("lists sessions ordered by updatedAt descending", async () => {
    const { store } = await fixture();
    await store.saveSession(makeSession({ id: "old", updatedAt: "2026-08-01T09:00:00.000Z" }));
    await store.saveSession(makeSession({ id: "newer", updatedAt: "2026-08-02T09:00:00.000Z" }));
    await store.saveSession(makeSession({ id: "newest", updatedAt: "2026-08-03T09:00:00.000Z" }));
    const meta = await store.listSessions();
    expect(meta.map((entry) => entry.id)).toEqual(["newest", "newer", "old"]);
    expect(meta[0]).toMatchObject({
      id: "newest",
      title: "Drafting a hypothesis",
      messageCount: 2,
      providerId: "openrouter",
      modelId: "openai/gpt-4o",
    });
  });

  it("updates a session in place", async () => {
    const { store } = await fixture();
    await store.saveSession(makeSession());
    const updated = makeSession({
      title: "Revised title",
      updatedAt: "2026-08-04T09:00:00.000Z",
      messages: [
        { role: "user", content: "One more question." },
        { role: "assistant", content: "One more answer." },
      ],
    });
    await store.saveSession(updated);
    await expect(store.loadSession("session-1")).resolves.toEqual(updated);
    const meta = await store.listSessions();
    expect(meta).toHaveLength(1);
    expect(meta[0]?.title).toBe("Revised title");
    expect(meta[0]?.messageCount).toBe(2);
  });

  it("deletes a session", async () => {
    const { store } = await fixture();
    await store.saveSession(makeSession());
    await store.deleteSession("session-1");
    await expect(store.loadSession("session-1")).resolves.toBeNull();
    await expect(store.listSessions()).resolves.toEqual([]);
  });

  it("returns null for a missing session", async () => {
    const { store } = await fixture();
    await expect(store.loadSession("missing")).resolves.toBeNull();
  });

  it("returns null for a corrupted session file", async () => {
    const { directory, store } = await fixture();
    await writeFile(path.join(directory, "broken.json"), "{ nope", "utf8");
    await expect(store.loadSession("broken")).resolves.toBeNull();
    await expect(store.listSessions()).resolves.toEqual([]);
  });

  it("skips a non-session JSON file in the list", async () => {
    const { directory, store } = await fixture();
    await writeFile(
      path.join(directory, "not-a-session.json"),
      JSON.stringify({ hello: "world" }),
      "utf8",
    );
    await store.saveSession(makeSession());
    const meta = await store.listSessions();
    expect(meta).toHaveLength(1);
    expect(meta[0]?.id).toBe("session-1");
  });

  it("writes atomically and leaves no temporary file behind", async () => {
    const { directory, store } = await fixture();
    await store.saveSession(makeSession());
    const names = await readdir(directory);
    expect(names).toEqual(["session-1.json"]);
    expect(names.some((name) => name.endsWith(".tmp"))).toBe(false);
  });

  it("serializes rapid same-session saves and retains the later complete exchange", async () => {
    const { store, directory } = await fixture();
    const first = makeSession({
      title: "First exchange",
      updatedAt: "2026-08-02T09:00:00.000Z",
      messages: [{ role: "user", content: "first" }],
    });
    const second = makeSession({
      title: "Second exchange",
      updatedAt: "2026-08-03T09:00:00.000Z",
      messages: [
        { role: "user", content: "second" },
        { role: "assistant", content: "complete second response" },
      ],
    });

    await Promise.all([store.saveSession(first), store.saveSession(second)]);

    await expect(store.loadSession("session-1")).resolves.toEqual(second);
    const names = await readdir(directory);
    expect(names.some((name) => name.endsWith(".tmp"))).toBe(false);
  });

  it("orders same-session delete and save calls by invocation order", async () => {
    const { store } = await fixture();
    await store.saveSession(makeSession());

    await Promise.all([
      store.deleteSession("session-1"),
      store.saveSession(makeSession({ title: "Saved after delete" })),
    ]);
    await expect(store.loadSession("session-1")).resolves.toMatchObject({
      title: "Saved after delete",
    });

    await Promise.all([
      store.saveSession(makeSession({ title: "Deleted after save" })),
      store.deleteSession("session-1"),
    ]);
    await expect(store.loadSession("session-1")).resolves.toBeNull();
  });

  it("cleans a failed write and recovers the same-session queue", async () => {
    const { directory, store } = await fixture();
    const target = path.join(directory, "session-1.json");
    await mkdir(target);

    await expect(store.saveSession(makeSession())).rejects.toThrow();
    const failedNames = await readdir(directory);
    expect(failedNames.filter((name) => name.endsWith(".tmp"))).toEqual([]);

    await rm(target, { recursive: true, force: true });
    await expect(
      store.saveSession(makeSession({ title: "Recovered session" })),
    ).resolves.toBeUndefined();
    await expect(store.loadSession("session-1")).resolves.toMatchObject({
      title: "Recovered session",
    });
  });
});

describe("autoTitle", () => {
  it("uses the first user message truncated to 80 characters", () => {
    const long = "x".repeat(120);
    const title = autoTitle([
      { role: "assistant", content: "ignored" },
      { role: "user", content: long },
    ]);
    expect([...title].length).toBe(81); // 80 characters + ellipsis
    expect(title.endsWith("…")).toBe(true);
    expect([...title].slice(0, 80).join("")).toBe("x".repeat(80));
  });

  it("keeps a short user message as-is", () => {
    expect(autoTitle([{ role: "user", content: "Draft abstract" }])).toBe("Draft abstract");
  });

  it("falls back to a neutral title when there is no user message", () => {
    expect(autoTitle([])).toBe("New session");
    expect(autoTitle([{ role: "assistant", content: "hi" }])).toBe("New session");
  });

  it("truncates by code points, not UTF-16 units", () => {
    const title = autoTitle([{ role: "user", content: "😀".repeat(90) }]);
    expect([...title].length).toBe(81); // 80 emoji + ellipsis
    expect(title.endsWith("…")).toBe(true);
  });
});
