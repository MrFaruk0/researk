import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { render } from "ink-testing-library";
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "../src/tui/App.js";
import { TuiController } from "../src/tui/controller.js";
import { createInitialState } from "../src/tui/state.js";
import { openWorkspace } from "../src/workspace.js";

const KEYS = {
  enter: "\r",
  down: "\u001b[B",
  tab: "\t",
  backspace: "\u007f",
};

/**
 * These tests drive the real path end to end: a loopback HTTP server, the in-process Harness, the
 * OpenAI-compatible adapter, and a live Ink render tree. Each simulated keystroke has to settle
 * real timers before the next one, because Ink commits on the macrotask queue and there is no
 * fake-timer mode that keeps the adapter's real `fetch` working.
 *
 * The cost is dominated by scheduling rather than by any single slow operation: several dozen
 * keystrokes per test, each with its own timer hops and a full Ink re-render, plus TCP
 * listen/accept and adapter construction. Timer resolution, timer coalescing, and libuv loop
 * latency all differ by platform and by CI load, which is why this file previously ran near the
 * 5s Vitest default on one runner and past it on another. That is a budget and scheduling limit,
 * not a hang, so the suite carries one explicit generous timeout rather than a global one that
 * would also mask genuine hangs in the fast unit suites. Every wait on asynchronous work is
 * condition-based, so the headroom is only ever consumed by a real failure.
 */
const PROVIDER_SUITE_TIMEOUT_MS = 30_000;

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupPaths.splice(0).map((value) => rm(value, { recursive: true, force: true })),
  );
});

interface ProviderFixture {
  readonly baseUrl: string;
  readonly chatRequests: unknown[];
  close(): Promise<void>;
}

/**
 * Starts a loopback OpenAI-compatible endpoint so the TUI exercises the real
 * Harness, adapter, and streaming path rather than a stubbed harness.
 */
async function startProvider(
  options: Readonly<{ output?: string }> = {},
): Promise<ProviderFixture> {
  const chatRequests: unknown[] = [];
  const output = options.output ?? "Hello";

  const server = createServer(async (request, response) => {
    const url = request.url ?? "";
    if (url === "/v1/models" && request.method === "GET") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: "science" }] }));
      return;
    }
    if (url === "/v1/chat/completions" && request.method === "POST") {
      let body = "";
      for await (const chunk of request) body += Buffer.from(chunk).toString("utf8");
      chatRequests.push(JSON.parse(body) as unknown);
      response.writeHead(200, { "content-type": "text/event-stream" });
      // Split the payload mid-token to cover chunk-boundary handling.
      const first = JSON.stringify({
        model: "science",
        choices: [{ delta: { content: output.slice(0, 3) }, finish_reason: null }],
      });
      const second = JSON.stringify({
        model: "science",
        choices: [{ delta: { content: output.slice(3) }, finish_reason: null }],
      });
      const finish = JSON.stringify({
        model: "science",
        choices: [{ delta: {}, finish_reason: "stop" }],
      });
      response.write(`data: ${first.slice(0, 17)}`);
      response.write(`${first.slice(17)}\n\n`);
      response.write(`data: ${second}\n\n`);
      response.end(`data: ${finish}\n\ndata: [DONE]\n\n`);
      return;
    }
    response.writeHead(404);
    response.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Test server did not bind.");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1/`,
    chatRequests,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    },
  };
}

