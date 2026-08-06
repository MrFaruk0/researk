export interface SseEvent {
  readonly data: string;
  readonly event?: string;
}

const DEFAULT_MAX_BYTES = 16_000_000;
const DEFAULT_MAX_EVENT_BYTES = 2_000_000;
const encoder = new TextEncoder();

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
  let buffer = "";
  let totalBytes = 0;
  let eventBytes = 0;
  let eventLines: string[] = [];
  let reachedEnd = false;

  const acceptLine = (line: string): SseEvent | undefined => {
    if (line.length === 0) {
      const event = parseEventBlock(eventLines.join("\n"));
      eventLines = [];
      eventBytes = 0;
      return event;
    }

    eventBytes += (eventLines.length === 0 ? 0 : 1) + encoder.encode(line).byteLength;
    if (eventBytes > maxEventBytes) {
      throw new Error("Provider stream event exceeded its byte limit.");
    }
    eventLines.push(line);
    return undefined;
  };

  try {
    while (true) {
      options.signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) {
        buffer += decoder.decode();
      } else {
        totalBytes += value.byteLength;
        if (totalBytes > maxBytes) {
          throw new Error("Provider stream exceeded its byte limit.");
        }
        buffer += decoder.decode(value, { stream: true });
      }

      while (true) {
        const line = takeLine(buffer, done);
        if (line === undefined) break;
        buffer = buffer.slice(line.consumed);
        const parsed = acceptLine(line.value);
        if (parsed !== undefined) yield parsed;
      }

      const pendingBytes =
        eventBytes +
        (eventLines.length === 0 || buffer.length === 0 ? 0 : 1) +
        encoder.encode(buffer).byteLength;
      if (pendingBytes > maxEventBytes) {
        throw new Error("Provider stream event exceeded its byte limit.");
      }

      if (done) {
        if (eventLines.length > 0) {
          const parsed = parseEventBlock(eventLines.join("\n"));
          if (parsed !== undefined) yield parsed;
        }
        reachedEnd = true;
        return;
      }
    }
  } finally {
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

function takeLine(
  value: string,
  endOfInput: boolean,
): Readonly<{ value: string; consumed: number }> | undefined {
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === "\n") {
      return { value: value.slice(0, index), consumed: index + 1 };
    }
    if (character === "\r") {
      if (index + 1 === value.length && !endOfInput) return undefined;
      return {
        value: value.slice(0, index),
        consumed: value[index + 1] === "\n" ? index + 2 : index + 1,
      };
    }
  }

  return endOfInput && value.length > 0
    ? { value, consumed: value.length }
    : undefined;
}

function positiveLimit(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new TypeError(`${name} must be a positive safe integer.`);
  }
  return resolved;
}

function parseEventBlock(block: string): SseEvent | undefined {
  const data: string[] = [];
  let event: string | undefined;

  for (const line of block.split("\n")) {
    if (line.length === 0 || line.startsWith(":")) continue;

    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    let value = separator < 0 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) value = value.slice(1);

    if (field === "data") data.push(value);
    else if (field === "event") event = value;
  }

  if (data.length === 0) return undefined;
  return event === undefined ? { data: data.join("\n") } : { data: data.join("\n"), event };
}
