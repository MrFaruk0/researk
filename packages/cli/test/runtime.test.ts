import { once } from "node:events";
import { createServer } from "node:http";
import { Readable, Writable } from "node:stream";
import { type RunEvent, RunEventSchema } from "@researk/contracts";
import { describe, expect, it } from "vitest";
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
});
