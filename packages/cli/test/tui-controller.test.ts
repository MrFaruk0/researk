import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RunEvent } from "@researk/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { type AppConfig, AppConfigStore, DEFAULT_APP_CONFIG } from "../src/config/config.js";
import { FileCredentialStore } from "../src/config/credentials.js";
import { PersistentProviderRegistry } from "../src/config/providers.js";
import { type Session, SessionStore } from "../src/config/sessions.js";
import { type ConfigStore, FileConfigStore } from "../src/config/store.js";
import { composePrompt, TuiController, validateProviderEndpoint } from "../src/tui/controller.js";
import {
  displayText,
  MAX_CHAT_MESSAGE_CHARACTERS,
  type ProviderConnection,
} from "../src/tui/state.js";
import type { CliHarness } from "../src/types.js";
import { openWorkspace } from "../src/workspace.js";

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupPaths.splice(0).map((value) => rm(value, { recursive: true, force: true })),
  );
});

function event(
  partial: Partial<RunEvent> & { type: RunEvent["type"] },
  sequence: number,
): RunEvent {
  return {
    schemaVersion: 1,
    runId: "run-tui",
    sequence,
    timestamp: "2026-08-08T00:00:00.000Z",
    ...partial,
  } as RunEvent;
}

function harnessOf(events: readonly RunEvent[]): CliHarness {
  return {
    async *run(): AsyncIterable<RunEvent> {
      for (const item of events) yield item;
    },
    async listModels() {
      return [];
    },
  };
}

async function makeController(
  harness: CliHarness,
  env: Readonly<Record<string, string | undefined>> = {},
): Promise<TuiController> {
  const root = await mkdtemp(path.join(tmpdir(), "researk-tui-"));
  cleanupPaths.push(root);
  const workspace = await openWorkspace(root);
  return new TuiController({ dependencies: { harness }, env, workspace });
}

const connection: ProviderConnection = {
  providerId: "compatible",
  baseUrl: "https://example.test/v1/",
  apiKeyEnvironmentVariable: "TEST_KEY",
  kind: "compatible",
};

async function collect(
  controller: TuiController,
  options: Readonly<{ credentialValues?: Record<string, string>; signal?: AbortSignal }> = {},
) {
  const events: string[] = [];
  const outcome = await controller.runChat({
    connection,
    credentialValues: options.credentialValues ?? {},
    model: "compatible:science",
    variant: "auto",
    history: [],
    prompt: "Question",
    documents: [],
    signal: options.signal ?? new AbortController().signal,
    onEvent: (item) => {
      events.push(
        item.type === "delta"
          ? `delta:${item.delta}`
          : item.type === "error"
            ? `error:${item.message}`
            : item.type === "diagnostic"
              ? `diagnostic:${item.message}`
              : item.type,
      );
    },
  });
  return { outcome, events };
}

