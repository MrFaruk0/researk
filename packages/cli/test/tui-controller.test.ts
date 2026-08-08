import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RunEvent } from "@researk/contracts";
import { afterEach, describe, expect, it } from "vitest";
import type { CliHarness } from "../src/types.js";
import { composePrompt, TuiController, validateProviderEndpoint } from "../src/tui/controller.js";
import {
  displayText,
  MAX_CHAT_MESSAGE_CHARACTERS,
  type ProviderConnection,
} from "../src/tui/state.js";
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
    expect(built.baseUrl).toBeUndefined();
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

  it("rejects an invalid credential environment reference", async () => {
    const controller = await makeController(harnessOf([]));
    expect(() =>
      controller.buildConnection({
        kind: "openrouter",
        providerId: "openrouter",
        baseUrl: "",
        apiKeyEnvironmentVariable: "bad name!",
      }),
    ).toThrow();
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
