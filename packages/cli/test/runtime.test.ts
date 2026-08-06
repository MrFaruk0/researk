import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough, Readable, Writable } from "node:stream";
import { type RunEvent, RunEventSchema } from "@researk/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../src/run.js";
import type { CliIo } from "../src/types.js";

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupPaths.splice(0).map((value) => rm(value, { recursive: true, force: true })),
  );
});

function captureIo(
  input = "",
  isTTY = false,
): Readonly<{
  io: CliIo;
  stdout: () => string;
  stderr: () => string;
  interrupt: () => void;
}> {
  let stdout = "";
  let stderr = "";
  let interruptHandler: (() => void) | undefined;
  const output = (append: (value: string) => void) =>
    new Writable({
      write(chunk, _encoding, callback) {
        append(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
        callback();
      },
    });
  return {
    io: {
      stdin: Readable.from([input]),
      stdout: output((value) => {
        stdout += value;
      }),
      stderr: output((value) => {
        stderr += value;
      }),
      isTTY,
      onInterrupt(handler) {
        interruptHandler = handler;
        return () => {
          if (interruptHandler === handler) interruptHandler = undefined;
        };
      },
    },
    stdout: () => stdout,
    stderr: () => stderr,
    interrupt: () => interruptHandler?.(),
  };
}

/**
 * Supplies one command only after readline has rendered the next prompt. This keeps the
 * interaction realistic when a command (such as /provider) performs asynchronous I/O.
 * It deliberately runs readline in non-terminal mode: terminal cursor control belongs to
 * Node's readline UI, not to the application output being asserted here.
 */
function captureScriptedReplIo(commands: readonly string[]): Readonly<{
  io: CliIo;
  stdout: () => string;
  stderr: () => string;
}> {
  let stdout = "";
  let stderr = "";
  let nextCommand = 0;
  const input = new PassThrough();
  const deliverNextCommand = () => {
    const command = commands[nextCommand++];
    if (command === undefined) return;
    queueMicrotask(() => input.write(command + "\n"));
  };
  const output = (append: (value: string) => void, isPromptOutput = false) =>
    new Writable({
      write(chunk, _encoding, callback) {
        const value = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
        append(value);
        if (isPromptOutput && value.includes("researk > ")) deliverNextCommand();
        callback();
      },
    });
  return {
    io: {
      stdin: input,
      stdout: Object.assign(
        output((value) => {
          stdout += value;
        }, true),
        { isTTY: false },
      ),
      stderr: output((value) => {
        stderr += value;
      }),
      isTTY: true,
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

interface ProviderFixture {
  readonly baseUrl: string;
  readonly chatRequests: unknown[];
  readonly chatStarted: Promise<void>;
  close(): Promise<void>;
}

async function startProvider(
  options: Readonly<{
    output?: string;
    error?: boolean;
    hold?: boolean;
    secret?: string;
  }> = {},
): Promise<ProviderFixture> {
  const chatRequests: unknown[] = [];
  let signalChatStarted: (() => void) | undefined;
  const chatStarted = new Promise<void>((resolve) => {
    signalChatStarted = resolve;
  });
  const output = options.output ?? "Hello";
  const secret = options.secret ?? "test-secret";

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
      signalChatStarted?.();

      if (options.error === true) {
        response.writeHead(401, { "content-type": "text/plain" });
        response.end("api_key=" + secret + "\u001b]0;unsafe\u0007");
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      if (options.hold === true) {
        request.once("close", () => response.end());
        return;
      }

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
      response.write("data: " + first.slice(0, 17));
      response.write(first.slice(17) + "\n\n");
      response.write("data: " + second + "\n\n");
      response.end("data: " + finish + "\n\ndata: [DONE]\n\n");
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
    baseUrl: "http://127.0.0.1:" + address.port + "/v1/",
    chatRequests,
    chatStarted,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    },
  };
}

async function startOpenRouterProvider(): Promise<ProviderFixture> {
  const chatRequests: unknown[] = [];
  const server = createServer(async (request, response) => {
    const url = request.url ?? "";
    if (url === "/api/v1/models" && request.method === "GET") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          data: [
            {
              id: "acme/reasoner",
              supported_parameters: ["reasoning"],
              reasoning: { supported_efforts: ["high"] },
            },
          ],
        }),
      );
      return;
    }
    if (url === "/api/v1/chat/completions" && request.method === "POST") {
      let body = "";
      for await (const chunk of request) body += Buffer.from(chunk).toString("utf8");
      chatRequests.push(JSON.parse(body) as unknown);
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        "data: " +
          JSON.stringify({
            model: "acme/reasoner",
            choices: [{ delta: { content: "Native OpenRouter" }, finish_reason: "stop" }],
          }) +
          "\n\ndata: [DONE]\n\n",
      );
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
    baseUrl: "http://127.0.0.1:" + address.port + "/api/v1/",
    chatRequests,
    chatStarted: Promise.resolve(),
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    },
  };
}