describe("TUI controller streaming", () => {
  it("preserves canonical LaTeX exactly across arbitrary chunk boundaries", async () => {
    const latex = String.raw`Answer: \[\frac{\alpha}{\beta}\] and $E=mc^2$.`;
    const chunks = [latex.slice(0, 7), latex.slice(7, 20), latex.slice(20)];
    const controller = await makeController(
      harnessOf(chunks.map((delta, index) => event({ type: "text_delta", delta }, index))),
    );

    const { outcome } = await collect(controller);
    expect(outcome.text).toBe(latex);
    expect(outcome.failed).toBe(false);
  });

  it("redacts a credential split across streamed chunk boundaries", async () => {
    const secret = "synthetic-tui-secret-9f21";
    const controller = await makeController(
      harnessOf([
        event({ type: "text_delta", delta: `key ${secret.slice(0, 10)}` }, 0),
        event({ type: "text_delta", delta: secret.slice(10) }, 1),
      ]),
    );

    const { outcome, events } = await collect(controller, {
      credentialValues: { TEST_KEY: secret },
    });
    expect(outcome.text).toBe("key [REDACTED]");
    expect(outcome.text).not.toContain(secret);
    expect(events.join("|")).not.toContain(secret);
  });

  it("never reconstructs a self-overlapping secret", async () => {
    const controller = await makeController(
      harnessOf([
        event({ type: "text_delta", delta: "ab" }, 0),
        event({ type: "text_delta", delta: "ab" }, 1),
      ]),
    );
    const { outcome } = await collect(controller, { credentialValues: { TEST_KEY: "abab" } });
    expect(outcome.text).toBe("[REDACTED]");
  });

  it("keeps control characters in canonical source and leaves neutralization to rendering", async () => {
    const controller = await makeController(
      harnessOf([event({ type: "text_delta", delta: "ok\u001b]0;pwned\u0007\u0001" }, 0)]),
    );
    const { outcome } = await collect(controller);
    // The controller is a canonical-source boundary, not a rendering boundary. Escaping here would
    // permanently corrupt the source `/source` reveals and a future export writes, so the raw bytes
    // survive and `displayText` neutralizes them where they are actually drawn.
    expect(outcome.text).toBe("ok\u001b]0;pwned\u0007\u0001");
    expect(displayText(outcome.text)).toBe("ok\\u{001b}]0;pwned\\u{0007}\\u{0001}");
    expect(displayText(outcome.text)).not.toContain("\u001b");
  });

  it("redacts a credential before it can reach canonical source or an event", async () => {
    const secret = "synthetic-canonical-secret-2f9c";
    const controller = await makeController(
      harnessOf([event({ type: "text_delta", delta: `leaked ${secret} tail` }, 0)]),
    );
    const { outcome, events } = await collect(controller, {
      credentialValues: { TEST_KEY: secret },
    });
    // Canonical source is redacted at the boundary, so no credential value is ever retained in
    // state, revealed by `/source`, or replayed as history.
    expect(outcome.text).toBe("leaked [REDACTED] tail");
    expect(outcome.text).not.toContain(secret);
    expect(events.join("|")).not.toContain(secret);
  });

  it("preserves LaTeX unchanged while redacting a secret embedded beside it", async () => {
    const secret = "synthetic-latex-secret-81be";
    const latex = String.raw`\[\frac{\alpha}{\beta}\]`;
    const controller = await makeController(
      harnessOf([
        event({ type: "text_delta", delta: `${latex} key=` }, 0),
        event({ type: "text_delta", delta: `${secret}\u0007 done` }, 1),
      ]),
    );
    const { outcome } = await collect(controller, { credentialValues: { TEST_KEY: secret } });
    // Redaction removes the secret and nothing else: every backslash, brace, and delimiter of the
    // canonical LaTeX is byte-identical, and the raw control byte is still present for rendering
    // to neutralize.
    expect(outcome.text).toBe(`${latex} key=[REDACTED]\u0007 done`);
    expect(outcome.text).toContain(latex);
    expect(displayText(outcome.text)).toContain(latex);
    expect(displayText(outcome.text)).toContain("\\u{0007}");
  });

  it("reports diagnostics and errors as redacted events rather than throwing", async () => {
    const secret = "synthetic-diagnostic-key-4410";
    const controller = await makeController(
      harnessOf([
        event({ type: "diagnostic", level: "warning", code: "p", message: `warn ${secret}` }, 0),
        event(
          {
            type: "error",
            error: { code: "provider_error", message: `fail ${secret}`, retryable: false },
          },
          1,
        ),
      ]),
    );

    const { outcome, events } = await collect(controller, {
      credentialValues: { TEST_KEY: secret },
    });
    expect(outcome.failed).toBe(true);
    expect(events).toContain("diagnostic:warn [REDACTED]");
    expect(events).toContain("error:fail [REDACTED]");
    expect(events.join("|")).not.toContain(secret);
  });

  it("reports cancellation without failing the run", async () => {
    const controller = await makeController(harnessOf([event({ type: "cancelled" }, 0)]));
    const { outcome, events } = await collect(controller);
    expect(outcome.cancelled).toBe(true);
    expect(outcome.failed).toBe(false);
    expect(events).toContain("cancelled");
  });

  it("converts a thrown provider failure into a redacted error event", async () => {
    const secret = "synthetic-throw-key-77";
    const harness: CliHarness = {
      run(): AsyncIterable<RunEvent> {
        // Fails at iteration time, matching a provider that rejects before the first event.
        return {
          [Symbol.asyncIterator]() {
            return {
              next: () => Promise.reject(new Error(`boom ${secret}`)),
            } as AsyncIterator<RunEvent>;
          },
        };
      },
      async listModels() {
        return [];
      },
    };
    const controller = await makeController(harness);
    const { outcome, events } = await collect(controller, {
      credentialValues: { TEST_KEY: secret },
    });
    expect(outcome.failed).toBe(true);
    expect(events.join("|")).toContain("[REDACTED]");
    expect(events.join("|")).not.toContain(secret);
  });

  it("flushes a safe tail before a thrown provider failure without leaking a secret prefix", async () => {
    const secret = "synthetic-tail-secret-throw";
    const harness: CliHarness = {
      run(): AsyncIterable<RunEvent> {
        return {
          async *[Symbol.asyncIterator]() {
            yield event({ type: "text_delta", delta: `safe ${secret.slice(0, -1)}` }, 0);
            throw new Error(`provider failed ${secret}`);
          },
        };
      },
      async listModels() {
        return [];
      },
    };
    const controller = await makeController(harness);
    const { outcome, events } = await collect(controller, {
      credentialValues: { TEST_KEY: secret },
    });

    expect(outcome.text).toBe("safe [REDACTED]");
    expect(outcome.failed).toBe(true);
    expect(events).toEqual(["delta:safe ", "delta:[REDACTED]", "error:provider failed [REDACTED]"]);
    expect(events.join("|")).not.toContain(secret);
    expect(events.join("|")).not.toContain(secret.slice(0, -1));
  });

  it("flushes a safe tail before a cancellation event without leaking a secret prefix", async () => {
    const secret = "synthetic-tail-secret-cancel";
    const controller = await makeController(
      harnessOf([
        event({ type: "text_delta", delta: `safe ${secret.slice(0, -1)}` }, 0),
        event({ type: "cancelled" }, 1),
      ]),
    );

    const { outcome, events } = await collect(controller, {
      credentialValues: { TEST_KEY: secret },
    });

    expect(outcome.text).toBe("safe [REDACTED]");
    expect(outcome.cancelled).toBe(true);
    expect(events).toEqual(["delta:safe ", "delta:[REDACTED]", "cancelled"]);
    expect(events.join("|")).not.toContain(secret);
    expect(events.join("|")).not.toContain(secret.slice(0, -1));
  });
});

