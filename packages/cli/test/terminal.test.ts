import { PassThrough } from "node:stream";
import type { RunEvent } from "@researk/contracts";
import { describe, expect, it } from "vitest";
import { parseMarkdownMath } from "../src/rendering/parser.js";
import { renderInteractiveEvents } from "../src/rendering/renderer.js";
import {
  detectTerminalCapability,
  reconstructCanonicalSource,
  renderTerminalMath,
} from "../src/rendering/terminal.js";
import { executeChat } from "../src/run.js";

/** A trusted iTerm2 identity. Capability is asserted explicitly so no host env can influence it. */
const ITERM_ENV = Object.freeze({
  TERM_PROGRAM: "iTerm.app",
  TERM_PROGRAM_VERSION: "3.5.14",
});

/** The exact inline-image sequence the trusted emitter is allowed to produce. */
const ITERM_IMAGE_PREFIX = "\u001b]1337;File=inline=1;preserveAspectRatio=1:";
const BEL = "\u0007";

/** A minimal 1x1 PNG. Keeps the protocol assertions independent of the real rasterizer. */
const STUB_PNG = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  ),
);

async function stubRenderImage(): Promise<{ readonly png: Uint8Array }> {
  return { png: STUB_PNG };
}

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
      env: ITERM_ENV,
      renderImage: stubRenderImage,
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
        env: ITERM_ENV,
        renderImage: stubRenderImage,
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

  /**
   * The renderer refuses to rasterize anything needing font-backed text, so the CLI must present
   * exact canonical source for it rather than a wrong or empty image.
   *
   * These drive the real packaged renderer through the CLI's own dependency, with capability
   * positively supported, so a regression that started rasterizing font-backed content would show
   * up here as an emitted image sequence instead of source.
   */
  it.each([
    ["CJK outside the math font", "\\[x = 中文\\]"],
    ["an emoji symbol", "\\[x = 😀\\]"],
    ["a MathJax error marker for invalid TeX", "\\[\\frac{1}\\]"],
    ["a MathJax error marker for an undefined macro", "\\[\\notarealmacro{x}\\]"],
  ])("presents exact source for %s instead of an incomplete image", async (_label, source) => {
    const stdout = capture();
    Object.defineProperty(stdout, "isTTY", { value: true });

    await expect(
      renderInteractiveEvents(parseMarkdownMath(source), {
        interactive: true,
        stdout,
        env: ITERM_ENV,
      }),
    ).resolves.toBe(source);
    expect(stdout.text()).not.toContain("\u001b]1337;");
  });

  /**
   * The counterpart: ordinary path-only math must still reach the terminal as a real image through
   * the packaged renderer, so the fail-closed rule above did not disable graphics generally.
   *
   * The last three cases are the regression that matters most here. Their *source* contains
   * `font-family`, which MathJax echoes verbatim into every `data-latex` attribute, so a renderer
   * that decided by scanning the serialized SVG would refuse them and this test would see exact
   * source instead of an image — silent loss of graphics for perfectly ordinary math.
   */
  it.each([
    ["ordinary display math", "\\[E = mc^2\\]"],
    ["a subscript whose source echoes a CSS property name", "\\[x_{font-family}\\]"],
    ["a fraction whose source echoes a CSS property name", "\\[\\frac{font-family}{2}\\]"],
    ["a source containing a declaration-shaped `font-family:`", "\\[\\mbox{font-family: serif}\\]"],
  ])("still emits a real inline image for %s", async (_label, source) => {
    const stdout = capture();
    Object.defineProperty(stdout, "isTTY", { value: true });

    await expect(
      renderInteractiveEvents(parseMarkdownMath(source), {
        interactive: true,
        stdout,
        env: ITERM_ENV,
      }),
    ).resolves.toBe("");
    const emitted = stdout.text();
    expect(emitted).toContain(ITERM_IMAGE_PREFIX);
    expect(emitted).toContain(`${BEL}\n`);
    // A real PNG, not a stub: the payload must decode to a PNG signature of substantial size.
    const start = emitted.indexOf(ITERM_IMAGE_PREFIX) + ITERM_IMAGE_PREFIX.length;
    const payload = emitted.slice(start, emitted.indexOf(BEL, start));
    const png = Buffer.from(payload, "base64");
    expect(png.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    expect(png.byteLength).toBeGreaterThan(1024);
  });

  it("does not echo the LaTeX source when it emits an image", async () => {
    const stdout = capture();
    Object.defineProperty(stdout, "isTTY", { value: true });

    await expect(
      renderInteractiveEvents(parseMarkdownMath("\\[E = mc^2\\]"), {
        interactive: true,
        stdout,
        env: ITERM_ENV,
      }),
    ).resolves.toBe("");
    expect(stdout.text()).not.toContain("E = mc^2");
  });

  it("falls back to exact source when the rasterizer fails, without emitting graphics", async () => {
    const stdout = capture();
    Object.defineProperty(stdout, "isTTY", { value: true });
    const source = "\\[E = mc^2\\]";

    // Capability is positively supported here, so this isolates renderer failure from detection.
    await expect(
      renderInteractiveEvents(parseMarkdownMath(source), {
        interactive: true,
        stdout,
        env: ITERM_ENV,
        renderImage: () => Promise.reject(new Error("synthetic rasterizer failure")),
      }),
    ).resolves.toBe(source);
    expect(stdout.text()).not.toContain("\u001b]1337;");
  });

  it("reports failure from renderTerminalMath instead of throwing when rendering fails", async () => {
    const stdout = capture();
    const [event] = parseMarkdownMath("\\[E = mc^2\\]").filter(
      (candidate) => candidate.type === "math",
    );
    if (event === undefined || event.type !== "math") throw new Error("expected a math event");

    await expect(
      renderTerminalMath(
        event,
        { protocol: "iterm2", reason: "test" },
        stdout,
        undefined,
        undefined,
        () => Promise.reject(new Error("synthetic rasterizer failure")),
      ),
    ).resolves.toBe(false);
    expect(stdout.text()).toBe("");
  });

  it("detects capability from explicit input rather than the ambient host environment", () => {
    // Detection must be a pure function of the passed stream and env, so the same fixture yields
    // the same protocol on macOS, Linux, and Windows.
    const tty = { isTTY: true } as const;

    expect(detectTerminalCapability(tty, ITERM_ENV).protocol).toBe("iterm2");
    expect(detectTerminalCapability({ isTTY: false }, ITERM_ENV).protocol).toBe("unsupported");
    expect(detectTerminalCapability(tty, {}).protocol).toBe("unsupported");
    expect(detectTerminalCapability(tty, { ...ITERM_ENV, CI: "true" }).protocol).toBe(
      "unsupported",
    );
    expect(detectTerminalCapability(tty, { ...ITERM_ENV, TMUX: "/tmp/x" }).protocol).toBe(
      "unsupported",
    );
    expect(detectTerminalCapability(tty, { ...ITERM_ENV, ZELLIJ: "1" }).protocol).toBe(
      "unsupported",
    );
    expect(detectTerminalCapability(tty, { ...ITERM_ENV, TERM: " TMUX-256COLOR " }).protocol).toBe(
      "unsupported",
    );
    expect(detectTerminalCapability(tty, { ...ITERM_ENV, TERM: "screen-256color" }).protocol).toBe(
      "unsupported",
    );
    expect(detectTerminalCapability(tty, { ...ITERM_ENV, TERM: " DuMb " }).protocol).toBe(
      "unsupported",
    );
    // A trusted identity without a parseable version is not positively supported.
    expect(detectTerminalCapability(tty, { TERM_PROGRAM: "iTerm.app" }).protocol).toBe(
      "unsupported",
    );
  });
});
