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

  const settle = async (): Promise<void> => {
    for (let index = 0; index < 8; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 12));
    }
  };
  const type = async (value: string): Promise<void> => {
    instance.stdin.write(value);
    await settle();
  };
  await settle();
  return {
    ...instance,
    settle,
    type,
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
    // The reference field is prefilled with OPENAI_API_KEY, so clear it before typing.
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
}

async function selectFirstModel(app: Awaited<ReturnType<typeof mount>>): Promise<void> {
  await app.type("/model");
  await app.type(KEYS.enter);
  await app.type(KEYS.enter);
}

describe("TUI over the actual provider path", () => {
  it("stages a workspace document and sends it as untrusted content with the prompt", async () => {
    const provider = await startProvider({ output: "A safe answer" });
    try {
      const app = await mount({
        files: { "paper.tex": "\\section{Methods}\n$E=mc^2$" },
        env: { TEST_KEY: "test-secret" },
      });
      await connect(app, provider.baseUrl, { envReference: "TEST_KEY" });
      await selectFirstModel(app);
      await app.type("/read paper.tex");
      await app.type(KEYS.enter);
      expect(app.frame()).toContain("paper.tex");

      await app.type("Explain the formula");
      await app.type(KEYS.enter);
      await app.settle();

      expect(provider.chatRequests).toHaveLength(1);
      const request = provider.chatRequests[0] as { messages: Array<{ content: string }> };
      const content = request.messages.at(-1)?.content ?? "";
      expect(content).toContain("BEGIN UNTRUSTED WORKSPACE DOCUMENT: paper.tex");
      expect(content).toContain("\\section{Methods}");
      expect(content).toContain("Explain the formula");
      app.unmount();
    } finally {
      await provider.close();
    }
  });

  it("streams provider text into the assistant message across chunk boundaries", async () => {
    const provider = await startProvider({ output: "Streamed provider answer" });
    try {
      const app = await mount({ env: { TEST_KEY: "test-secret" } });
      await connect(app, provider.baseUrl, { envReference: "TEST_KEY" });
      await selectFirstModel(app);
      await app.type("Explain");
      await app.type(KEYS.enter);
      await app.settle();

      expect(app.frame()).toContain("Streamed provider answer");
      expect(app.frame()).toMatch(/ready/u);
      app.unmount();
    } finally {
      await provider.close();
    }
  });

  it("preserves canonical LaTeX from the provider in the retained source", async () => {
    const source = String.raw`Answer: \[E = mc^2\]`;
    const provider = await startProvider({ output: source });
    try {
      const app = await mount({ env: { TEST_KEY: "test-secret" } });
      await connect(app, provider.baseUrl, { envReference: "TEST_KEY" });
      await selectFirstModel(app);
      await app.type("Show the result");
      await app.type(KEYS.enter);
      await app.settle();

      await app.type("/source");
      await app.type(KEYS.enter);
      // The overlay shows the byte-exact canonical source, delimiters included.
      expect(app.frame()).toContain(String.raw`\[E = mc^2\]`);
      app.unmount();
    } finally {
      await provider.close();
    }
  });

  it("never renders an ephemeral pasted credential echoed by the provider", async () => {
    const secret = "synthetic-pasted-guided-key-5da8";
    const provider = await startProvider({ output: `Provider echoed ${secret}` });
    try {
      const app = await mount();
      await connect(app, provider.baseUrl, {
        envReference: "OPENAI_API_KEY",
        secret,
      });
      await selectFirstModel(app);
      await app.type("Explain the result");
      await app.type(KEYS.enter);
      await app.settle();

      const frame = app.frame();
      expect(frame).not.toContain(secret);
      expect(frame).toContain("[REDACTED]");
      // The entered credential is never written back to the environment.
      expect(process.env.OPENAI_API_KEY).toBeUndefined();
      app.unmount();
    } finally {
      await provider.close();
    }
  });

  it("rejects workspace traversal before any provider request", async () => {
    const provider = await startProvider();
    try {
      const app = await mount({ env: { TEST_KEY: "test-secret" } });
      await connect(app, provider.baseUrl, { envReference: "TEST_KEY" });
      await app.type("/read ../outside.md");
      await app.type(KEYS.enter);

      expect(app.frame()).toContain("Parent-directory traversal is not allowed");
      expect(provider.chatRequests).toHaveLength(0);
      app.unmount();
    } finally {
      await provider.close();
    }
  });
});
