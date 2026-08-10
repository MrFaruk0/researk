import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileCredentialStore } from "../../src/config/credentials.js";
import { FileConfigStore } from "../../src/config/store.js";
import {
  BUILT_IN_PROVIDERS,
  OPENROUTER_DEFAULT_BASE_URL,
  PersistentProviderRegistry,
  type ProviderProfile,
} from "../../src/config/providers.js";

const cleanups: string[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((value) => rm(value, { recursive: true, force: true })));
});

async function fixture(): Promise<{
  registry: PersistentProviderRegistry;
  credentials: FileCredentialStore;
  configStore: FileConfigStore<{ schemaVersion: number; providers: ProviderProfile[] }>;
}> {
  const directory = await mkdtemp(path.join(tmpdir(), "researk-providers-"));
  cleanups.push(directory);
  const configStore = new FileConfigStore(directory, "providers");
  const credentials = new FileCredentialStore(path.join(directory, "credentials"));
  const registry = new PersistentProviderRegistry(configStore, credentials);
  return { registry, credentials, configStore };
}

function customProfile(overrides: Partial<ProviderProfile> = {}): ProviderProfile {
  return {
    id: "local-ollama",
    name: "Local Ollama",
    protocol: "compatible",
    baseUrl: "http://localhost:11434/v1",
    credentialRef: "OLLAMA_API_KEY",
    ...overrides,
  };
}

describe("PersistentProviderRegistry", () => {
  it("lists the built-in OpenRouter definition", async () => {
    const { registry } = await fixture();
    const providers = await registry.listProviders();
    expect(providers).toEqual(BUILT_IN_PROVIDERS);
    expect(providers[0]).toMatchObject({
      id: "openrouter",
      protocol: "openrouter",
      defaultBaseUrl: OPENROUTER_DEFAULT_BASE_URL,
    });
  });

  it("adds a custom provider and returns it", async () => {
    const { registry } = await fixture();
    const added = await registry.addCustomProvider(customProfile());
    expect(added).toEqual(customProfile());
    const providers = await registry.listProviders();
    expect(providers).toHaveLength(2);
    expect(providers[1]).toEqual(customProfile());
  });

  it("adds a custom provider and persists across a new registry instance", async () => {
    const { registry, credentials, configStore } = await fixture();
    await registry.addCustomProvider(customProfile());
    const reloaded = new PersistentProviderRegistry(configStore, credentials);
    const providers = await reloaded.listProviders();
    expect(providers.some((provider) => provider.id === "local-ollama")).toBe(true);
  });

  it("updates a custom provider with a partial change", async () => {
    const { registry } = await fixture();
    await registry.addCustomProvider(customProfile());
    const updated = await registry.updateCustomProvider("local-ollama", {
      name: "Renamed Ollama",
    });
    expect(updated).toMatchObject({ id: "local-ollama", name: "Renamed Ollama" });
    const stored = await registry.getProvider("local-ollama");
    expect(stored).toMatchObject({ name: "Renamed Ollama", baseUrl: "http://localhost:11434/v1" });
  });

  it("rejects updating an unknown custom provider", async () => {
    const { registry } = await fixture();
    await expect(registry.updateCustomProvider("ghost", { name: "x" })).rejects.toThrow(
      /Unknown custom provider/u,
    );
  });

  it("removes a custom provider and its credential", async () => {
    const { registry, credentials } = await fixture();
    await registry.addCustomProvider(customProfile());
    await credentials.set("OLLAMA_API_KEY", "sk-local");
    await registry.removeCustomProvider("local-ollama");
    const providers = await registry.listProviders();
    expect(providers).toHaveLength(1);
    expect(providers[0]?.id).toBe("openrouter");
    await expect(credentials.get("OLLAMA_API_KEY")).resolves.toBeNull();
  });

  it("leaves built-ins intact after removing a custom provider", async () => {
    const { registry } = await fixture();
    await registry.addCustomProvider(customProfile());
    await registry.removeCustomProvider("local-ollama");
    const providers = await registry.listProviders();
    expect(providers).toEqual(BUILT_IN_PROVIDERS);
  });

  it("resolves credentials through the credential store", async () => {
    const { registry, credentials } = await fixture();
    await credentials.set("OPENROUTER_API_KEY", "sk-openrouter");
    await expect(registry.resolveCredential("openrouter")).resolves.toBe("sk-openrouter");
  });

  it("returns null for a credential that is not stored", async () => {
    const { registry } = await fixture();
    await expect(registry.resolveCredential("openrouter")).resolves.toBeNull();
  });

  it("resolves a base URL for a built-in provider from its default", async () => {
    const { registry } = await fixture();
    const openrouter = await registry.getProvider("openrouter");
    expect(openrouter).toBeDefined();
    if (openrouter !== undefined) {
      expect(registry.resolveBaseUrl(openrouter)).toBe(OPENROUTER_DEFAULT_BASE_URL);
    }
  });

  it("resolves a base URL for a custom provider from its profile", async () => {
    const { registry } = await fixture();
    const custom = customProfile();
    await registry.addCustomProvider(custom);
    expect(registry.resolveBaseUrl(custom)).toBe("http://localhost:11434/v1");
  });

  it("returns undefined for a custom profile without a base URL", async () => {
    const { registry } = await fixture();
    const custom = customProfile({ baseUrl: undefined });
    await registry.addCustomProvider(custom);
    expect(registry.resolveBaseUrl(custom)).toBeUndefined();
  });

  it("getProvider returns undefined for an unknown id", async () => {
    const { registry } = await fixture();
    await expect(registry.getProvider("nope")).resolves.toBeUndefined();
  });
});
