import { PassThrough } from "node:stream";
import type { RunEvent } from "@researk/contracts";
import { describe, expect, it } from "vitest";
import { parseMarkdownMath } from "../src/rendering/parser.js";
import { renderInteractiveEvents } from "../src/rendering/renderer.js";
import { detectTerminalCapability, reconstructCanonicalSource } from "../src/rendering/terminal.js";
import { executeChat } from "../src/run.js";

function capture(): PassThrough & { readonly text: () => string } {
  const stream = new PassThrough() as PassThrough & { readonly text: () => string };
  const chunks: Buffer[] = [];
  stream.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
  Object.defineProperty(stream, "text", { value: () => Buffer.concat(chunks).toString("utf8") });
  return stream;
}

describe("trusted terminal math path", () => {
  it("emits a visible iTerm2 inline-image protocol sequence for display math", async () => {
    const stdout = capture();
    Object.defineProperty(stdout, "isTTY", { value: true });
    const source = "Before\n\n\\[E = mc^2\\]\n\nAfter";
    const events = parseMarkdownMath(source);

    const rendered = await renderInteractiveEvents(events, {
      interactive: true,
      stdout,
      env: { TERM_PROGRAM: "iTerm.app", TERM_PROGRAM_VERSION: "3.5.14" },
      writeText: async (value) => {
        stdout.write(value);
      },
    });

    expect(stdout.text()).toContain("Before");
    expect(rendered).toContain("After");
    expect(rendered).toBe("\n\nAfter");
    expect(stdout.text()).toContain("\u001b]1337;File=inline=1;preserveAspectRatio=1:");
    expect(stdout.text()).toContain("\u0007\n");
    expect(stdout.text()).not.toContain("E = mc^2");
  });

  it("uses exact source when protocol capability is unsupported", async () => {
    const stdout = capture();
    Object.defineProperty(stdout, "isTTY", { value: true });
    const source = "\\[\\frac{a}{b}\\]";
    const events = parseMarkdownMath(source);

    await expect(
      renderInteractiveEvents(events, {
        interactive: true,
        stdout,
        env: { TERM: "xterm-256color" },
      }),
    ).resolves.toBe(source);
    expect(stdout.text()).toBe("");
    expect(detectTerminalCapability(stdout, { TERM: "dumb" }).protocol).toBe("unsupported");
  });

  it("never emits graphics in accessible mode", async () => {
    const stdout = capture();
    Object.defineProperty(stdout, "isTTY", { value: true });
    const source = "\\[x+y\\]";
    await expect(
      renderInteractiveEvents(parseMarkdownMath(source), {
        interactive: true,
        accessible: true,
        stdout,
        env: { TERM_PROGRAM: "iTerm.app", TERM_PROGRAM_VERSION: "3.5.14" },
      }),
    ).resolves.toBe(source);
    expect(stdout.text()).toBe("");
  });

  it("reconstructs canonical source from events after graphical presentation", () => {
    const source = "# Equation\n\nText $x^2$ and \\[y = mx + b\\].";
    expect(reconstructCanonicalSource(parseMarkdownMath(source))).toBe(source);
  });

  it("writes graphics without duplicate LaTeX while returning exact canonical source", async () => {
    const stdout = capture();
    const stderr = capture();
    Object.defineProperty(stdout, "isTTY", { value: true });
    const source = "Result:\n\\[E = mc^2\\]\nDone.";
    const harness = {
      async *run(): AsyncIterable<RunEvent> {
        yield {
          schemaVersion: 1,
          type: "text_delta",
          runId: "run-terminal-source",
          sequence: 0,
          timestamp: "2026-08-07T00:00:00.000Z",
          delta: source,
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
      io: { stdin: new PassThrough(), stdout, stderr, isTTY: true },
      json: false,
      raw: false,
      env: { TERM_PROGRAM: "iTerm.app", TERM_PROGRAM_VERSION: "3.5.14" },
      apiKeyEnvironmentVariable: "TEST_KEY",
      createRunId: () => "run-terminal-source",
    });

    expect(result.text).toBe(source);
    expect(stdout.text()).toContain("Result:");
    expect(stdout.text()).toContain("Done.");
    expect(stdout.text()).toContain("\u001b]1337;File=inline=1;preserveAspectRatio=1:");
    expect(stdout.text()).not.toContain("E = mc^2");
    expect(stderr.text()).toBe("");
  });
});