/**
 * Everything that can fail before a single event exists. Each of these used to reject out of
 * `runChat`, which stranded the caller's run-ownership bookkeeping instead of reporting a failure.
 */
describe("TUI controller pre-stream failures", () => {
  const root = async (): Promise<string> => {
    const value = await mkdtemp(path.join(tmpdir(), "researk-tui-pre-"));
    cleanupPaths.push(value);
    return value;
  };

  it("reports a createHarness rejection as an error outcome instead of rejecting", async () => {
    const secret = "synthetic-create-harness-key-31";
    const workspace = await openWorkspace(await root());
    const controller = new TuiController({
      dependencies: {
        createHarness: () => Promise.reject(new Error(`cannot construct ${secret}`)),
      },
      env: {},
      workspace,
    });

    const outcome = await expectResolvedRun(controller, { TEST_KEY: secret });
    expect(outcome.result.failed).toBe(true);
    expect(outcome.result.cancelled).toBe(false);
    expect(outcome.result.text).toBe("");
    // The failure is reported, sanitized, through the normal event channel.
    expect(outcome.events.join("|")).toContain("error:cannot construct [REDACTED]");
    expect(outcome.events.join("|")).not.toContain(secret);
    // No delta was ever emitted, so the caller knows the placeholder holds nothing.
    expect(outcome.events.some((item) => item.startsWith("delta:"))).toBe(false);
  });

  it("reports a synchronous createHarness throw as an error outcome", async () => {
    const workspace = await openWorkspace(await root());
    const controller = new TuiController({
      dependencies: {
        createHarness: () => {
          throw new Error("adapter unavailable");
        },
      },
      env: {},
      workspace,
    });
    const outcome = await expectResolvedRun(controller, {});
    expect(outcome.result.failed).toBe(true);
    expect(outcome.events.join("|")).toContain("error:adapter unavailable");
  });

  it("reports an unparsable model identity as an error outcome", async () => {
    const controller = await makeController(harnessOf([]));
    const events: string[] = [];
    const result = await controller.runChat({
      connection,
      credentialValues: {},
      // Request construction fails on the canonical identity before any request exists.
      model: "not-a-canonical-identity",
      variant: "auto",
      history: [],
      prompt: "Question",
      documents: [],
      signal: new AbortController().signal,
      onEvent: (item) => {
        events.push(item.type === "error" ? `error:${item.message}` : item.type);
      },
    });
    expect(result.failed).toBe(true);
    expect(result.text).toBe("");
    expect(events.join("|")).toMatch(/^error:/u);
  });

  it("reports an over-limit composed prompt as an error outcome", async () => {
    const controller = await makeController(harnessOf([]));
    const events: string[] = [];
    const result = await controller.runChat({
      connection,
      credentialValues: {},
      model: "compatible:science",
      variant: "auto",
      history: [],
      prompt: "x".repeat(MAX_CHAT_MESSAGE_CHARACTERS + 1),
      documents: [],
      signal: new AbortController().signal,
      onEvent: (item) => {
        events.push(item.type === "error" ? `error:${item.message}` : item.type);
      },
    });
    expect(result.failed).toBe(true);
    expect(events.join("|")).toContain("character message limit");
  });

  it("reports an empty prompt as an error outcome rather than rejecting", async () => {
    const controller = await makeController(harnessOf([]));
    const events: string[] = [];
    const result = await controller.runChat({
      connection,
      credentialValues: {},
      model: "compatible:science",
      variant: "auto",
      history: [],
      prompt: "",
      documents: [],
      signal: new AbortController().signal,
      onEvent: (item) => {
        events.push(item.type === "error" ? `error:${item.message}` : item.type);
      },
    });
    expect(result.failed).toBe(true);
    expect(events.join("|")).toContain("A prompt is required");
  });

  it("reports a pre-stream failure on an aborted signal as cancellation, not failure", async () => {
    const workspace = await openWorkspace(await root());
    const controller = new TuiController({
      dependencies: { createHarness: () => Promise.reject(new Error("aborted mid-construction")) },
      env: {},
      workspace,
    });
    const aborter = new AbortController();
    aborter.abort();
    const events: string[] = [];
    const result = await controller.runChat({
      connection,
      credentialValues: {},
      model: "compatible:science",
      variant: "auto",
      history: [],
      prompt: "Question",
      documents: [],
      signal: aborter.signal,
      onEvent: (item) => events.push(item.type),
    });
    expect(result.cancelled).toBe(true);
    expect(result.failed).toBe(false);
    expect(events).toContain("cancelled");
  });
});

