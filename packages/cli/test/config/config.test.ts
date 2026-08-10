import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AppConfigStore, DEFAULT_APP_CONFIG, type AppConfig } from "../../src/config/config.js";
import { CURRENT_SCHEMA_VERSION, FileConfigStore } from "../../src/config/store.js";
import type { ProviderProfile } from "../../src/config/providers.js";

const cleanups: string[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((value) => rm(value, { recursive: true, force: true })));
});

async function fixture(): Promise<{ directory: string; store: AppConfigStore }> {
  const directory = await mkdtemp(path.join(tmpdir(), "researk-appconfig-"));
  cleanups.push(directory);
  return {
    directory,
    store: new AppConfigStore(new FileConfigStore(directory, "app")),
  };
}

const customProvider: ProviderProfile = {
  id: "local-ollama",
  name: "Local Ollama",
  protocol: "compatible",
  baseUrl: "http://localhost:11434/v1",
  credentialRef: "OLLAMA_API_KEY",
};

describe("AppConfigStore", () => {
  it("loads default configuration when nothing is saved", async () => {
    const { store } = await fixture();
    await expect(store.loadConfig()).resolves.toEqual(DEFAULT_APP_CONFIG);
  });

  it("round-trips a full AppConfig through save and load", async () => {
    const { store } = await fixture();
    const config: AppConfig = {
      ...DEFAULT_APP_CONFIG,
      activeProviderId: "openrouter",
      defaultModelByProvider: { openrouter: "openai/gpt-4o" },
      selectedVariantByModel: { "openai/gpt-4o": "high" },
      theme: "nord",
      lastSessionId: "session-abc",
      colorEnabled: false,
      providers: [customProvider],
    };
    await store.saveConfig(config);
    await expect(store.loadConfig()).resolves.toEqual(config);
  });

  it("preserves defaults for fields absent from a partial file", async () => {
    const { directory, store } = await fixture();
    await writeFile(
      path.join(directory, "app.json"),
      JSON.stringify({ schemaVersion: CURRENT_SCHEMA_VERSION, theme: "dracula" }),
      "utf8",
    );
    const loaded = await store.loadConfig();
    expect(loaded.theme).toBe("dracula");
    expect(loaded.colorEnabled).toBe(DEFAULT_APP_CONFIG.colorEnabled);
    expect(loaded.activeProviderId).toBeNull();
  });

  it("persists schemaVersion at the current version", async () => {
    const { directory, store } = await fixture();
    const config = { ...DEFAULT_APP_CONFIG, theme: "gruvbox" };
    await store.saveConfig(config);
    const raw = await readFile(path.join(directory, "app.json"), "utf8");
    const parsed = JSON.parse(raw) as AppConfig;
    expect(parsed.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(parsed.theme).toBe("gruvbox");
  });
});
