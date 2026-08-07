import { PassThrough, Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { maskSecret, readMaskedInput, selectFromPalette } from "../src/io.js";
import type { CliIo } from "../src/types.js";

function rawIo(): { io: CliIo; input: PassThrough; output: () => string } {
  const input = new PassThrough() as PassThrough & { setRawMode?: (enabled: boolean) => void };
  input.setRawMode = () => undefined;
  let text = "";
  const stdout = new Writable({
    write(chunk, _encoding, callback) {
      text += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      callback();
    },
  });
  return {
    input,
    io: { stdin: input, stdout, stderr: stdout, isTTY: true },
    output: () => text,
  };
}

describe("interactive terminal helpers", () => {
  it("selects a palette item with arrow keys and Enter", async () => {
    const capture = rawIo();
    const selection = selectFromPalette(
      capture.io,
      "Choose",
      [
        { value: "one", label: "One" },
        { value: "two", label: "Two" },
      ],
      async () => undefined,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    capture.input.write("\u001b[B");
    capture.input.write("\r");
    await expect(selection).resolves.toBe("two");
  });

  it("selects a palette item when CSI arrow input arrives as three chunks", async () => {
    const capture = rawIo();
    const selection = selectFromPalette(
      capture.io,
      "Choose",
      [
        { value: "one", label: "One" },
        { value: "two", label: "Two" },
      ],
      async () => undefined,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    capture.input.write("\u001b");
    capture.input.write("[");
    capture.input.write("B");
    capture.input.write("\r");
    await expect(selection).resolves.toBe("two");
  });

  it("clears the previous palette frame before replacing it", async () => {
    const capture = rawIo();
    const selection = selectFromPalette(
      capture.io,
      "Choose\n",
      [
        { value: "one", label: "One", hint: "first" },
        { value: "two", label: "Two", hint: "second" },
      ],
      async (value) => capture.io.stdout.write(value),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    capture.input.write("\u001b[");
    await new Promise((resolve) => setTimeout(resolve, 0));
    capture.input.write("B");
    await new Promise((resolve) => setTimeout(resolve, 0));
    capture.input.write("\r");
    await expect(selection).resolves.toBe("two");

    const output = capture.output();
    expect(output).toContain("\u001b[2K\u001b[1G❯ One  first");
    expect(output).toContain("\u001b[3A");
    expect(output).toContain("\u001b[2K\u001b[1G  One  first");
    expect(output).toContain("\u001b[2K\u001b[1G❯ Two  second");
    expect(output).not.toMatch(/❯ One {2}first[\s\S]*❯ Two {2}second[\s\S]*❯ One {2}first/u);
  });

  it("does not cancel on an incomplete escape sequence", async () => {
    const capture = rawIo();
    const selection = selectFromPalette(
      capture.io,
      "Choose",
      [{ value: "one", label: "One" }],
      async () => undefined,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    capture.input.write("\u001b[");
    await new Promise((resolve) => setTimeout(resolve, 50));
    capture.input.write("\r");
    await expect(selection).resolves.toBe("one");
  });

  it("discards an incomplete escape sequence after the bounded timeout", async () => {
    vi.useFakeTimers();
    try {
      const capture = rawIo();
      const selection = selectFromPalette(
        capture.io,
        "Choose",
        [{ value: "one", label: "One" }],
        async () => undefined,
      );
      await Promise.resolve();
      await Promise.resolve();
      capture.input.write("\u001b");
      capture.input.write("[");
      await vi.advanceTimersByTimeAsync(35);
      capture.input.write("\r");
      await expect(selection).resolves.toBe("one");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps standalone Escape cancellation distinct from split arrow input", async () => {
    const capture = rawIo();
    const cancellation = selectFromPalette(
      capture.io,
      "Choose",
      [{ value: "one", label: "One" }],
      async () => undefined,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    capture.input.write("\u001b");
    await expect(cancellation).resolves.toBeUndefined();

    const masked = readMaskedInput(capture.io, "API key: ", async () => undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));
    capture.input.write("\u001b[");
    capture.input.write("A");
    capture.input.write("x\r");
    await expect(masked).resolves.toBe("x");
  });

  it("masks secrets and never writes the entered value", async () => {
    const capture = rawIo();
    const secret = "synthetic-api-key";
    const result = readMaskedInput(capture.io, "API key: ", async (value) => {
      capture.io.stdout.write(value);
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    capture.input.write(secret);
    capture.input.write("\r");
    await expect(result).resolves.toBe(secret);
    expect(capture.output()).toContain(maskSecret(secret));
    expect(capture.output()).not.toContain(secret);
  });

  it("degrades palette selection on non-TTY input", async () => {
    const capture = rawIo();
    await expect(
      selectFromPalette(
        { ...capture.io, isTTY: false },
        "Choose",
        [{ value: "one", label: "One" }],
        async () => undefined,
      ),
    ).resolves.toBeUndefined();
  });
});