async function mount(
  options: Readonly<{ files?: Record<string, string>; env?: Record<string, string> }> = {},
) {
  const root = await mkdtemp(path.join(tmpdir(), "researk-tui-live-"));
  cleanupPaths.push(root);
  for (const [name, content] of Object.entries(options.files ?? {})) {
    await writeFile(path.join(root, name), content, "utf8");
  }
  const workspace = await openWorkspace(root);
  // Empty dependencies force the controller to build the real in-process Harness and adapter.
  const controller = new TuiController({
    dependencies: {},
    env: options.env ?? {},
    workspace,
  });
  const instance = render(
    React.createElement(App, {
      controller,
      initialState: createInitialState({
        workspaceRoot: workspace.root,
        themeName: "dark",
        colorEnabled: false,
        variant: "auto",
      }),
      onExit: () => undefined,
    }),
  );

  /**
   * Lets Ink flush the render it scheduled for the keystroke just written. Four macrotask hops are
   * enough for a synchronous reducer update plus its commit; anything that awaits the Harness is
   * covered by `waitFor` instead, so this no longer has to be padded to cover network latency.
   */
  const settle = async (): Promise<void> => {
    for (let index = 0; index < 4; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  };
  const type = async (value: string): Promise<void> => {
    instance.stdin.write(value);
    await settle();
  };
  /**
   * Waits for a rendered condition instead of assuming a fixed number of settle rounds is enough.
   * Keystroke handling is synchronous in Ink, but anything that awaits the Harness - connecting,
   * loading the catalog, streaming a response - completes on its own schedule, and a fixed sleep
   * either wastes time or is too short on a loaded runner. Polling keeps the fast path fast and
   * still bounds the wait, and the caller's own assertion is left untouched: on timeout this
   * returns normally so the real `expect` reports the actual frame.
   */
  const waitFor = async (predicate: () => boolean, budgetMs = 10_000): Promise<void> => {
    const deadline = Date.now() + budgetMs;
    while (!predicate() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 12));
    }
  };
  await settle();
  return {
    ...instance,
    settle,
    type,
    waitFor,
    workspaceRoot: workspace.root,
    frame: () => instance.lastFrame() ?? "",
  };
}

/** Drives the real provider overlay form for the OpenAI-compatible adapter. */
async function connect(
  app: Awaited<ReturnType<typeof mount>>,
  baseUrl: string,
  key: Readonly<{ envReference?: string; secret?: string }> = {},
): Promise<void> {
  await app.type("/provider");
  await app.type(KEYS.enter);
  await app.type(KEYS.down);
  await app.type(KEYS.enter);
  await app.type("compatible");
  await app.type(KEYS.tab);
  await app.type(baseUrl);
  await app.type(KEYS.tab);
  if (key.envReference !== undefined) {
    // The reference field is prefilled with OPENAI_API_KEY, so clear it before typing. Each
    // backspace must be written separately: Ink delivers one stdin write as a single `input`
    // string, so a batched burst would be handled as one keypress and delete one character.
    for (let index = 0; index < "OPENAI_API_KEY".length; index += 1) {
      await app.type(KEYS.backspace);
    }
    await app.type(key.envReference);
  }
  if (key.secret !== undefined) {
    await app.type(KEYS.tab);
    await app.type(key.secret);
  }
  await app.type(KEYS.enter);
  // Submitting the form performs the real catalog request against the loopback server. The footer
  // is the durable signal that the connection landed: notices are capped and truncated for display,
  // so matching their text would be brittle.
  await app.waitFor(() => /provider\s+compatible/u.test(app.frame()));
}

async function selectFirstModel(app: Awaited<ReturnType<typeof mount>>): Promise<void> {
  await app.type("/model");
  await app.type(KEYS.enter);
  // The overlay opens before the catalog is loaded, so wait for a selectable row to exist rather
  // than pressing Enter into an empty list.
  await app.waitFor(() => app.frame().includes("science"));
  await app.type(KEYS.enter);
  // The footer shows the selected model once the overlay has committed the choice.
  await app.waitFor(() => /model\s+compatible:science/u.test(app.frame()));
}

