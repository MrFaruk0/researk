import type { Readable, Writable } from "node:stream";
import type { CliIo } from "./types.js";

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
