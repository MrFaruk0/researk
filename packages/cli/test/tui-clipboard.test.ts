import { describe, expect, it } from "vitest";
import {
  type ClipboardResult,
  type ClipboardTerminalContext,
  copyFormulaSource,
  MAX_CLIPBOARD_ENCODED_BYTES,
  MAX_CLIPBOARD_SOURCE_BYTES,
} from "../src/tui/clipboard.js";

const BEL = "\u0007";
const OSC52_PREFIX = "\u001b]52;c;";

function context(overrides: Partial<ClipboardTerminalContext> = {}): ClipboardTerminalContext {
  return {
    interactive: true,
    accessible: false,
    stdout: { isTTY: true },
    env: {},
    ...overrides,
  };
}

function writer(): { readonly writes: string[]; readonly write: (sequence: string) => void } {
  const writes: string[] = [];
  return { writes, write: (sequence) => void writes.push(sequence) };
}

function expectFallback(
  result: ClipboardResult,
  reason: Exclude<ClipboardResult, { ok: true }>["reason"],
): void {
  expect(result).toMatchObject({ ok: false, reason });
}

describe("trusted OSC 52 formula clipboard", () => {
  it("emits the fixed OSC 52 sequence for ASCII source", async () => {
    const sink = writer();
    const source = "\\frac{a}{b}";

    await expect(copyFormulaSource(source, context(), sink.write)).resolves.toMatchObject({
      ok: true,
      reason: "copied",
      decodedBytes: Buffer.byteLength(source, "utf8"),
      encodedBytes: Buffer.byteLength(Buffer.from(source, "utf8").toString("base64"), "ascii"),
    });
    expect(sink.writes).toEqual([
      `${OSC52_PREFIX}${Buffer.from(source, "utf8").toString("base64")}${BEL}`,
    ]);
  });

  it("encodes Unicode source as UTF-8 base64 before emitting", async () => {
    const sink = writer();
    const source = "\\text{café} + π";
    await expect(copyFormulaSource(source, context(), sink.write)).resolves.toMatchObject({
      ok: true,
    });
    expect(sink.writes).toEqual([
      `${OSC52_PREFIX}${Buffer.from(source, "utf8").toString("base64")}${BEL}`,
    ]);
  });

  it("keeps hostile source and terminal controls out of the OSC payload", async () => {
    const sink = writer();
    const source = "prefix\u001b]52;c;forged\u0007\u0000\u009b\n\u001b\\suffix";
    await expect(copyFormulaSource(source, context(), sink.write)).resolves.toMatchObject({
      ok: true,
    });

    const sequence = sink.writes[0];
    expect(sequence).toBeDefined();
    expect(sequence).toBe(`${OSC52_PREFIX}${Buffer.from(source, "utf8").toString("base64")}${BEL}`);
    const payload = sequence?.slice(OSC52_PREFIX.length, -BEL.length) ?? "";
    expect(payload).not.toContain("\u001b");
    expect(payload).not.toContain("\u0007");
    expect(payload).not.toContain("\u0000");
    expect(payload).not.toContain("\u009b");
    expect(Buffer.from(payload, "base64").toString("utf8")).toBe(source);
  });

  it.each([
    ["non-interactive", context({ interactive: false }), "not-interactive"],
    ["non-TTY", context({ stdout: { isTTY: false } }), "stdout-not-tty"],
    ["accessible mode", context({ accessible: true }), "accessible-mode"],
    ["TERM=dumb", context({ env: { TERM: "dumb" } }), "term-dumb"],
    ["CI", context({ env: { CI: "" } }), "ci-environment"],
    ["tmux", context({ env: { TMUX: "/tmp/tmux" } }), "multiplexer-unsupported"],
    ["screen", context({ env: { STY: "123" } }), "multiplexer-unsupported"],
    ["zellij", context({ env: { ZELLIJ: "0" } }), "multiplexer-unsupported"],
  ] as const)("does not write for %s", async (_label, policy, reason) => {
    const sink = writer();
    const result = await copyFormulaSource("x + y", policy, sink.write);
    expectFallback(result, reason);
    expect(sink.writes).toEqual([]);
  });

  it("rejects empty source without writing", async () => {
    const sink = writer();
    const result = await copyFormulaSource("", context(), sink.write);
    expectFallback(result, "empty-source");
    expect(sink.writes).toEqual([]);
  });

  it("limits decoded source by UTF-8 bytes rather than JavaScript string length", async () => {
    const sink = writer();
    const source = "é".repeat(Math.floor(MAX_CLIPBOARD_SOURCE_BYTES / 2) + 1);
    expect(source.length).toBeLessThanOrEqual(MAX_CLIPBOARD_SOURCE_BYTES);
    expect(Buffer.byteLength(source, "utf8")).toBeGreaterThan(MAX_CLIPBOARD_SOURCE_BYTES);

    const result = await copyFormulaSource(source, context(), sink.write);
    expectFallback(result, "source-too-large");
    expect(sink.writes).toEqual([]);
  });

  it("enforces the encoded payload ceiling before writing", async () => {
    const sink = writer();
    const source = "a".repeat(Math.floor((MAX_CLIPBOARD_ENCODED_BYTES * 3) / 4) + 1);
    expect(Buffer.byteLength(source, "utf8")).toBeLessThanOrEqual(MAX_CLIPBOARD_SOURCE_BYTES);
    expect(
      Buffer.byteLength(Buffer.from(source, "utf8").toString("base64"), "ascii"),
    ).toBeGreaterThan(MAX_CLIPBOARD_ENCODED_BYTES);

    const result = await copyFormulaSource(source, context(), sink.write);
    expectFallback(result, "payload-too-large");
    expect(sink.writes).toEqual([]);
  });

  it("returns a deterministic failure when the trusted writer throws or rejects", async () => {
    const throwing = await copyFormulaSource("x", context(), () => {
      throw new Error("synthetic writer failure");
    });
    expectFallback(throwing, "write-failed");

    const rejecting = await copyFormulaSource("x", context(), async () => {
      throw new Error("synthetic async writer failure");
    });
    expectFallback(rejecting, "write-failed");
  });

  it("treats a writer false result as a write failure", async () => {
    const result = await copyFormulaSource("x", context(), () => false);
    expectFallback(result, "write-failed");
  });
});
