import type { CredentialStore } from "./credentials.js";
import type { ConfigStore } from "./store.js";

export type ProviderProtocol = "openrouter" | "compatible";

export interface BuiltInProviderDefinition {
  readonly id: string;
  readonly name: string;
  readonly protocol: ProviderProtocol;
  /** Present for openrouter; absent for compatible (URL is required at creation time). */
  readonly defaultBaseUrl?: string;
  readonly credentialRef: string;
}

export interface ProviderProfile {
  readonly id: string;
  readonly name: string;
  readonly protocol: ProviderProtocol;
  /** Present when protocol is compatible; absent when openrouter. */
  readonly baseUrl?: string;
  readonly credentialRef: string;
}

export const OPENROUTER_DEFAULT_BASE_URL = "https://openrouter.ai/api/v1/";

export const BUILT_IN_PROVIDERS: readonly BuiltInProviderDefinition[] = Object.freeze([
  Object.freeze({
    id: "openrouter",
    name: "OpenRouter",
    protocol: "openrouter",
    defaultBaseUrl: OPENROUTER_DEFAULT_BASE_URL,
    credentialRef: "OPENROUTER_API_KEY",
  }),
]);

export interface ProviderConfigFile {
  readonly schemaVersion: number;
  readonly providers: ProviderProfile[];
}

const PROVIDER_CONFIG_SCHEMA_VERSION = 1;

/**
 * Persists provider profiles (a versioned config file) and resolves their credentials. The built-in
 * OpenRouter definition is always present; custom profiles live in the config file.
 */
export class PersistentProviderRegistry {
  readonly #configStore: ConfigStore<ProviderConfigFile>;
  readonly #credentialStore: CredentialStore;

  constructor(configStore: ConfigStore<ProviderConfigFile>, credentialStore: CredentialStore) {
    this.#configStore = configStore;
    this.#credentialStore = credentialStore;
  }

  async listProviders(): Promise<ProviderProfile[]> {
    const custom = (await this.#configStore.load(this.#defaults())).providers;
    return [...BUILT_IN_PROVIDERS, ...custom];
  }

  async getProvider(id: string): Promise<ProviderProfile | undefined> {
    return (await this.listProviders()).find((provider) => provider.id === id);
  }

  async addCustomProvider(profile: ProviderProfile): Promise<ProviderProfile> {
    const stored = await this.#configStore.load(this.#defaults());
    const custom = stored.providers.filter((provider) => provider.id !== profile.id);
    custom.push(profile);
    await this.#configStore.save({ ...stored, providers: custom });
    return { ...profile };
  }

  async updateCustomProvider(
    id: string,
    partial: Partial<Omit<ProviderProfile, "id">>,
  ): Promise<ProviderProfile> {
    const stored = await this.#configStore.load(this.#defaults());
    const existing = stored.providers.find((provider) => provider.id === id);
    if (existing === undefined) {
      throw new Error(`Unknown custom provider: ${id}`);
    }
    const updated = { ...existing, ...partial, id };
    const custom = stored.providers.map((provider) => (provider.id === id ? updated : provider));
    await this.#configStore.save({ ...stored, providers: custom });
    return { ...updated };
  }

  async removeCustomProvider(id: string): Promise<void> {
    const stored = await this.#configStore.load(this.#defaults());
    const removed = stored.providers.find((provider) => provider.id === id);
    if (removed !== undefined) {
      await this.#configStore.save({
        ...stored,
        providers: stored.providers.filter((provider) => provider.id !== id),
      });
      await this.#credentialStore.delete(removed.credentialRef);
    }
  }

  async resolveCredential(providerId: string): Promise<string | null> {
    const profile = await this.getProvider(providerId);
    if (profile === undefined) return null;
    return this.#credentialStore.get(profile.credentialRef);
  }

  resolveBaseUrl(profile: ProviderProfile): string | undefined {
    if (profile.baseUrl !== undefined) return profile.baseUrl;
    const builtIn = BUILT_IN_PROVIDERS.find((provider) => provider.id === profile.id);
    return builtIn?.defaultBaseUrl;
  }

  #defaults(): ProviderConfigFile {
    return { schemaVersion: PROVIDER_CONFIG_SCHEMA_VERSION, providers: [] };
  }
}
