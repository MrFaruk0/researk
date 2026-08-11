import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { parseArguments } from "../src/args.js";
import { DEFAULT_APP_CONFIG } from "../src/config/config.js";
import type { ProviderConfigFile } from "../src/config/providers.js";
import { PersistentProviderRegistry } from "../src/config/providers.js";
import type { Session } from "../src/config/sessions.js";
import type { ConfigStore } from "../src/config/store.js";
import {
  createNonPersistentCredentialStore,
  isFormulaGraphicsProbeEligible,
  isRuntimeColorAllowed,
  isSessionInWorkspace,
  replayTerminalInput,
  resolveStartupColorEnabled,
  restoreState,
} from "../src/tui.js";
import type { CliIo } from "../src/types.js";

function io(isTTY: boolean): CliIo {
  return {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    isTTY,
  };
}

describe("TUI startup policy", () => {
  it.each([
    ["NO_COLOR", [], true, { NO_COLOR: "" }],
    ["TERM=dumb", [], true, { TERM: "DUMB" }],
    ["--accessible", ["--accessible"], true, {}],
    ["--raw", ["--raw"], true, {}],
    ["--json", ["--json"], true, {}],
    ["non-TTY", [], false, {}],
  ])("blocks runtime color for %s", (_name, argv, isTTY, env) => {
    expect(isRuntimeColorAllowed(parseArguments(argv, env), io(isTTY), env)).toBe(false);
    expect(resolveStartupColorEnabled(false, true)).toBe(false);
  });

  it("allows a persisted false preference to disable color, but not a persisted true preference to bypass runtime policy", () => {
    const args = parseArguments([], {});
    expect(isRuntimeColorAllowed(args, io(true), {})).toBe(true);
    expect(resolveStartupColorEnabled(true, false)).toBe(false);
    expect(resolveStartupColorEnabled(true, true)).toBe(true);
    expect(resolveStartupColorEnabled(true, undefined)).toBe(true);
    expect(resolveStartupColorEnabled(false, true)).toBe(false);
  });

  it("accepts only sessions belonging to the current workspace", () => {
    expect(isSessionInWorkspace({ workspace: "C:/research" }, "C:/research")).toBe(true);
    expect(isSessionInWorkspace({ workspace: "C:/other" }, "C:/research")).toBe(false);
    expect(isSessionInWorkspace(null, "C:/research")).toBe(false);
  });

  it("uses a non-persistent credential backend for normal startup", async () => {
    const credentials = createNonPersistentCredentialStore();
    await credentials.set("OPENROUTER_API_KEY", "synthetic-secret");
    await expect(credentials.get("OPENROUTER_API_KEY")).resolves.toBeNull();
  });

  it("does not qualify a provider-less session model under startup's global provider", async () => {
    let stored: ProviderConfigFile = { schemaVersion: 1, providers: [] };
    const providerConfig: ConfigStore<ProviderConfigFile> = {
      async load(defaults) {
        return { ...defaults, ...stored, providers: [...stored.providers] };
      },
      async save(value) {
        stored = { ...value, providers: [...value.providers] };
      },
    };
    const registry = new PersistentProviderRegistry(
      providerConfig,
      createNonPersistentCredentialStore(),
      {},
    );
    const session: Session = {
      schemaVersion: 1,
      id: "providerless-startup",
      title: "Providerless session",
      createdAt: "2026-08-10T10:00:00.000Z",
      updatedAt: "2026-08-10T10:00:00.000Z",
      workspace: "/workspace",
      providerId: null,
      modelId: "science",
      variantId: "high",
      messages: [{ role: "user", content: "Question" }],
    };
    const restored = await restoreState(
      { ...DEFAULT_APP_CONFIG, activeProviderId: "openrouter" },
      registry,
      {},
      session,
    );

    expect(restored.connection?.providerId).toBe("openrouter");
    expect(restored.model).toBeUndefined();
    expect(restored.variant).toBe("auto");
    expect(restored.notices.some((notice) => notice.message.includes("lacked a provider"))).toBe(
      true,
    );
  });

  it.each([
    ["raw", ["--raw"], true, {}],
    ["json", ["--json"], true, {}],
    ["accessible", ["--accessible"], true, {}],
    ["non-TTY", [], false, {}],
    ["CI", [], true, { CI: "1" }],
    ["dumb", [], true, { TERM: "dumb" }],
    ["multiplexer", [], true, { TMUX: "1" }],
  ])("does not authorize graphics probing for %s", (_name, argv, isTTY, env) => {
    expect(isFormulaGraphicsProbeEligible(parseArguments(argv, env), io(isTTY), env)).toBe(false);
  });

  it("authorizes only the normal interactive chat TUI", () => {
    const env = { TERM: "xterm-256color" };
    expect(isFormulaGraphicsProbeEligible(parseArguments([], env), io(true), env)).toBe(true);
    expect(isFormulaGraphicsProbeEligible(parseArguments(["help"], env), io(true), env)).toBe(
      false,
    );
  });

  it("replays unmatched probe bytes into stdin before the consumer mounts", () => {
    const streams = io(true);
    const bytes = Buffer.from("typed-before-ink", "utf8");
    replayTerminalInput(streams, bytes);
    expect(streams.stdin.read()).toEqual(bytes);
  });
});