/** Runs one chat and asserts only that the promise resolved, returning the outcome and events. */
async function expectResolvedRun(
  controller: TuiController,
  credentialValues: Record<string, string>,
): Promise<{ result: Awaited<ReturnType<TuiController["runChat"]>>; events: string[] }> {
  const events: string[] = [];
  const result = await controller.runChat({
    connection,
    credentialValues,
    model: "compatible:science",
    variant: "auto",
    history: [],
    prompt: "Question",
    documents: [],
    signal: new AbortController().signal,
    onEvent: (item) => {
      events.push(
        item.type === "delta"
          ? `delta:${item.delta}`
          : item.type === "error"
            ? `error:${item.message}`
            : item.type,
      );
    },
  });
  return { result, events };
}

describe("TUI controller provider configuration", () => {
  it("applies the OpenRouter default base URL when none is supplied", async () => {
    const controller = await makeController(harnessOf([]));
    const built = controller.buildConnection({
      kind: "openrouter",
      providerId: "openrouter",
      baseUrl: "",
      apiKeyEnvironmentVariable: "OPENROUTER_API_KEY",
    });
    expect(built.baseUrl).toBe("https://openrouter.ai/api/v1/");
    expect(built.apiKeyEnvironmentVariable).toBe("OPENROUTER_API_KEY");
    expect(controller.describeConnection(built)).toContain("openrouter.ai");
  });

  it("requires a base URL for an OpenAI-compatible provider", async () => {
    const controller = await makeController(harnessOf([]));
    expect(() =>
      controller.buildConnection({
        kind: "compatible",
        providerId: "local",
        baseUrl: "",
        apiKeyEnvironmentVariable: "OPENAI_API_KEY",
      }),
    ).toThrow(/requires a base URL/u);
  });

  it("rejects unsafe provider endpoints", () => {
    expect(() => validateProviderEndpoint("https://user:pass@example.test/v1/")).toThrow();
    expect(() => validateProviderEndpoint("https://example.test/v1/?token=x")).toThrow();
    expect(() => validateProviderEndpoint("http://example.test/v1/")).toThrow();
    expect(() => validateProviderEndpoint("not-a-url")).toThrow();
    expect(() => validateProviderEndpoint("http://127.0.0.1:8080/v1/")).not.toThrow();
  });

  it("ignores custom credential references for built-in OpenRouter", async () => {
    const controller = await makeController(harnessOf([]));
    expect(() =>
      controller.buildConnection({
        kind: "openrouter",
        providerId: "openrouter",
        baseUrl: "",
        apiKeyEnvironmentVariable: "bad name!",
      }),
    ).not.toThrow();
  });

  it("describes an endpoint without exposing credentials", async () => {
    const controller = await makeController(harnessOf([]));
    const described = controller.describeConnection({
      providerId: "local",
      baseUrl: "https://example.test/v1/",
      apiKeyEnvironmentVariable: "OPENAI_API_KEY",
      kind: "compatible",
    });
    expect(described).toBe("local (https://example.test)");
  });
});

