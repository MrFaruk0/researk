import type { CredentialStore } from "./credentials.js";
import type { ConfigStore } from "./store.js";

export type ProviderProtocol = "openrouter" | "compatible";

export interface BuiltInProviderDefinition {
  readonly id: string;
  readonly name: string;
  readonly protocol: ProviderProtocol;
  /** Present for openrouter; absent for compatible (URL is required at creation time). */
  readonly defaultBaseUrl?: string;
  /** Stable provider-scoped reference in the OS credential store. */
  readonly credentialRef: string;
  /** Explicit environment-variable fallback; never contains a secret value. */
  readonly credentialEnvironmentVariable: string;
}

export interface ProviderProfile {
  readonly id: string;
  readonly name: string;
  readonly protocol: ProviderProtocol;
  /** Present when protocol is compatible; absent when openrouter. */
  readonly baseUrl?: string;
  /** Stable provider-scoped reference in the OS credential store. */
  readonly credentialRef: string;
  /** Explicit environment-variable fallback. The value itself is never persisted. */
  readonly credentialEnvironmentVariable?: string;
}

export const OPENROUTER_DEFAULT_BASE_URL = "https://openrouter.ai/api/v1/";

export const BUILT_IN_PROVIDERS: readonly BuiltInProviderDefinition[] = Object.freeze([
  Object.freeze({
    id: "openrouter",
    name: "OpenRouter",
    protocol: "openrouter",
    defaultBaseUrl: OPENROUTER_DEFAULT_BASE_URL,
    credentialRef: providerCredentialStoreRef("openrouter"),
    credentialEnvironmentVariable: "OPENROUTER_API_KEY",
  }),
]);

export interface ProviderConfigFile {
  readonly schemaVersion: number;
  readonly providers: ProviderProfile[];
}

const PROVIDER_CONFIG_SCHEMA_VERSION = 1;

/**
 * Returns the stable, provider-scoped reference used in the OS credential store. It deliberately
 * does not use `profile.credentialRef`: older profiles use that field for an environment variable,
 * and multiple compatible providers commonly share `OPENAI_API_KEY`.
 */
export function providerCredentialStoreRef(providerId: string): string {
  return `provider/${encodeURIComponent(providerId)}`;
}

/** Returns a profile's explicit environment fallback, including legacy profiles. */
export function providerCredentialEnvironmentRef(
  profile: Pick<ProviderProfile, "credentialRef" | "credentialEnvironmentVariable">,
): string {
  return profile.credentialEnvironmentVariable ?? profile.credentialRef;
}

/**
 * Returns the secure-store reference for a profile. Profiles written before the split stored the
 * environment name in `credentialRef`; derive their new stable reference without rewriting the
 * old config object.
 */
export function providerCredentialRef(
  profile: Pick<ProviderProfile, "id" | "credentialRef" | "credentialEnvironmentVariable">,
): string {
  return profile.credentialEnvironmentVariable === undefined
    ? providerCredentialStoreRef(profile.id)
    : profile.credentialRef;
}

/**
 * Persists provider profiles (a versioned config file) and resolves their credentials. The built-in
 * OpenRouter definition is always present; custom profiles live in the config file.
 */
export class PersistentProviderRegistry {
  readonly #configStore: ConfigStore<ProviderConfigFile>;
  readonly #credentialStore: CredentialStore;
  readonly #environment: Readonly<Record<string, string | undefined>>;
  /**
   * Serializes read/modify/write operations for this registry instance. ConfigStore serializes
   * the final writes, but cannot prevent two callers from loading the same stale profile list
   * before either write begins.
   */
  #mutationTail: Promise<void> = Promise.resolve();

  constructor(
    configStore: ConfigStore<ProviderConfigFile>,
    credentialStore: CredentialStore,
    environment: Readonly<Record<string, string | undefined>> = process.env,
  ) {
    this.#configStore = configStore;
    this.#credentialStore = credentialStore;
    this.#environment = environment;
  }