describe("TUI over the actual provider path", () => {
  it(
    "stages a workspace document and sends it as untrusted content with the prompt",
    async () => {
      const provider = await startProvider({ output: "A safe answer" });
      let app: Awaited<ReturnType<typeof mount>> | undefined;
      try {
        app = await mount({
          files: { "paper.tex": "\\section{Methods}\n$E=mc^2$" },
          env: { TEST_KEY: "test-secret" },
        });
        await connect(app, provider.baseUrl, { envReference: "TEST_KEY" });
        await selectFirstModel(app);
        await app.type("/read paper.tex");
        await app.type(KEYS.enter);
        // Staging reads the file from disk, so the confirmation is awaited rather than assumed.
        const staged = app;
        await staged.waitFor(() => staged.frame().includes("paper.tex"));
        expect(app.frame()).toContain("paper.tex");

        await app.type("Explain the formula");
        await app.type(KEYS.enter);
        await app.waitFor(() => provider.chatRequests.length > 0);

        expect(provider.chatRequests).toHaveLength(1);
        const request = provider.chatRequests[0] as { messages: Array<{ content: string }> };
        const content = request.messages.at(-1)?.content ?? "";
        expect(content).toContain("BEGIN UNTRUSTED WORKSPACE DOCUMENT: paper.tex");
        expect(content).toContain("\\section{Methods}");
        expect(content).toContain("Explain the formula");
      } finally {
        // Unmounting in `finally` keeps a failed assertion from leaving a live Ink instance and its
        // stdin listener attached for the remainder of the file.
        app?.unmount();
        await provider.close();
      }
    },
    PROVIDER_SUITE_TIMEOUT_MS,
  );

  it(
    "streams provider text into the assistant message across chunk boundaries",
    async () => {
      const provider = await startProvider({ output: "Streamed provider answer" });
      let app: Awaited<ReturnType<typeof mount>> | undefined;
      try {
        app = await mount({ env: { TEST_KEY: "test-secret" } });
        await connect(app, provider.baseUrl, { envReference: "TEST_KEY" });
        await selectFirstModel(app);
        await app.type("Explain");
        await app.type(KEYS.enter);
        const rendered = app;
        await rendered.waitFor(() => rendered.frame().includes("Streamed provider answer"));

        expect(app.frame()).toContain("Streamed provider answer");
        expect(app.frame()).toMatch(/ready/u);
      } finally {
        app?.unmount();
        await provider.close();
      }
    },
    PROVIDER_SUITE_TIMEOUT_MS,
  );

  it(
    "preserves canonical LaTeX from the provider in the retained source",
    async () => {
      const source = String.raw`Answer: \[E = mc^2\]`;
      const provider = await startProvider({ output: source });
      let app: Awaited<ReturnType<typeof mount>> | undefined;
      try {
        app = await mount({ env: { TEST_KEY: "test-secret" } });
        await connect(app, provider.baseUrl, { envReference: "TEST_KEY" });
        await selectFirstModel(app);
        await app.type("Show the result");
        await app.type(KEYS.enter);
        const rendered = app;
        // The run has to finish before `/source` can reveal the retained canonical text.
        await rendered.waitFor(() => rendered.frame().includes("E = mc^2"));

        await app.type("/source");
        await app.type(KEYS.enter);
        const overlay = app;
        await overlay.waitFor(() => overlay.frame().includes(String.raw`\[E = mc^2\]`));
        // The overlay shows the byte-exact canonical source, delimiters included.
        expect(app.frame()).toContain(String.raw`\[E = mc^2\]`);
      } finally {
        app?.unmount();
        await provider.close();
      }
    },
    PROVIDER_SUITE_TIMEOUT_MS,
  );

  it(
    "never renders an ephemeral pasted credential echoed by the provider",
    async () => {
      const secret = "synthetic-pasted-guided-key-5da8";
      const provider = await startProvider({ output: `Provider echoed ${secret}` });
      let app: Awaited<ReturnType<typeof mount>> | undefined;
      try {
        app = await mount();
        await connect(app, provider.baseUrl, {
          envReference: "OPENAI_API_KEY",
          secret,
        });
        await selectFirstModel(app);
        await app.type("Explain the result");
        await app.type(KEYS.enter);
        const rendered = app;
        // Wait on the redacted marker, never on the secret, which must not appear in any frame.
        await rendered.waitFor(() => rendered.frame().includes("[REDACTED]"));

        const frame = app.frame();
        expect(frame).not.toContain(secret);
        expect(frame).toContain("[REDACTED]");
        // The entered credential is never written back to the environment.
        expect(process.env.OPENAI_API_KEY).toBeUndefined();
      } finally {
        app?.unmount();
        await provider.close();
      }
    },
    PROVIDER_SUITE_TIMEOUT_MS,
  );

  it(
    "rejects workspace traversal before any provider request",
    async () => {
      const provider = await startProvider();
      let app: Awaited<ReturnType<typeof mount>> | undefined;
      try {
        app = await mount({ env: { TEST_KEY: "test-secret" } });
        await connect(app, provider.baseUrl, { envReference: "TEST_KEY" });
        await app.type("/read ../outside.md");
        await app.type(KEYS.enter);
        // Rejection happens in the same async staging path, so wait for the error to be rendered.
        const rejected = app;
        await rejected.waitFor(() =>
          rejected.frame().includes("Parent-directory traversal is not allowed"),
        );

        expect(app.frame()).toContain("Parent-directory traversal is not allowed");
        expect(provider.chatRequests).toHaveLength(0);
      } finally {
        app?.unmount();
        await provider.close();
      }
    },
    PROVIDER_SUITE_TIMEOUT_MS,
  );
});
