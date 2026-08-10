import type { ProviderProfile } from "./providers.js";
import { CURRENT_SCHEMA_VERSION, type ConfigStore } from "./store.js";

export interface AppConfig {
  schemaVersion: number;
  providers: ProviderProfile[];
  activeProviderId: string | null;
  defaultModelByProvider: Record<string, string | undefined>;
  selectedVariantByModel: Record<string, string | undefined>;
  theme: string;
  lastSessionId: string | null;
  colorEnabled: boolean;
}

export const DEFAULT_APP_CONFIG: AppConfig = Object.freeze({
  schemaVersion: CURRENT_SCHEMA_VERSION,
  providers: [],
  activeProviderId: null,
  defaultModelByProvider: {},
  selectedVariantByModel: {},
  theme: "system",
  lastSessionId: null,
  colorEnabled: true,
});

/**
 * Top-level application configuration. Wraps a versioned `ConfigStore<AppConfig>` and exposes the
 * load/save pair the rest of the CLI uses; defaults and the schema key are owned here.
 */
export class AppConfigStore {
  readonly #store: ConfigStore<AppConfig>;

  constructor(store: ConfigStore<AppConfig>) {
    this.#store = store;
  }

  loadConfig(): Promise<AppConfig> {
    return this.#store.load(DEFAULT_APP_CONFIG);
  }

  saveConfig(config: AppConfig): Promise<void> {
    return this.#store.save(config);
  }
}
