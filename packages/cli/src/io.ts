import type { Readable, Writable } from "node:stream";
import type { CliIo } from "./types.js";

const CSI = "\u001b[";
const ESCAPE_SEQUENCE_WAIT_MS = 35;

export function processIo(): CliIo {
  return {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    isTTY: process.stdin.isTTY === true && process.stdout.isTTY === true,
    onInterrupt(handler) {
      process.on("SIGINT", handler);
      return () => process.off("SIGINT", handler);
    },
  };
}

export async function write(stream: Writable, value: string): Promise<void> {
  if (value.length === 0) return;
  if (stream.write(value)) return;
  await new Promise<void>((resolve, reject) => {
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      stream.off("drain", onDrain);
      stream.off("error", onError);
    };
    stream.once("drain", onDrain);
    stream.once("error", onError);
  });
}

export async function readAll(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** A presentation-only mask. The value is never written to a stream. */
export function maskSecret(value: string): string {
  return "•".repeat([...value].length);
}

export interface PaletteOption<T extends string = string> {
  readonly value: T;
  readonly label: string;
  readonly hint?: string;
}

/**
 * Read a small choice list with terminal cursor keys. It deliberately owns raw mode only for the
 * duration of the question, making it safe to embed in the REPL and safe to fall back from.
 */
export async function selectFromPalette<T extends string>(
  io: CliIo,
  title: string,
  options: readonly PaletteOption<T>[],
  writeValue: (value: string) => Promise<void>,
): Promise<T | undefined> {
  if (options.length === 0) return undefined;
  const input = io.stdin as Readable & { isTTY?: boolean; setRawMode?: (enabled: boolean) => void };
  if (!io.isTTY || typeof input.setRawMode !== "function") return undefined;
  let selected = 0;
  let renderedLineCount = 0;
  let writeQueue = Promise.resolve();
  const queueWrite = (value: string): Promise<void> => {
    writeQueue = writeQueue.then(() => writeValue(value));
    return writeQueue;
  };
  const render = async (): Promise<void> => {
    const titleLines = title.replace(/\n+$/u, "").split("\n");
    const lines = options.map((option, index) => {
      const marker = index === selected ? "❯" : " ";
      return `${marker} ${option.label}${option.hint === undefined ? "" : `  ${option.hint}`}`;
    });
    const nextLines = [...titleLines, ...lines];
    let output = renderedLineCount === 0 ? "" : `${CSI}${renderedLineCount}A`;
    output += nextLines.map((line) => `${CSI}2K${CSI}1G${line}\n`).join("");
    if (renderedLineCount > nextLines.length) {
      output += Array.from(
        { length: renderedLineCount - nextLines.length },
        () => `${CSI}2K${CSI}1G\n`,
      ).join("");
    }
    renderedLineCount = nextLines.length;
    await queueWrite(output);
  };
  input.pause();
  input.setRawMode(true);
  await render();
  return new Promise<T | undefined>((resolve, reject) => {
    let settled = false;
    const keys = new RawKeyParser(handleKey);
    const cleanup = () => {
      keys.dispose();
      input.off("data", onData);
      input.setRawMode?.(false);
      input.resume();
    };
    const finish = (value: T | undefined) => {
      if (settled) return;
      settled = true;
      cleanup();
      void queueWrite("\n").then(() => resolve(value), reject);
    };
    function handleKey(key: RawKey): void {
      if (key.type === "interrupt" || key.type === "escape") {
        finish(undefined);
        return;
      }
      if (key.type === "text" && key.value.toLowerCase() === "q") {
        finish(undefined);
        return;
      }
      if (key.type === "up" || (key.type === "text" && key.value.toLowerCase() === "k")) {
        selected = (selected + options.length - 1) % options.length;
        void render();
      } else if (key.type === "down" || (key.type === "text" && key.value.toLowerCase() === "j")) {
        selected = (selected + 1) % options.length;
        void render();
      } else if (key.type === "enter") finish(options[selected]?.value);
    }
    const onData = (chunk: Buffer | string) => keys.push(chunk);
    input.on("data", onData);
    input.resume();
  });
}

/** Raw, masked input for secrets. Backspace and Ctrl-C work consistently in Windows terminals. */
export async function readMaskedInput(
  io: CliIo,
  prompt: string,
  writeValue: (value: string) => Promise<void>,
): Promise<string | undefined> {
  const input = io.stdin as Readable & { isTTY?: boolean; setRawMode?: (enabled: boolean) => void };
  if (!io.isTTY || typeof input.setRawMode !== "function") return undefined;
  let value = "";
  input.pause();
  input.setRawMode(true);
  await writeValue(prompt);
  return new Promise<string | undefined>((resolve, reject) => {
    let settled = false;
    let writeQueue = Promise.resolve();
    const queueWrite = (text: string): void => {
      writeQueue = writeQueue.then(() => writeValue(text));
    };
    const keys = new RawKeyParser(handleKey);
    const cleanup = () => {
      keys.dispose();
      input.off("data", onData);
      input.setRawMode?.(false);
      input.resume();
    };
    const finish = (result: string | undefined) => {
      if (settled) return;
      settled = true;
      cleanup();
      void writeQueue.then(() => writeValue("\n")).then(() => resolve(result), reject);
    };
    function handleKey(key: RawKey): void {
      if (key.type === "interrupt" || key.type === "escape") {
        finish(undefined);
        return;
      }
      if (key.type === "enter") {
        finish(value);
        return;
      }
      if (key.type === "backspace") {
        if (value.length > 0) {
          value = [...value].slice(0, -1).join("");
          queueWrite(`\r${CSI}2K${prompt}${maskSecret(value)}`);
        }
        return;
      }
      if (key.type === "text") {
        value += key.value;
        queueWrite(maskSecret(key.value));
      }
    }
    const onData = (chunk: Buffer | string) => keys.push(chunk);
    input.on("data", onData);
    input.resume();
  });
}

type RawKey =
  | { readonly type: "up" | "down" | "enter" | "backspace" | "escape" | "interrupt" }
  | { readonly type: "text"; readonly value: string };

/** Buffers terminal key bytes so ANSI sequences may span arbitrary stream chunks. */
class RawKeyParser {
  #buffer = "";
  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly emit: (key: RawKey) => void) {}

  push(chunk: Buffer | string): void {
    this.#clearTimer();
    this.#buffer += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
    this.#drain();
  }

  dispose(): void {
    this.#clearTimer();
    this.#buffer = "";
  }

  #drain(): void {
    while (this.#buffer.length > 0) {
      if (this.#buffer === "\u001b") {
        this.#waitForEscape(true);
        return;
      }
      if (this.#buffer.startsWith("\u001b[")) {
        const match = /^[0-9;?]*([A-Za-z~])/u.exec(this.#buffer.slice(2));
        if (match === null) {
          this.#waitForEscape(false);
          return;
        }
        this.#buffer = this.#buffer.slice(match[0].length + 2);
        if (match[1] === "A") this.emit({ type: "up" });
        if (match[1] === "B") this.emit({ type: "down" });
        continue;
      }
      if (this.#buffer.startsWith("\u001bO")) {
        if (this.#buffer.length < 3) {
          this.#waitForEscape(false);
          return;
        }
        const final = this.#buffer[2];
        this.#buffer = this.#buffer.slice(3);
        if (final === "A") this.emit({ type: "up" });
        if (final === "B") this.emit({ type: "down" });
        continue;
      }
      if (this.#buffer[0] === "\u001b") {
        this.#buffer = this.#buffer.slice(1);
        continue;
      }
      if (this.#buffer[0] === "\u009b") {
        const match = /^[0-9;?]*([A-Za-z~])/u.exec(this.#buffer.slice(1));
        if (match === null) {
          this.#waitForEscape(false);
          return;
        }
        this.#buffer = this.#buffer.slice(match[0].length + 1);
        if (match[1] === "A") this.emit({ type: "up" });
        if (match[1] === "B") this.emit({ type: "down" });
        continue;
      }
      if (this.#buffer[0] === "\u0000" || this.#buffer[0] === "\u00e0") {
        if (this.#buffer.length < 2) {
          this.#waitForEscape(false);
          return;
        }
        const scanCode = this.#buffer.charCodeAt(1);
        this.#buffer = this.#buffer.slice(2);
        if (scanCode === 72) this.emit({ type: "up" });
        if (scanCode === 80) this.emit({ type: "down" });
        continue;
      }
      const character = Array.from(this.#buffer)[0];
      if (character === undefined) return;
      this.#buffer = this.#buffer.slice(character.length);
      if (character === "\u0003") this.emit({ type: "interrupt" });
      else if (character === "\r" || character === "\n") this.emit({ type: "enter" });
      else if (character === "\u007f" || character === "\b") this.emit({ type: "backspace" });
      else if ((character.codePointAt(0) ?? 0) >= 0x20)
        this.emit({ type: "text", value: character });
    }
  }

  #waitForEscape(standalone: boolean): void {
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      if (standalone && this.#buffer === "\u001b") this.emit({ type: "escape" });
      this.#buffer = "";
    }, ESCAPE_SEQUENCE_WAIT_MS);
  }

  #clearTimer(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
  }
}