describe("TUI controller Harness credential rotation", () => {
  it("rebuilds for a rotated effective credential and reuses an unchanged one", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "researk-tui-rotation-"));
    cleanupPaths.push(root);
    const workspace = await openWorkspace(root);
    const harnesses: CliHarness[] = [];
    const resolvedCredentials: string[] = [];
    const controller = new TuiController({
      dependencies: {
        createHarness: async (_configuration, credentials) => {
          resolvedCredentials.push(credentials.TEST_KEY ?? "");
          const harness = harnessOf([]);
          harnesses.push(harness);
          return harness;
        },
      },
      env: {},
      workspace,
    });

    await controller.connect(connection, { TEST_KEY: "synthetic-key-a" });
    await controller.connect(connection, { TEST_KEY: "synthetic-key-a" });
    await controller.connect(connection, { TEST_KEY: "synthetic-key-b" });

    expect(harnesses).toHaveLength(2);
    expect(harnesses[0]).not.toBe(harnesses[1]);
    expect(resolvedCredentials).toEqual(["synthetic-key-a", "synthetic-key-b"]);
  });
});

describe("TUI controller workspace boundary", () => {
  it("stages a supported document and rejects traversal", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "researk-tui-ws-"));
    cleanupPaths.push(root);
    await writeFile(path.join(root, "paper.tex"), "\\section{Methods}", "utf8");
    const workspace = await openWorkspace(root);
    const controller = new TuiController({
      dependencies: { harness: harnessOf([]) },
      env: {},
      workspace,
    });

    const staged = await controller.stageDocument("paper.tex", []);
    expect(staged.relativePath).toBe("paper.tex");
    await expect(controller.stageDocument("../outside.md", [])).rejects.toThrow(
      /Parent-directory traversal/u,
    );
  });

  it("frames staged documents as untrusted reference data", () => {
    const composed = composePrompt("Explain", [
      { relativePath: "paper.tex", content: "$E=mc^2$", byteLength: 8 },
    ]);
    expect(composed).toContain("BEGIN UNTRUSTED WORKSPACE DOCUMENT: paper.tex");
    expect(composed).toContain("untrusted reference data");
    expect(composed).toContain("User request:\nExplain");
  });

  it("sends only the prompt when nothing is staged", () => {
    expect(composePrompt("Explain", [])).toBe("Explain");
  });
});