function compatibleArgs(baseUrl: string): string[] {
  return ["--provider-id", "compatible", "--base-url", baseUrl, "--api-key-env", "TEST_KEY"];
}

describe("CLI actual provider path", () => {
  it("uses the native OpenRouter adapter and its advertised reasoning request shape over loopback", async () => {
    const provider = await startOpenRouterProvider();
    try {
      const capture = captureIo();
      const code = await runCli(
        [
          "chat",
          "--provider-id",
          "openrouter",
          "--base-url",
          provider.baseUrl,
          "--api-key-env",
          "OPENROUTER_TEST_KEY",
          "--model",
          "openrouter:acme/reasoner",
          "--reasoning",
          "high",
          "--raw",
          "Explain this result",
        ],
        {
          io: capture.io,
          env: { OPENROUTER_TEST_KEY: "synthetic-openrouter-secret" },
          createRunId: () => "run-openrouter-native",
        },
      );

      expect(code).toBe(0);
      expect(capture.stdout()).toBe("Native OpenRouter");
      expect(provider.chatRequests).toEqual([
        expect.objectContaining({
          model: "acme/reasoner",
          reasoning: { effort: "high" },
        }),
      ]);
    } finally {
      await provider.close();
    }
  });

  it("runs the real CLI, Harness, adapter, model discovery, and split SSE response", async () => {
    const provider = await startProvider({ output: "Hello from SSE" });
    try {
      const capture = captureIo();
      const code = await runCli(
        [
          "chat",
          ...compatibleArgs(provider.baseUrl),
          "--model",
          "compatible:science",
          "--raw",
          "Summarize",
          "this",
        ],
        {
          io: capture.io,
          env: { TEST_KEY: "test-secret" },
          createRunId: () => "run-sse",
        },
      );

      expect(code).toBe(0);
      expect(capture.stdout()).toBe("Hello from SSE");
      expect(capture.stderr()).toBe("");
      expect(provider.chatRequests).toHaveLength(1);
      expect(provider.chatRequests[0]).toMatchObject({
        model: "science",
        messages: [{ role: "user", content: "Summarize this" }],
      });
    } finally {
      await provider.close();
    }
  });

  it("emits typed JSON Lines through the actual local provider path", async () => {
    const provider = await startProvider();
    try {
      const capture = captureIo();
      const code = await runCli(
        [
          "chat",
          ...compatibleArgs(provider.baseUrl),
          "--model",
          "compatible:science",
          "--json",
          "Question",
        ],
        { io: capture.io, env: { TEST_KEY: "test-secret" }, createRunId: () => "run-json" },
      );

      expect(code).toBe(0);
      const events = capture
        .stdout()
        .trim()
        .split("\n")
        .map((line) => RunEventSchema.parse(JSON.parse(line) as RunEvent));
      expect(events.some((event) => event.type === "selection")).toBe(true);
      expect(events.some((event) => event.type === "text_delta")).toBe(true);
      expect(events.at(-1)?.type).toBe("completed");
      expect(capture.stderr()).toBe("");
    } finally {
      await provider.close();
    }
  });

  it("redacts real provider errors and terminal escapes", async () => {
    const secret = "real-secret-value";
    const provider = await startProvider({ error: true, secret });
    try {
      const capture = captureIo();
      const code = await runCli(
        ["chat", ...compatibleArgs(provider.baseUrl), "--model", "compatible:science", "Question"],
        { io: capture.io, env: { TEST_KEY: secret }, createRunId: () => "run-redaction" },
      );

      expect(code).toBe(1);
      expect(capture.stdout()).toBe("");
      expect(capture.stderr()).not.toContain(secret);
      expect(capture.stderr()).not.toContain("\u001b");
      expect(capture.stderr()).toContain("[REDACTED]");
    } finally {
      await provider.close();
    }
  });

  it("forwards Ctrl-C cancellation to the real loopback provider stream", async () => {
    const provider = await startProvider({ hold: true });
    try {
      const capture = captureIo();
      const run = runCli(
        ["chat", ...compatibleArgs(provider.baseUrl), "--model", "compatible:science", "Question"],
        { io: capture.io, env: { TEST_KEY: "test-secret" }, createRunId: () => "run-cancel" },
      );
      await provider.chatStarted;
      capture.interrupt();

      expect(await run).toBe(130);
      expect(capture.stderr()).toContain("Cancelled.");
    } finally {
      await provider.close();
    }
  });

  it("uses the workspace REPL only after an explicit document read and prompt", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "researk-repl-"));
    cleanupPaths.push(root);
    await writeFile(path.join(root, "paper.tex"), "\\section{Methods}\\n$E=mc^2$", "utf8");
    const provider = await startProvider({ output: "A safe answer\u001b]0;unsafe\u0007" });
    try {
      const capture = captureScriptedReplIo([
        "/provider compatible compatible " + provider.baseUrl + " TEST_KEY",
        "/read paper.tex",
        "/model compatible:science",
        "/reasoning high",
        "/status",
        "Explain the formula",
        "/exit",
      ]);
      const code = await runCli([], {
        io: capture.io,
        env: { TEST_KEY: "test-secret", NO_COLOR: "1" },
        cwd: root,
        createRunId: () => "run-repl",
      });

      expect(code).toBe(0);
      expect(capture.stdout()).toContain("Workspace:");
      expect(capture.stdout()).toContain("Staged paper.tex");
      expect(capture.stdout()).toContain("catalog:");
      expect(capture.stdout()).not.toContain("\u001b");
      expect(capture.stderr()).toContain(
        "[external] Sending your prompt and 1 staged workspace document",
      );
      expect(capture.stderr()).toContain("Unsupported reasoning intent");
      expect(capture.stderr()).not.toContain("\u001b");
      expect(provider.chatRequests).toHaveLength(1);
      expect(provider.chatRequests[0]).toMatchObject({
        messages: [
          {
            role: "user",
            content: expect.stringContaining("BEGIN UNTRUSTED WORKSPACE DOCUMENT: paper.tex"),
          },
        ],
      });
      const request = provider.chatRequests[0] as { messages: Array<{ content: string }> };
      expect(request.messages.at(-1)?.content).toContain("\\section{Methods}");
      expect(request.messages.at(-1)?.content).toContain("Explain the formula");
    } finally {
      await provider.close();
    }
  });

  it("rejects workspace traversal before any provider request", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "researk-traversal-"));
    cleanupPaths.push(root);
    const capture = captureScriptedReplIo(["/read ../outside.md", "/exit"]);

    const code = await runCli([], {
      io: capture.io,
      env: { NO_COLOR: "1" },
      cwd: root,
    });

    expect(code).toBe(0);
    expect(capture.stderr()).toContain("Parent-directory traversal is not allowed");
    expect(capture.stderr()).not.toContain("\u001b");
  });
});
