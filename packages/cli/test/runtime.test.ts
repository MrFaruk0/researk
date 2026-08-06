import { Readable, Writable } from "node:stream";
import { type RunEvent, RunEventSchema } from "@researk/contracts";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/run.js";
import type { CliHarness, CliIo, HarnessRunOptions } from "../src/types.js";

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

describe("CLI runtime", () => {
  it("supports help and version commands without provider setup", async () => {
    const help = captureIo();
    expect(await runCli(["help"], { io: help.io, env: {} })).toBe(0);
    expect(help.stdout()).toContain("Usage:");

    const version = captureIo();
    expect(await runCli(["version"], { io: version.io, env: {} })).toBe(0);
    expect(version.stdout()).toBe("0.0.0\n");
  });

  it("lists offline fake models", async () => {
    const capture = captureIo();
    const code = await runCli(["models"], {
      io: capture.io,
      env: { RESEARK_FAKE_PROVIDER: "1" },
    });
    expect(code).toBe(0);
    expect(capture.stdout()).toContain("fake:research-fake\tavailable");
    expect(capture.stderr()).toBe("");
  });

  it("runs raw chat directly through the in-process fake Harness", async () => {
    const capture = captureIo();
    const code = await runCli(
      ["chat", "--model", "fake:paper", "--raw", "Summarize", "the", "paper"],
      { io: capture.io, env: { RESEARK_FAKE_PROVIDER: "1" }, createRunId: () => "run-test" },
    );
    expect(code).toBe(0);
    expect(capture.stdout()).toBe("Offline fake provider response.");
    expect(capture.stderr()).toBe("");
    expect(capture.stdout()).not.toContain("\u001b");
  });

  it("treats command names after chat as prompt text", async () => {
    const capture = captureIo();
    const code = await runCli(["chat", "--model", "fake:paper", "Compare", "models"], {
      io: capture.io,
      env: { RESEARK_FAKE_PROVIDER: "1" },
      createRunId: () => "run-command-word",
    });
    expect(code).toBe(0);
    expect(capture.stdout()).toBe("Offline fake provider response.");
  });

  it("emits only typed JSON Lines events in JSON mode", async () => {
    const capture = captureIo();
    const code = await runCli(["chat", "--model", "fake:paper", "--json", "Question"], {
      io: capture.io,
      env: { RESEARK_FAKE_PROVIDER: "1" },
      createRunId: () => "run-json",
    });
    expect(code).toBe(0);
    const lines = capture
      .stdout()
      .trim()
      .split("\n")
      .map((line) => RunEventSchema.parse(JSON.parse(line) as unknown));
    expect(lines.some((event) => event.type === "selection")).toBe(true);
    expect(lines.some((event) => event.type === "text_delta")).toBe(true);
    expect(lines.at(-1)?.type).toBe("completed");
    expect(capture.stderr()).toBe("");
  });

  it("requires an explicit provider:model selection", async () => {
    const capture = captureIo();
    expect(
      await runCli(["chat", "Question"], {
        io: capture.io,
        env: { RESEARK_FAKE_PROVIDER: "1" },
      }),
    ).toBe(2);
    expect(capture.stderr()).toContain("--model provider:model");
  });

  it("never prints an environment credential", async () => {
    const secret = "test-secret-value";
    const harness: CliHarness = {
      async *run(request): AsyncIterable<RunEvent> {
        yield RunEventSchema.parse({
          schemaVersion: 1,
          runId: request.runId,
          sequence: 0,
          timestamp: "2026-08-06T12:00:00.000Z",
          type: "error",
          error: {
            code: "provider_http_error",
            message: `Provider rejected ${secret}`,
            retryable: false,
          },
        });
      },
      async listModels() {
        return [];
      },
    };
    const capture = captureIo();
    const code = await runCli(["chat", "--model", "fake:paper", "Question"], {
      harness,
      io: capture.io,
      env: { OPENAI_API_KEY: secret },
      createRunId: () => "run-secret",
    });
    expect(code).toBe(1);
    expect(`${capture.stdout()}${capture.stderr()}`).not.toContain(secret);
    expect(capture.stderr()).toContain("[REDACTED]");
  });

  it("redacts JSON errors and preserves their failing exit code", async () => {
    const secret = "json-secret-value";
    const harness: CliHarness = {
      async *run(request): AsyncIterable<RunEvent> {
        yield RunEventSchema.parse({
          schemaVersion: 1,
          runId: request.runId,
          sequence: 0,
          timestamp: "2026-08-06T12:00:00.000Z",
          type: "error",
          error: {
            code: "provider_http_error",
            message: `Provider rejected ${secret}`,
            retryable: false,
          },
        });
      },
      async listModels() {
        return [];
      },
    };
    const capture = captureIo();
    const code = await runCli(["chat", "--json", "--model", "fake:paper", "Question"], {
      harness,
      io: capture.io,
      env: { OPENAI_API_KEY: secret },
      createRunId: () => "run-json-secret",
    });
    expect(code).toBe(1);
    expect(capture.stdout()).not.toContain(secret);
    expect(JSON.parse(capture.stdout()) as unknown).toMatchObject({
      type: "error",
      error: { message: "Provider rejected [REDACTED]" },
    });
    expect(capture.stderr()).toBe("");
  });

  it("does not let the fake-provider switch replace an explicit real provider", async () => {
    const capture = captureIo();
    const code = await runCli(["chat", "--model", "real:model", "Question"], {
      io: capture.io,
      env: { RESEARK_FAKE_PROVIDER: "1" },
    });
    expect(code).toBe(1);
    expect(capture.stdout()).toBe("");
    expect(capture.stderr()).toContain("require --base-url");
  });

  it("returns 130 for a cancelled run", async () => {
    const harness: CliHarness = {
      async *run(request, options: HarnessRunOptions): AsyncIterable<RunEvent> {
        if (!options.signal.aborted) {
          await new Promise<void>((resolve) =>
            options.signal.addEventListener("abort", () => resolve(), { once: true }),
          );
        }
        expect(options.signal.aborted).toBe(true);
        yield RunEventSchema.parse({
          schemaVersion: 1,
          runId: request.runId,
          sequence: 0,
          timestamp: "2026-08-06T12:00:00.000Z",
          type: "cancelled",
          reason: "The run was cancelled.",
        });
      },
      async listModels() {
        return [];
      },
    };
    const capture = captureIo();
    const run = runCli(["chat", "--model", "fake:paper", "Question"], {
      harness,
      io: capture.io,
      env: {},
      createRunId: () => "run-cancel",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    capture.interrupt();
    expect(await run).toBe(130);
  });

  it("reports doctor state without exposing the credential", async () => {
    const capture = captureIo();
    const code = await runCli(["doctor", "--json", "--api-key-env", "MY_KEY"], {
      io: capture.io,
      env: { MY_KEY: "doctor-secret" },
    });
    expect(code).toBe(0);
    expect(JSON.parse(capture.stdout()) as unknown).toMatchObject({
      credentialConfigured: true,
      telemetry: false,
    });
    expect(capture.stdout()).not.toContain("doctor-secret");
  });

  it("redacts injected model-list errors in the REPL", async () => {
    const secret = "repl-secret-value";
    const harness: CliHarness = {
      async *run(): AsyncIterable<RunEvent> {
        yield* [] as RunEvent[];
      },
      async listModels() {
        throw new Error(`Catalog rejected ${secret}\u001b]0;unsafe`);
      },
    };
    const capture = captureIo("/models\n/exit\n", true);
    const code = await runCli([], {
      harness,
      io: capture.io,
      env: { OPENAI_API_KEY: secret },
    });
    expect(code).toBe(0);
    expect(capture.stderr()).toContain("Catalog rejected [REDACTED]");
    expect(capture.stderr()).not.toContain(secret);
    expect(capture.stderr()).not.toContain("\u001b");
  });
});