describe("TUI controller live catalog", () => {
  it("retrieves the catalog from a real loopback OpenAI-compatible provider", async () => {
    const server = createServer((request, response) => {
      if (request.url === "/v1/models" && request.method === "GET") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: "science" }] }));
        return;
      }
      response.writeHead(404);
      response.end();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no bind");

    const root = await mkdtemp(path.join(tmpdir(), "researk-tui-cat-"));
    cleanupPaths.push(root);
    const workspace = await openWorkspace(root);
    const controller = new TuiController({
      dependencies: {},
      env: { TEST_KEY: "synthetic" },
      workspace,
    });

    try {
      const catalog = await controller.connect(
        {
          providerId: "compatible",
          baseUrl: `http://127.0.0.1:${address.port}/v1/`,
          apiKeyEnvironmentVariable: "TEST_KEY",
          kind: "compatible",
        },
        {},
      );
      expect(catalog.map((item) => item.canonicalId)).toEqual(["compatible:science"]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("TUI controller persistence", () => {
  interface StorageFixture {
    directory: string;
    controller: TuiController;
    configStore: AppConfigStore;
    sessionStore: SessionStore;
  }

  function cloneConfig(config: AppConfig): AppConfig {
    return {
      ...config,
      providers: config.providers.map((provider) => ({ ...provider })),
      defaultModelByProvider: { ...config.defaultModelByProvider },
      selectedVariantByModel: { ...config.selectedVariantByModel },
    };
  }

  class ControlledConfigStore implements ConfigStore<AppConfig> {
    #config = cloneConfig(DEFAULT_APP_CONFIG);
    #firstSave = true;
    #releaseFirstSave!: () => void;
    #shouldFailNextSave = false;
    readonly firstSaveStarted: Promise<void>;

    constructor() {
      this.firstSaveStarted = new Promise<void>((resolve) => {
        this.#releaseFirstSave = resolve;
      });
    }

    failNextSave(): void {
      this.#shouldFailNextSave = true;
    }

    releaseFirstSave(): void {
      this.#releaseFirstSave();
    }

    current(): AppConfig {
      return cloneConfig(this.#config);
    }

    async load(defaults: AppConfig): Promise<AppConfig> {
      await Promise.resolve();
      return cloneConfig(this.#config ?? defaults);
    }

    async save(value: AppConfig): Promise<void> {
      if (this.#firstSave) {
        this.#firstSave = false;
        this.#releaseFirstSave();
        await new Promise<void>((resolve) => {
          this.#releaseFirstSave = resolve;
        });
      }
      if (this.#shouldFailNextSave) {
        this.#shouldFailNextSave = false;
        throw new Error("synthetic config write failure");
      }
      this.#config = cloneConfig(value);
    }
  }

  async function makeStorageController(): Promise<StorageFixture> {
    const directory = await mkdtemp(path.join(tmpdir(), "researk-tui-store-"));
    cleanupPaths.push(directory);
    const workspace = await openWorkspace(directory);
    const configStore = new AppConfigStore(new FileConfigStore(directory, "app"));
    const credStore = new FileCredentialStore(path.join(directory, "credentials"));
    const providerRegistry = new PersistentProviderRegistry(
      new FileConfigStore(directory, "providers"),
      credStore,
    );
    const sessionStore = new SessionStore(path.join(directory, "sessions"));
    const controller = new TuiController({
      dependencies: { harness: harnessOf([]) },
      env: {},
      workspace,
      storage: { configStore, sessionStore, providerRegistry, credentialStore: credStore },
    });
    return { directory, controller, configStore, sessionStore };
  }

  it("loads persisted app config and null when nothing is saved", async () => {
    const { controller, configStore } = await makeStorageController();
    expect(await controller.loadConfig()).toEqual(await configStore.loadConfig());
    await configStore.saveConfig({ ...(await configStore.loadConfig()), theme: "nord" });
    expect((await controller.loadConfig())?.theme).toBe("nord");
  });

  it("persists connection, model, variant, theme and session id through saveConfig", async () => {
    const { controller } = await makeStorageController();
    await controller.saveConfig({
      connection: {
        providerId: "compatible",
        baseUrl: "https://example.test/v1/",
        apiKeyEnvironmentVariable: "TEST_KEY",
        kind: "compatible",
      },
      model: "compatible:science",
      variant: "high",
      themeName: "dracula",
      sessionId: "session-abc",
    });
    const loaded = await controller.loadConfig();
    expect(loaded?.activeProviderId).toBe("compatible");
    expect(loaded?.defaultModelByProvider).toEqual({ compatible: "compatible:science" });
    expect(loaded?.selectedVariantByModel).toEqual({ "compatible:science": "high" });
    expect(loaded?.theme).toBe("dracula");
    expect(loaded?.lastSessionId).toBe("session-abc");
  });

  it("keeps a persisted model when saving only a theme", async () => {
    const { controller } = await makeStorageController();
    await controller.saveConfig({
      connection: {
        providerId: "compatible",
        baseUrl: "https://example.test/v1/",
        apiKeyEnvironmentVariable: "TEST_KEY",
        kind: "compatible",
      },
      model: "compatible:science",
    });
    await controller.saveConfig({ themeName: "light" });
    const loaded = await controller.loadConfig();
    expect(loaded?.theme).toBe("light");
    expect(loaded?.defaultModelByProvider.compatible).toBe("compatible:science");
  });

  it("serializes concurrent partial config writes and recovers after a failed write", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "researk-tui-queue-"));
    cleanupPaths.push(directory);
    const workspace = await openWorkspace(directory);
    const controlled = new ControlledConfigStore();
    const controller = new TuiController({
      dependencies: { harness: harnessOf([]) },
      env: {},
      workspace,
      storage: { configStore: new AppConfigStore(controlled) },
    });

    const connection: ProviderConnection = {
      providerId: "compatible",
      baseUrl: "https://example.test/v1/",
      apiKeyEnvironmentVariable: "TEST_KEY",
      kind: "compatible",
    };
    const first = controller.saveConfig({ themeName: "nord" });
    await controlled.firstSaveStarted;
    const second = controller.saveConfig({ sessionId: "session-queued" });
    const third = controller.saveConfig({ connection, model: "compatible:science" });
    controlled.releaseFirstSave();
    await Promise.all([first, second, third]);

    expect(controlled.current()).toMatchObject({
      theme: "nord",
      lastSessionId: "session-queued",
      activeProviderId: "compatible",
      defaultModelByProvider: { compatible: "compatible:science" },
    });

    controlled.failNextSave();
    await Promise.all([
      controller.saveConfig({ themeName: "dark" }),
      controller.saveConfig({ sessionId: "session-after-failure" }),
    ]);
    expect(controlled.current().lastSessionId).toBe("session-after-failure");

    await controller.saveConfig({ themeName: "light" });
    expect(controlled.current().theme).toBe("light");
  });

  it("clears the last session id with an explicit null", async () => {
    const { controller } = await makeStorageController();
    await controller.saveConfig({ sessionId: "session-abc" });
    await controller.saveConfig({ sessionId: null });
    expect((await controller.loadConfig())?.lastSessionId).toBeNull();
  });

  it("lists, loads, saves and deletes sessions through the controller", async () => {
    const { controller, sessionStore } = await makeStorageController();
    const session: Session = {
      schemaVersion: 1,
      id: "session-1",
      title: "Hypothesis",
      createdAt: "2026-08-10T10:00:00.000Z",
      updatedAt: "2026-08-10T10:00:00.000Z",
      workspace: "/workspace",
      providerId: "compatible",
      modelId: "compatible:science",
      variantId: "auto",
      messages: [
        { role: "user", content: "Question" },
        { role: "assistant", content: "Answer" },
      ],
    };
    await controller.saveSession(session);
    expect((await controller.listSessions()).map((entry) => entry.id)).toEqual(["session-1"]);
    expect(await controller.loadSession("session-1")).toEqual(session);
    await controller.deleteSession("session-1");
    expect(await controller.loadSession("session-1")).toBeNull();
    expect(await sessionStore.listSessions()).toHaveLength(0);
  });

  it("titles a conversation from its first user message", () => {
    return makeStorageController().then(async ({ controller }) => {
      expect(controller.autoTitle([{ role: "user", content: "Refine the null hypothesis" }])).toBe(
        "Refine the null hypothesis",
      );
      expect(controller.autoTitle([])).toBe("New session");
    });
  });

  it("persists a provider profile and resolves its credential", async () => {
    const { controller } = await makeStorageController();
    await controller.persistProvider(
      {
        providerId: "compatible",
        baseUrl: "https://example.test/v1/",
        apiKeyEnvironmentVariable: "TEST_KEY",
        kind: "compatible",
      },
      { TEST_KEY: "synthetic-secret" },
    );
    const profile = await controller.getProvider("compatible");
    expect(profile?.protocol).toBe("compatible");
    expect(profile?.baseUrl).toBe("https://example.test/v1/");
    if (profile === undefined) throw new Error("provider profile missing");
    expect(controller.resolveBaseUrl(profile)).toBe("https://example.test/v1/");
    expect(await controller.resolveCredential("compatible")).toBe("synthetic-secret");
  });

  it("no-ops every storage method when no stores are injected", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "researk-tui-nostore-"));
    cleanupPaths.push(root);
    const workspace = await openWorkspace(root);
    const controller = new TuiController({
      dependencies: { harness: harnessOf([]) },
      env: {},
      workspace,
    });
    expect(await controller.loadConfig()).toBeNull();
    await expect(controller.saveConfig({ themeName: "dark" })).resolves.toBeUndefined();
    expect(await controller.listSessions()).toEqual([]);
    expect(await controller.loadSession("nope")).toBeNull();
    await expect(controller.deleteSession("nope")).resolves.toBeUndefined();
    expect(controller.autoTitle([{ role: "user", content: "x" }])).toBe("x");
    expect(await controller.getProvider("openrouter")).toBeUndefined();
    expect(await controller.resolveCredential("openrouter")).toBeNull();
  });
});