  async listProviders(): Promise<ProviderProfile[]> {
    const custom = (await this.#configStore.load(this.#defaults())).providers;
    return [...BUILT_IN_PROVIDERS, ...custom];
  }

  async getProvider(id: string): Promise<ProviderProfile | undefined> {
    return (await this.listProviders()).find((provider) => provider.id === id);
  }

  async addCustomProvider(profile: ProviderProfile): Promise<ProviderProfile> {
    return this.#enqueueMutation(async () => {
      const stored = await this.#configStore.load(this.#defaults());
      const custom = stored.providers.filter((provider) => provider.id !== profile.id);
      custom.push(profile);
      await this.#configStore.save({ ...stored, providers: custom });
      return { ...profile };
    });
  }

  async updateCustomProvider(
    id: string,
    partial: Partial<Omit<ProviderProfile, "id">>,
  ): Promise<ProviderProfile> {
    return this.#enqueueMutation(async () => {
      const stored = await this.#configStore.load(this.#defaults());
      const existing = stored.providers.find((provider) => provider.id === id);
      if (existing === undefined) {
        throw new Error(`Unknown custom provider: ${id}`);
      }
      const updated = { ...existing, ...partial, id };
      const custom = stored.providers.map((provider) => (provider.id === id ? updated : provider));
      await this.#configStore.save({ ...stored, providers: custom });
      return { ...updated };
    });
  }

  async removeCustomProvider(id: string): Promise<void> {
    return this.#enqueueMutation(async () => {
      const stored = await this.#configStore.load(this.#defaults());
      const removed = stored.providers.find((provider) => provider.id === id);
      if (removed === undefined) return;

      const remainingCustom = stored.providers.filter((provider) => provider.id !== id);
      await this.#configStore.save({ ...stored, providers: remainingCustom });

      // Always remove the provider-scoped native entry. An older profile used its environment
      // variable name as credentialRef, so providerCredentialRef(removed) derives the new scoped
      // entry while providerCredentialEnvironmentRef(removed) identifies that legacy entry.
      const secureReference = providerCredentialRef(removed);
      const environmentReference = providerCredentialEnvironmentRef(removed);
      const references = [secureReference];
      const remainingProfiles = [...BUILT_IN_PROVIDERS, ...remainingCustom];
      if (
        environmentReference !== secureReference &&
        !remainingProfiles.some(
          (provider) => providerCredentialEnvironmentRef(provider) === environmentReference,
        )
      ) {
        // An environment-named entry is shared by convention. Only remove it once no remaining
        // profile can resolve through that same fallback, otherwise removing one provider would
        // destroy another provider's legacy credential.
        references.push(environmentReference);
      }
      await Promise.all(
        references.map((reference) =>
          this.#credentialStore.delete(reference).catch(() => undefined),
        ),
      );
    });
  }

  async resolveCredential(
    providerId: string,
    environment: Readonly<Record<string, string | undefined>> = this.#environment,
  ): Promise<string | null> {
    const profile = await this.getProvider(providerId);
    if (profile === undefined) return null;
    const secureRef = providerCredentialRef(profile);
    // New profiles use a provider-scoped secure reference. Existing installations used the
    // environment reference directly as the credential-store key, so read it as a migration path.
    const persisted = await readCredential(this.#credentialStore, secureRef);
    if (persisted !== null) return persisted;
    const environmentRef = providerCredentialEnvironmentRef(profile);
    if (environmentRef !== secureRef) {
      const legacyPersisted = await readCredential(this.#credentialStore, environmentRef);
      if (legacyPersisted !== null) return legacyPersisted;
    }
    const environmentValue = environment[environmentRef];
    return environmentValue === undefined || environmentValue.length === 0
      ? null
      : environmentValue;
  }

  resolveBaseUrl(profile: ProviderProfile): string | undefined {
    if (profile.baseUrl !== undefined) return profile.baseUrl;
    const builtIn = BUILT_IN_PROVIDERS.find((provider) => provider.id === profile.id);
    return builtIn?.defaultBaseUrl;
  }

  #defaults(): ProviderConfigFile {
    return { schemaVersion: PROVIDER_CONFIG_SCHEMA_VERSION, providers: [] };
  }

  /**
   * Enqueues a complete provider mutation and keeps the tail settled after failures so a failed
   * persistence attempt cannot permanently block later provider operations. Mutators call this
   * private seam directly rather than one another, avoiding promise-tail re-entrancy deadlocks.
   */
  #enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#mutationTail.then(operation);
    this.#mutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

async function readCredential(store: CredentialStore, ref: string): Promise<string | null> {
  try {
    const value = await store.get(ref);
    return value === undefined || value === null || value.length === 0 ? null : value;
  } catch {
    // An unavailable or locked native keychain should not prevent an explicit environment fallback.
    // Backend error messages may contain account names or paths, so they are intentionally omitted.
    return null;
  }
}
