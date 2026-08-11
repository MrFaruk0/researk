import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileCredentialStore } from "../../src/config/credentials.js";
import {
  BUILT_IN_PROVIDERS,
  OPENROUTER_DEFAULT_BASE_URL,
  PersistentProviderRegistry,
  type ProviderProfile,
  providerCredentialStoreRef,
} from "../../src/config/providers.js";
import { type ConfigStore, FileConfigStore } from "../../src/config/store.js";

const cleanups: string[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((value) => rm(value, { recursive: true, force: true })));
});

async function fixture(): Promise<{
  directory: string;
  registry: PersistentProviderRegistry;
  credentials: FileCredentialStore;
  configStore: FileConfigStore<{ schemaVersion: number; providers: ProviderProfile[] }>;
}> {
  const directory = await mkdtemp(path.join(tmpdir(), "researk-providers-"));
  cleanups.push(directory);
  const configStore = new FileConfigStore(directory, "providers");
  const credentials = new FileCredentialStore(path.join(directory, "credentials"));
  const registry = new PersistentProviderRegistry(configStore, credentials);
  return { directory, registry, credentials, configStore };
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

/** Delays each write long enough for unsynchronized mutations to all read the same snapshot. */
class DelayedConfigStore
  implements
    ConfigStore<{
      schemaVersion: number;
      providers: ProviderProfile[];
    }>
{
  #value: { schemaVersion: number; providers: ProviderProfile[] } | undefined;

  async load(defaults: { schemaVersion: number; providers: ProviderProfile[] }) {
    return cloneConfig(this.#value ?? defaults);
  }

  async save(value: { schemaVersion: number; providers: ProviderProfile[] }): Promise<void> {
    await new Promise<void>((resolve) => setImmediate(resolve));
    this.#value = cloneConfig(value);
  }

  async snapshot(): Promise<{ schemaVersion: number; providers: ProviderProfile[] }> {
    return cloneConfig(this.#value ?? { schemaVersion: 1, providers: [] });
  }
}

function cloneConfig(value: { schemaVersion: number; providers: ProviderProfile[] }): {
  schemaVersion: number;
  providers: ProviderProfile[];
} {
  return {
    schemaVersion: value.schemaVersion,
    providers: value.providers.map((provider) => ({ ...provider })),
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

  it("does not delete a shared legacy environment credential while another profile uses it", async () => {
    const { registry, credentials } = await fixture();
    await registry.addCustomProvider(
      customProfile({ id: "agent-router", credentialRef: "OPENAI_API_KEY" }),
    );
    await registry.addCustomProvider(
      customProfile({ id: "command-code", credentialRef: "OPENAI_API_KEY" }),
    );
    await credentials.set("OPENAI_API_KEY", "synthetic-shared-legacy-key");

    await registry.removeCustomProvider("agent-router");

    await expect(credentials.get("OPENAI_API_KEY")).resolves.toBe("synthetic-shared-legacy-key");
    await expect(registry.resolveCredential("command-code")).resolves.toBe(
      "synthetic-shared-legacy-key",
    );
  });

  it("does not delete a legacy fallback shared by a new-format provider", async () => {
    const { registry, credentials } = await fixture();
    await registry.addCustomProvider(
      customProfile({
        id: "agent-router",
        credentialRef: providerCredentialStoreRef("agent-router"),
        credentialEnvironmentVariable: "OPENAI_API_KEY",
      }),
    );
    await registry.addCustomProvider(
      customProfile({ id: "command-code", credentialRef: "OPENAI_API_KEY" }),
    );
    await credentials.set(providerCredentialStoreRef("agent-router"), "synthetic-agent-key");
    await credentials.set("OPENAI_API_KEY", "synthetic-shared-legacy-key");

    await registry.removeCustomProvider("agent-router");

    await expect(credentials.get(providerCredentialStoreRef("agent-router"))).resolves.toBeNull();
    await expect(credentials.get("OPENAI_API_KEY")).resolves.toBe("synthetic-shared-legacy-key");
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

  it("prefers a provider-scoped persisted credential over the environment fallback", async () => {
    const { credentials, configStore } = await fixture();
    const withEnvironment = new PersistentProviderRegistry(configStore, credentials, {
      OPENROUTER_API_KEY: "synthetic-environment-key",
    });
    await credentials.set(providerCredentialStoreRef("openrouter"), "synthetic-persisted-key");
    await expect(withEnvironment.resolveCredential("openrouter")).resolves.toBe(
      "synthetic-persisted-key",
    );

    await credentials.delete(providerCredentialStoreRef("openrouter"));
    await expect(withEnvironment.resolveCredential("openrouter")).resolves.toBe(
      "synthetic-environment-key",
    );
  });

  it("keeps custom provider credentials separate when profiles share an env fallback", async () => {
    const { registry, credentials } = await fixture();
    await registry.addCustomProvider(
      customProfile({ id: "agent-router", credentialRef: "OPENAI_API_KEY" }),
    );
    await registry.addCustomProvider(
      customProfile({ id: "command-code", credentialRef: "OPENAI_API_KEY" }),
    );
    await credentials.set(providerCredentialStoreRef("agent-router"), "synthetic-agent-key");
    await credentials.set(providerCredentialStoreRef("command-code"), "synthetic-command-key");

    await expect(registry.resolveCredential("agent-router")).resolves.toBe("synthetic-agent-key");
    await expect(registry.resolveCredential("command-code")).resolves.toBe("synthetic-command-key");
  });

  it("restores a provider credential through a new registry instance", async () => {
    const { directory, registry, credentials, configStore } = await fixture();
    await registry.addCustomProvider(customProfile({ id: "restart-provider" }));
    await credentials.set(providerCredentialStoreRef("restart-provider"), "synthetic-restart-key");

    const restarted = new PersistentProviderRegistry(
      configStore,
      new FileCredentialStore(path.join(directory, "credentials")),
    );
    await expect(restarted.resolveCredential("restart-provider")).resolves.toBe(
      "synthetic-restart-key",
    );
  });

  it("returns null for a credential that is not stored", async () => {
    const { registry } = await fixture();
    await expect(registry.resolveCredential("openrouter")).resolves.toBeNull();
  });

  it("reads the legacy environment-named secure entry for an old custom profile", async () => {
    const { registry, credentials } = await fixture();
    await registry.addCustomProvider(customProfile());
    await credentials.set("OLLAMA_API_KEY", "synthetic-legacy-key");
    await expect(registry.resolveCredential("local-ollama")).resolves.toBe("synthetic-legacy-key");
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

  it("serializes concurrent additions without losing profiles", async () => {
    const configStore = new DelayedConfigStore();
    const directory = await mkdtemp(path.join(tmpdir(), "researk-providers-concurrent-add-"));
    cleanups.push(directory);
    const registry = new PersistentProviderRegistry(
      configStore,
      new FileCredentialStore(path.join(directory, "credentials")),
    );

    await Promise.all([
      registry.addCustomProvider(customProfile({ id: "agent-router" })),
      registry.addCustomProvider(customProfile({ id: "command-code" })),
    ]);

    const providers = await configStore.snapshot();
    expect(providers.providers.map((provider) => provider.id).sort()).toEqual([
      "agent-router",
      "command-code",
    ]);
  });

  it("serializes concurrent updates without losing either change", async () => {
    const configStore = new DelayedConfigStore();
    const directory = await mkdtemp(path.join(tmpdir(), "researk-providers-concurrent-update-"));
    cleanups.push(directory);
    const registry = new PersistentProviderRegistry(
      configStore,
      new FileCredentialStore(path.join(directory, "credentials")),
    );
    await registry.addCustomProvider(customProfile({ id: "agent-router" }));
    await registry.addCustomProvider(customProfile({ id: "command-code" }));

    await Promise.all([
      registry.updateCustomProvider("agent-router", { name: "Agent Router" }),
      registry.updateCustomProvider("command-code", { name: "Command Code" }),
    ]);

    const providers = await configStore.snapshot();
    expect(providers.providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "agent-router", name: "Agent Router" }),
        expect.objectContaining({ id: "command-code", name: "Command Code" }),
      ]),
    );
  });

  it("serializes concurrent removals without retaining either profile", async () => {
    const configStore = new DelayedConfigStore();
    const directory = await mkdtemp(path.join(tmpdir(), "researk-providers-concurrent-remove-"));
    cleanups.push(directory);
    const registry = new PersistentProviderRegistry(
      configStore,
      new FileCredentialStore(path.join(directory, "credentials")),
    );
    await registry.addCustomProvider(customProfile({ id: "agent-router" }));
    await registry.addCustomProvider(customProfile({ id: "command-code" }));

    await Promise.all([
      registry.removeCustomProvider("agent-router"),
      registry.removeCustomProvider("command-code"),
    ]);

    const providers = await configStore.snapshot();
    expect(providers.providers).toEqual([]);
  });
});
