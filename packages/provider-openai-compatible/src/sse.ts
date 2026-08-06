export interface SseEvent {
  readonly data: string;
  readonly event?: string;
}

const DEFAULT_MAX_BYTES = 16_000_000;
const DEFAULT_MAX_EVENT_BYTES = 2_000_000;
const DEFAULT_MAX_EVENT_LINES = 10_000;
const CARRIAGE_RETURN = 0x0d;
const LINE_FEED = 0x0a;

export async function* parseSse(
  body: ReadableStream<Uint8Array>,
  options: Readonly<{ signal?: AbortSignal; maxBytes?: number; maxEventBytes?: number }> = {},
): AsyncGenerator<SseEvent> {
  const maxBytes = positiveLimit(options.maxBytes, DEFAULT_MAX_BYTES, "maxBytes");
  const maxEventBytes = positiveLimit(
    options.maxEventBytes,
    DEFAULT_MAX_EVENT_BYTES,
    "maxEventBytes",
  );
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let eventBytes = 0;
  let eventLines = 0;
  let data: string[] = [];
  let event: string | undefined;
  let lineBytes: number[] = [];
  let skipNextLineFeed = false;
  let reachedEnd = false;

  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  options.signal?.addEventListener("abort", cancel, { once: true });

  const resetEvent = () => {
    eventBytes = 0;
    eventLines = 0;
    data = [];
    event = undefined;
  };

  const dispatchEvent = (): SseEvent | undefined => {
    const result =
      data.length === 0
        ? undefined
        : event === undefined
          ? { data: data.join("\n") }
          : { data: data.join("\n"), event };
    resetEvent();
    return result;
  };

  const appendEventByte = () => {
    eventBytes += 1;
    if (eventBytes > maxEventBytes) {
      throw new Error("Provider stream event exceeded its byte limit.");
    }
  };

  const appendLineByte = (value: number) => {
    lineBytes.push(value);
  };

  const consumeLine = (): SseEvent | undefined => {
    const line = decodeLine(lineBytes, decoder);
    lineBytes = [];
    if (line.length === 0) return dispatchEvent();

    eventLines += 1;
    if (eventLines > DEFAULT_MAX_EVENT_LINES) {
      throw new Error("Provider stream event exceeded its line limit.");
    }
    if (line.startsWith(":")) return undefined;

    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    let value = separator < 0 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) value = value.slice(1);

    if (field === "data") data.push(value);
    else if (field === "event") event = value;
    return undefined;
  };

  try {
    while (true) {
      options.signal?.throwIfAborted();
      const { done, value } = await reader.read();
      options.signal?.throwIfAborted();
      if (done) {
        if (lineBytes.length > 0) {
          const parsed = consumeLine();
          if (parsed !== undefined) yield parsed;
        }
        const parsed = dispatchEvent();
        if (parsed !== undefined) yield parsed;
        reachedEnd = true;
        return;
      }

      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        throw new Error("Provider stream exceeded its byte limit.");
      }
      for (const byte of value) {
        if (skipNextLineFeed && byte === LINE_FEED) {
          skipNextLineFeed = false;
          continue;
        }
        skipNextLineFeed = false;
        appendEventByte();
        if (byte === LINE_FEED) {
          const parsed = consumeLine();
          if (parsed !== undefined) yield parsed;
        } else if (byte === CARRIAGE_RETURN) {
          const parsed = consumeLine();
          if (parsed !== undefined) yield parsed;
          skipNextLineFeed = true;
        } else {
          appendLineByte(byte);
        }
      }
    }
  } finally {
    options.signal?.removeEventListener("abort", cancel);
    if (!reachedEnd) {
      try {
        await reader.cancel();
      } catch {
        // Preserve the original parse, abort, or consumer-termination outcome.
      }
    }
    reader.releaseLock();
  }
}

function positiveLimit(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new TypeError(`${name} must be a positive safe integer.`);
  }
  return resolved;
}

function decodeLine(bytes: readonly number[], decoder: InstanceType<typeof TextDecoder>): string {
  return bytes.length === 0 ? "" : decoder.decode(Uint8Array.from(bytes));
}
