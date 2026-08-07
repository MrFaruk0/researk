import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough, Readable, Writable } from "node:stream";
import { type RunEvent, RunEventSchema } from "@researk/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { executeChat, runCli } from "../src/run.js";
import { createTheme } from "../src/theme.js";
import type { CliIo } from "../src/types.js";

/** A harness that replays fixed text deltas, so rendering can be asserted deterministically. */
function textHarness(runId: string, deltas: readonly string[]) {
  return {
    async *run(): AsyncIterable<RunEvent> {
      for (const [sequence, delta] of deltas.entries()) {
        yield {
          schemaVersion: 1,
          type: "text_delta",
          runId,
          sequence,
          timestamp: "2026-08-07T00:00:00.000Z",
          delta,
        };
      }
    },
    async listModels() {
      return [];
    },
  };
}

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
    queueMicrotask(() => input.write(`${command}\n`));
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

function captureGuidedReplIo(
  steps: readonly Readonly<{ expect: string; input: readonly string[] }>[],
  stdoutIsTTY = false,
): Readonly<{ io: CliIo; stdout: () => string; stderr: () => string }> {
  let stdout = "";
  let stderr = "";
  let nextStep = 0;
  let inspectedThrough = 0;
  const input = new PassThrough() as PassThrough & { setRawMode?: (enabled: boolean) => void };
  input.setRawMode = () => undefined;
  const advance = () => {
    const step = steps[nextStep];
    if (step === undefined) return;
    const match = stdout.indexOf(step.expect, inspectedThrough);
    if (match < 0) return;
    inspectedThrough = match + step.expect.length;
    nextStep++;
    queueMicrotask(() => {
      for (const chunk of step.input) input.write(chunk);
    });
  };
  const output = (append: (value: string) => void, advances = false) =>
    new Writable({
      write(chunk, _encoding, callback) {
        append(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
        if (advances) advance();
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
        { isTTY: stdoutIsTTY },
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
        response.end(`api_key=${secret}\u001b]0;unsafe\u0007`);
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
    baseUrl: `http://127.0.0.1:${address.port}/api/v1/`,
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
  it("rejects an argument-less invocation when standard input is not a TTY", async () => {
    const capture = captureIo();

    await expect(runCli([], { io: capture.io, env: {} })).resolves.toBe(2);
    expect(capture.stderr()).toContain("a command is required when standard input is not a TTY");
  });

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

  it("preserves canonical LaTeX in non-TTY and JSON output", async () => {
    const latex = String.raw`Result: \[\frac{\alpha_1}{\beta^2}\] and $E=mc^2$.`;
    const provider = await startProvider({ output: latex });
    try {
      const plain = captureIo();
      const plainCode = await runCli(
        ["chat", ...compatibleArgs(provider.baseUrl), "--model", "compatible:science", "Question"],
        { io: plain.io, env: { TEST_KEY: "test-secret" }, createRunId: () => "run-latex" },
      );
      expect(plainCode).toBe(0);
      expect(plain.stdout()).toBe(latex);

      const json = captureIo();
      const jsonCode = await runCli(
        [
          "chat",
          ...compatibleArgs(provider.baseUrl),
          "--model",
          "compatible:science",
          "--json",
          "Question",
        ],
        { io: json.io, env: { TEST_KEY: "test-secret" }, createRunId: () => "run-latex-json" },
      );
      expect(jsonCode).toBe(0);
      const reconstructed = json
        .stdout()
        .trim()
        .split("\n")
        .map((line) => RunEventSchema.parse(JSON.parse(line) as RunEvent))
        .filter((event) => event.type === "text_delta")
        .map((event) => event.delta)
        .join("");
      expect(reconstructed).toBe(latex);
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

  it("uses an ephemeral guided credential and redacts provider output without environment mutation", async () => {
    const secret = "synthetic-guided-key-output-7f3a";
    const provider = await startProvider({ output: `x ${secret}` });
    const env: Record<string, string | undefined> = { NO_COLOR: "1" };
    const priorProcessValue = process.env.TEST_KEY;
    try {
      const capture = captureIo();
      const code = await runCli(
        ["chat", ...compatibleArgs(provider.baseUrl), "--model", "compatible:science", "Question"],
        {
          io: capture.io,
          env,
          credentialValues: { TEST_KEY: secret },
          createRunId: () => "run-guided-output-redaction",
        },
      );

      expect(code).toBe(0);
      expect(capture.stdout()).toContain("x [REDACTED]");
      expect(capture.stdout()).not.toContain(secret);
      expect(capture.stderr()).not.toContain(secret);
      expect(env.TEST_KEY).toBeUndefined();
      expect(process.env.TEST_KEY).toBe(priorProcessValue);
    } finally {
      await provider.close();
    }
  });

  it("redacts an ephemeral guided credential echoed by provider errors", async () => {
    const secret = "synthetic-guided-key-error-91bd";
    const provider = await startProvider({ error: true, secret });
    try {
      const capture = captureIo();
      const code = await runCli(
        ["chat", ...compatibleArgs(provider.baseUrl), "--model", "compatible:science", "Question"],
        {
          io: capture.io,
          env: {},
          credentialValues: { TEST_KEY: secret },
          createRunId: () => "run-guided-error-redaction",
        },
      );

      expect(code).toBe(1);
      expect(capture.stdout()).not.toContain(secret);
      expect(capture.stderr()).toContain("[REDACTED]");
      expect(capture.stderr()).not.toContain(secret);
    } finally {
      await provider.close();
    }
  });

  it("passes ephemeral credentials to provider construction and redacts construction failures", async () => {
    const secret = "synthetic-guided-key-construction-a805";
    const capture = captureIo();
    const env: Record<string, string | undefined> = {};

    const code = await runCli(
      ["models", "--provider-id", "openrouter", "--api-key-env", "TEST_KEY"],
      {
        io: capture.io,
        env,
        credentialValues: { TEST_KEY: secret },
        createHarness: async (_configuration, credentialValues) => {
          expect(credentialValues).toEqual({ TEST_KEY: secret });
          throw new Error(`construction ${credentialValues.TEST_KEY}`);
        },
      },
    );

    expect(code).toBe(1);
    expect(capture.stdout()).not.toContain(secret);
    expect(capture.stderr()).toContain("construction [REDACTED]");
    expect(capture.stderr()).not.toContain(secret);
    expect(env.TEST_KEY).toBeUndefined();
  });

  it("redacts ephemeral credentials from streamed diagnostics, errors, and returned text", async () => {
    const secret = "synthetic-guided-key-events-c42e";
    const capture = captureIo();
    const harness = {
      async *run(): AsyncIterable<RunEvent> {
        yield {
          schemaVersion: 1,
          type: "text_delta",
          runId: "run-guided-events",
          sequence: 0,
          timestamp: "2026-08-07T00:00:00.000Z",
          delta: `answer ${secret.slice(0, 12)}`,
        };
        yield {
          schemaVersion: 1,
          type: "diagnostic",
          runId: "run-guided-events",
          sequence: 1,
          timestamp: "2026-08-07T00:00:00.000Z",
          level: "warning",
          code: "provider_echo",
          message: `diagnostic ${secret}`,
        };
        yield {
          schemaVersion: 1,
          type: "text_delta",
          runId: "run-guided-events",
          sequence: 2,
          timestamp: "2026-08-07T00:00:00.000Z",
          delta: secret.slice(12),
        };
        yield {
          schemaVersion: 1,
          type: "error",
          runId: "run-guided-events",
          sequence: 3,
          timestamp: "2026-08-07T00:00:00.000Z",
          error: { code: "provider_error", message: `failure ${secret}`, retryable: false },
        };
      },
      async listModels() {
        return [];
      },
    };

    const result = await executeChat({
      harness,
      model: "compatible:science",
      reasoning: "auto",
      messages: [{ role: "user", content: "Question" }],
      io: capture.io,
      json: false,
      raw: true,
      env: {},
      apiKeyEnvironmentVariable: "TEST_KEY",
      credentialValues: { TEST_KEY: secret },
      createRunId: () => "run-guided-events",
    });

    expect(result.exitCode).toBe(1);
    expect(result.text).toBe("answer [REDACTED]");
    expect(capture.stdout()).toBe("answer [REDACTED]");
    expect(capture.stderr()).toContain("diagnostic [REDACTED]");
    expect(capture.stderr()).toContain("failure [REDACTED]");
    expect(capture.stdout()).not.toContain(secret);
    expect(capture.stderr()).not.toContain(secret);
  });

  it("never emits a self-overlapping secret split across streamed text events", async () => {
    const secret = "abab";
    const capture = captureIo();
    const harness = {
      async *run(): AsyncIterable<RunEvent> {
        for (const [sequence, delta] of ["ab", "ab"].entries()) {
          yield {
            schemaVersion: 1,
            type: "text_delta",
            runId: "run-overlapping-secret",
            sequence,
            timestamp: "2026-08-07T00:00:00.000Z",
            delta,
          };
        }
      },
      async listModels() {
        return [];
      },
    };

    const result = await executeChat({
      harness,
      model: "compatible:science",
      reasoning: "auto",
      messages: [{ role: "user", content: "Question" }],
      io: capture.io,
      json: false,
      raw: true,
      env: {},
      apiKeyEnvironmentVariable: "TEST_KEY",
      credentialValues: { TEST_KEY: secret },
      createRunId: () => "run-overlapping-secret",
    });

    expect(result.exitCode).toBe(0);
    expect(result.text).toBe("[REDACTED]");
    expect(capture.stdout()).toBe("[REDACTED]");
    expect(capture.stdout()).not.toContain(secret);
    expect(capture.stderr()).not.toContain(secret);
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
        `/provider compatible compatible ${provider.baseUrl} TEST_KEY`,
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

  it("reveals the latest assistant response as exact source with /source", async () => {
    const source = String.raw`Answer: \[E = mc^2\]`;
    const provider = await startProvider({ output: source });
    try {
      const capture = captureGuidedReplIo(
        [
          {
            expect: "researk > ",
            input: [`/provider compatible compatible ${provider.baseUrl} TEST_KEY\n`],
          },
          { expect: "researk > ", input: ["/model compatible:science\n"] },
          { expect: "researk > ", input: ["Show the result\n"] },
          {
            expect: "\u001b]1337;File=inline=1;preserveAspectRatio=1:",
            input: ["/source\n"],
          },
          { expect: source, input: ["/exit\n"] },
        ],
        true,
      );
      const code = await runCli([], {
        io: capture.io,
        env: {
          TEST_KEY: "test-secret",
          NO_COLOR: "1",
          TERM_PROGRAM: "iTerm.app",
          TERM_PROGRAM_VERSION: "3.5.14",
        },
        createRunId: () => "run-repl-source",
      });

      expect(code).toBe(0);
      expect(capture.stdout().split(source)).toHaveLength(2);
      expect(capture.stdout()).toContain("\u001b]1337;File=inline=1;preserveAspectRatio=1:");
      expect(capture.stderr()).toContain("[external] Sending your prompt");
      expect(provider.chatRequests).toHaveLength(1);
    } finally {
      await provider.close();
    }
  });

  it("keeps argument-less REPL theme changes plain in accessible mode", async () => {
    const capture = captureGuidedReplIo([
      { expect: "researk > ", input: ["/theme\n"] },
      { expect: "Theme  (", input: ["\u001b[B", "\r"] },
      { expect: "Theme set to dark.", input: ["/exit\n"] },
    ]);

    const code = await runCli(["--accessible"], {
      io: capture.io,
      env: {},
    });

    expect(code).toBe(0);
    const stdout = capture.stdout();
    const themeChange = stdout.indexOf("Theme set to dark.");
    expect(themeChange).toBeGreaterThanOrEqual(0);
    expect(stdout.slice(themeChange)).not.toContain("\u001b");
    expect(capture.stderr()).not.toContain("\u001b");
  });

  it("runs the guided TTY provider, masked key, model, chat, and cancellation flow", async () => {
    const secret = "synthetic-pasted-guided-key-5da8";
    const provider = await startProvider({ output: `Provider echoed ${secret}` });
    try {
      const capture = captureGuidedReplIo([
        { expect: "researk > ", input: ["/provider\n"] },
        { expect: "OpenAI-compatible", input: ["\u001b[", "B", "\r"] },
        { expect: "Provider ID: ", input: ["compatible\n"] },
        { expect: "Base URL: ", input: [`${provider.baseUrl}\n`] },
        { expect: "OPENAI_API_KEY (masked): ", input: [secret, "\r"] },
        { expect: "researk > ", input: ["/model\n"] },
        { expect: "compatible:science", input: ["\r"] },
        { expect: "researk > ", input: ["Explain the result\n"] },
        { expect: "Provider echoed [REDACTED]", input: [] },
        { expect: "researk > ", input: ["/provider\n"] },
        { expect: "OpenAI-compatible", input: ["\u001b"] },
        { expect: "researk > ", input: ["/exit\n"] },
      ]);

      const code = await runCli([], {
        io: capture.io,
        env: { NO_COLOR: "1" },
        createRunId: () => "run-guided-repl",
      });

      expect(code).toBe(0);
      expect(capture.stdout()).toContain("Connected to compatible");
      expect(capture.stdout()).toContain("Selected compatible:science");
      expect(capture.stdout()).toContain("Provider echoed [REDACTED]");
      expect(capture.stdout()).toContain("Connected provider: compatible");
      expect(capture.stdout()).not.toContain(secret);
      expect(capture.stderr()).not.toContain(secret);
      expect(provider.chatRequests).toHaveLength(1);
      expect(provider.chatRequests[0]).toMatchObject({
        model: "science",
        messages: [{ role: "user", content: "Explain the result" }],
      });
    } finally {
      await provider.close();
    }
  });

  it("emits real theme ANSI styling rather than escaped renderer output on a dark TTY", async () => {
    const capture = captureIo("", true);
    const theme = createTheme("dark", { isTTY: true, env: {} });
    expect(theme.colorEnabled).toBe(true);
    const source = "Answer: `x` and $E=mc^2$ done.\n";

    const result = await executeChat({
      harness: textHarness("run-theme-ansi", [source]),
      model: "compatible:science",
      reasoning: "auto",
      messages: [{ role: "user", content: "Question" }],
      io: capture.io,
      json: false,
      raw: false,
      env: {},
      apiKeyEnvironmentVariable: "TEST_KEY",
      createRunId: () => "run-theme-ansi",
      theme,
    });

    expect(result.exitCode).toBe(0);
    expect(result.text).toBe(source);
    const stdout = capture.stdout();
    // Trusted theme sequences must reach the terminal as active styling.
    expect(stdout).toContain(theme.code("`x`"));
    expect(stdout).toContain(theme.math("$E=mc^2$"));
    expect(stdout).toContain("\u001b[38;5;222m");
    expect(stdout).toContain("\u001b[38;5;117m");
    expect(stdout).toContain("\u001b[0m");
    // Renderer output must not be neutralized a second time.
    expect(stdout).not.toContain("\\u{001b}");
    expect(capture.stderr()).toBe("");
  });

  it("escapes untrusted model terminal controls while the dark theme stays active", async () => {
    const secret = "synthetic-theme-key-4c19";
    const capture = captureIo("", true);
    const theme = createTheme("dark", { isTTY: true, env: {} });
    const source = `Title\u001b]0;pwned\u0007 \u0001 ${secret} $E=mc^2$\n`;

    const result = await executeChat({
      harness: textHarness("run-theme-controls", [source]),
      model: "compatible:science",
      reasoning: "auto",
      messages: [{ role: "user", content: "Question" }],
      io: capture.io,
      json: false,
      raw: false,
      env: {},
      apiKeyEnvironmentVariable: "TEST_KEY",
      credentialValues: { TEST_KEY: secret },
      createRunId: () => "run-theme-controls",
      theme,
    });

    expect(result.exitCode).toBe(0);
    const stdout = capture.stdout();
    // Model-supplied OSC and C0 controls are visible text, never active sequences.
    expect(stdout).toContain("\\u{001b}]0;pwned\\u{0007}");
    expect(stdout).toContain("\\u{0001}");
    expect(stdout).not.toContain("\u001b]");
    expect(stdout).not.toContain("\u0007");
    expect(stdout).not.toContain("\u0001");
    // Redaction survives the theme path, and trusted styling is still active.
    expect(stdout).toContain("[REDACTED]");
    expect(stdout).not.toContain(secret);
    expect(stdout).toContain(theme.math("$E=mc^2$"));
    expect(capture.stderr()).not.toContain(secret);
  });

  it("escapes untrusted model terminal controls in raw output", async () => {
    const capture = captureIo("", true);

    const result = await executeChat({
      harness: textHarness("run-raw-controls", ["ok\u001b]0;pwned\u0007\u0001"]),
      model: "compatible:science",
      reasoning: "auto",
      messages: [{ role: "user", content: "Question" }],
      io: capture.io,
      json: false,
      raw: true,
      env: {},
      apiKeyEnvironmentVariable: "TEST_KEY",
      createRunId: () => "run-raw-controls",
    });

    expect(result.exitCode).toBe(0);
    expect(capture.stdout()).toBe("ok\\u{001b}]0;pwned\\u{0007}\\u{0001}");
    expect(capture.stdout()).not.toContain("\u001b");
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
