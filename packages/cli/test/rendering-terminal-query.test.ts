import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  KITTY_GRAPHICS_QUERY,
  parseCellPixelReply,
  parseDa1Parameters,
  parseKittyGraphicsResponse,
  probeTerminalCapability,
} from "../src/rendering/terminal-query.js";

const kittyOk = "\u001b_Gi=31;OK\u001b\\";
const da1 = "\u001b[?1;2;4c";
const cellPixels = "\u001b[6;20;10t";

function streams(): { readonly stdin: PassThrough; readonly stdout: PassThrough } {
  return { stdin: new PassThrough(), stdout: new PassThrough() };
}

function writeByteByByte(stream: PassThrough, value: string): void {
  for (const byte of Buffer.from(value, "ascii")) stream.write(Buffer.of(byte));
}

describe("terminal graphics query broker", () => {
  it("parses split Kitty, DA1, and cell replies without decoding them as text", () => {
    expect(parseKittyGraphicsResponse(Buffer.from(kittyOk.slice(0, 8)))).toBeUndefined();
    expect(parseKittyGraphicsResponse(kittyOk)).toMatchObject({
      id: 31,
      status: "ok",
      explicitOk: true,
      message: "OK",
    });
    expect(parseDa1Parameters(da1)).toEqual([1, 2, 4]);
    expect(parseDa1Parameters("\u001b[c")).toBeUndefined();
    expect(parseDa1Parameters("\u001b[>1;2c")).toBeUndefined();
    expect(parseCellPixelReply(cellPixels)).toEqual({ width: 10, height: 20 });
    expect(parseKittyGraphicsResponse("\u001b_Gi=31,i=31;OK\u001b\\")).toBeUndefined();
    expect(parseKittyGraphicsResponse("\u001b_Ga=q;OK\u001b\\")).toBeUndefined();
    expect(
      parseKittyGraphicsResponse(
        Buffer.from([0x1b, 0x5f, 0x47, 0x69, 0x3d, 0x31, 0x3b, 0xcf, 0x4b, 0x1b, 0x5c]),
      ),
    ).toBeUndefined();
  });

  it("prefers explicit Kitty support and replays interleaved user bytes exactly", async () => {
    const { stdin, stdout } = streams();
    const probe = probeTerminalCapability({
      stdin,
      stdout,
      env: {},
      isTTY: true,
      timeoutMs: 50,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const user = Buffer.from("typed-before-and-after", "utf8");
    stdin.write(
      Buffer.concat([
        user.subarray(0, 6),
        Buffer.from(kittyOk),
        Buffer.from(da1),
        Buffer.from(cellPixels),
        user.subarray(6),
      ]),
    );
    const result = await probe;

    expect(result.protocol).toBe("kitty");
    expect(Buffer.from(result.replay)).toEqual(user);
    expect(Buffer.from(result.unmatchedInput)).toEqual(user);
    expect(stdout.read()?.toString("ascii")).toContain(KITTY_GRAPHICS_QUERY);
    expect(stdin.listenerCount("data")).toBe(0);
  });

  it("does not retain Kitty from an OK-only or late reply window", async () => {
    const { stdin, stdout } = streams();
    const probe = probeTerminalCapability({
      stdin,
      stdout,
      env: {},
      isTTY: true,
      timeoutMs: 5,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    stdin.write(kittyOk);
    const result = await probe;

    expect(result.protocol).toBe("unsupported");
    expect(result.timedOut).toBe(true);
    expect(stdin.listenerCount("data")).toBe(0);
    stdin.write(`${da1}${cellPixels}`);
    expect(result.protocol).toBe("unsupported");
  });

  it("consumes a matching late reply during the bounded pre-consumer retirement window", async () => {
    const { stdin, stdout } = streams();
    const replayed: Buffer[] = [];
    const observed: Buffer[] = [];
    const probe = probeTerminalCapability({
      stdin,
      stdout,
      env: {},
      isTTY: true,
      timeoutMs: 5,
      replay: (bytes) => {
        replayed.push(Buffer.from(bytes));
        stdin.unshift(Buffer.from(bytes));
      },
    });
    const result = await probe;
    expect(result.protocol).toBe("unsupported");
    stdin.write(`${kittyOk}${da1}${cellPixels}`);
    await new Promise<void>((resolve) => setImmediate(resolve));
    stdin.on("data", (chunk: Buffer) => observed.push(Buffer.from(chunk)));
    stdin.resume();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(Buffer.concat(replayed)).toEqual(Buffer.alloc(0));
    expect(Buffer.concat(observed)).toEqual(Buffer.alloc(0));
  });

  it("hands ordinary bytes from the same late window back to the future consumer exactly", async () => {
    const { stdin, stdout } = streams();
    const observed: Buffer[] = [];
    const replayed: Buffer[] = [];
    const user = Buffer.from("late-user-input", "utf8");
    const probe = probeTerminalCapability({
      stdin,
      stdout,
      env: {},
      isTTY: true,
      timeoutMs: 5,
      replay: (bytes) => {
        replayed.push(Buffer.from(bytes));
        stdin.unshift(Buffer.from(bytes));
      },
    });
    await probe;
    stdin.write(user);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(stdin.readableLength).toBe(user.length);
    stdin.on("data", (chunk: Buffer) => observed.push(Buffer.from(chunk)));
    stdin.resume();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(Buffer.concat(replayed)).toEqual(user);
    expect(Buffer.concat(observed)).toEqual(user);
  });

  it("does not treat an unrelated Kitty APC as the query acknowledgement", async () => {
    const { stdin, stdout } = streams();
    const unrelated = "\u001b_Gi=32;OK\u001b\\";
    const probe = probeTerminalCapability({
      stdin,
      stdout,
      env: {},
      isTTY: true,
      timeoutMs: 10,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    stdin.write(unrelated);
    const result = await probe;

    expect(result.protocol).toBe("unsupported");
    expect(Buffer.from(result.replay)).toEqual(Buffer.from(unrelated));
  });

  it("consumes an i=31 Kitty error without granting Kitty or replaying the response", async () => {
    const { stdin, stdout } = streams();
    const error = "\u001b_Gi=31;EINVAL\u001b\\";
    const probe = probeTerminalCapability({
      stdin,
      stdout,
      env: { WT_SESSION: "1" },
      isTTY: true,
      timeoutMs: 10,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    stdin.write(Buffer.concat([Buffer.from(error), Buffer.from(da1), Buffer.from(cellPixels)]));
    const result = await probe;

    expect(result.protocol).toBe("sixel");
    expect(result.kittyResponse).toMatchObject({ id: 31, explicitOk: false, message: "EINVAL" });
    expect(Buffer.from(result.replay)).toEqual(Buffer.alloc(0));
  });

  it("enters raw mode only when needed and restores the prior raw state", async () => {
    const { stdin, stdout } = streams();
    const rawInput = stdin as PassThrough & {
      isRaw?: boolean;
      setRawMode?: (enabled: boolean) => void;
    };
    let raw = false;
    const rawCalls: boolean[] = [];
    rawInput.isRaw = raw;
    rawInput.setRawMode = (enabled: boolean) => {
      rawCalls.push(enabled);
      raw = enabled;
      rawInput.isRaw = enabled;
    };
    const probe = probeTerminalCapability({
      stdin: rawInput,
      stdout,
      env: {},
      isTTY: true,
      timeoutMs: 5,
    });
    await probe;

    expect(raw).toBe(false);
    expect(rawCalls).toEqual([true, false]);
  });

  it("keeps the broker installed after Kitty OK until DA1 and cell replies arrive", async () => {
    const { stdin, stdout } = streams();
    const probe = probeTerminalCapability({
      stdin,
      stdout,
      env: {},
      isTTY: true,
      timeoutMs: 50,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    stdin.write(kittyOk);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(stdin.listenerCount("data")).toBe(1);
    stdin.write(Buffer.concat([Buffer.from("typed"), Buffer.from(da1), Buffer.from(cellPixels)]));
    const result = await probe;

    expect(result.protocol).toBe("kitty");
    expect(Buffer.from(result.replay)).toEqual(Buffer.from("typed"));
    expect(stdin.listenerCount("data")).toBe(0);
  });

  it("retains lone ESC, ESC_, and ESC[ prefixes across byte-sized reply chunks", async () => {
    const { stdin, stdout } = streams();
    const probe = probeTerminalCapability({
      stdin,
      stdout,
      env: {},
      isTTY: true,
      timeoutMs: 50,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    writeByteByByte(stdin, `${kittyOk}${da1}${cellPixels}`);
    const result = await probe;

    expect(result.protocol).toBe("kitty");
    expect(result.replay).toEqual(Buffer.alloc(0));
  });

  it("quarantines an APC candidate split across the timeout boundary and replays its prefix once", async () => {
    const { stdin, stdout } = streams();
    const replayed: Buffer[] = [];
    const user = Buffer.from("typed-before", "ascii");
    const probe = probeTerminalCapability({
      stdin,
      stdout,
      env: {},
      isTTY: true,
      timeoutMs: 5,
      replay: (bytes) => replayed.push(Buffer.from(bytes)),
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    stdin.write(Buffer.concat([user, Buffer.from("\u001b_Gi=", "ascii")]));
    const result = await probe;

    expect(result.protocol).toBe("unsupported");
    expect(result.timedOut).toBe(true);
    stdin.write(Buffer.from("31;OK\u001b\\", "ascii"));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(Buffer.concat(replayed)).toEqual(user);
    expect(stdin.listenerCount("readable")).toBe(0);
  });

  it("keeps an APC candidate brokered when the ordinary replay cap is exactly full", async () => {
    const { stdin, stdout } = streams();
    const replayed: Buffer[] = [];
    const observed: Buffer[] = [];
    const prefix = Buffer.from("0123456789abcdef", "ascii");
    const probe = probeTerminalCapability({
      stdin,
      stdout,
      env: {},
      isTTY: true,
      timeoutMs: 5,
      maxReplayBytes: prefix.length,
      replay: (bytes) => {
        replayed.push(Buffer.from(bytes));
        stdin.unshift(Buffer.from(bytes));
      },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    stdin.write(Buffer.concat([prefix, Buffer.from("\u001b_Gi=", "ascii")]));
    const result = await probe;
    expect(result.timedOut).toBe(true);

    stdin.write(Buffer.from("31;OK\u001b\\", "ascii"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    stdin.on("data", (chunk: Buffer) => observed.push(Buffer.from(chunk)));
    stdin.resume();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(Buffer.concat(replayed)).toEqual(prefix);
    expect(Buffer.concat(observed)).toEqual(prefix);
    expect(stdin.listenerCount("readable")).toBe(0);
  });

  it("keeps a CSI candidate brokered when the ordinary replay cap is exactly full", async () => {
    const { stdin, stdout } = streams();
    const replayed: Buffer[] = [];
    const observed: Buffer[] = [];
    const prefix = Buffer.from("0123456789abcdef", "ascii");
    const probe = probeTerminalCapability({
      stdin,
      stdout,
      env: {},
      isTTY: true,
      timeoutMs: 5,
      maxReplayBytes: prefix.length,
      replay: (bytes) => {
        replayed.push(Buffer.from(bytes));
        stdin.unshift(Buffer.from(bytes));
      },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    stdin.write(Buffer.concat([prefix, Buffer.from("\u001b[?1;", "ascii")]));
    const result = await probe;
    expect(result.timedOut).toBe(true);

    stdin.write(Buffer.from("2;4c", "ascii"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    stdin.on("data", (chunk: Buffer) => observed.push(Buffer.from(chunk)));
    stdin.resume();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(Buffer.concat(replayed)).toEqual(prefix);
    expect(Buffer.concat(observed)).toEqual(prefix);
    expect(stdin.listenerCount("readable")).toBe(0);
  });

  it("retires repeated partial suffixes at one bounded late-state cap without loss or duplication", async () => {
    const { stdin, stdout } = streams();
    const handedOff: Buffer[] = [];
    const chunks = [
      Buffer.from("AAAA\u001b", "ascii"),
      Buffer.from("AAAA\u001b", "ascii"),
      Buffer.from("AAAA\u001b", "ascii"),
      Buffer.from("AAAA\u001b", "ascii"),
    ];
    const probe = probeTerminalCapability({
      stdin,
      stdout,
      env: {},
      isTTY: true,
      timeoutMs: 5,
      maxReplayBytes: 16,
      replay: (bytes) => handedOff.push(Buffer.from(bytes)),
    });
    await probe;
    for (const chunk of chunks) stdin.write(chunk);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(Buffer.concat(handedOff)).toEqual(Buffer.concat(chunks));
    expect(stdin.listenerCount("readable")).toBe(0);
  });

  it("restores a null-flowing PassThrough paused for a consumer that attaches after replay", async () => {
    const { stdin, stdout } = streams();
    expect(stdin.readableFlowing).toBeNull();
    const replayed: Buffer[] = [];
    const user = Buffer.from("typed-before-ink", "utf8");
    const probe = probeTerminalCapability({
      stdin,
      stdout,
      env: {},
      isTTY: true,
      timeoutMs: 10,
      replay: (bytes) => stdin.unshift(Buffer.from(bytes)),
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    stdin.write(user);
    await probe;

    expect(stdin.isPaused()).toBe(true);
    stdin.on("data", (chunk: Buffer) => replayed.push(Buffer.from(chunk)));
    stdin.resume();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(Buffer.concat(replayed)).toEqual(user);
  });

  it("hands off all accepted unmatched bytes when the total replay cap is exceeded", async () => {
    const { stdin, stdout } = streams();
    const handedOff: Buffer[] = [];
    const chunks = [Buffer.from("abcdefgh"), Buffer.from("ijklmnop"), Buffer.from("qrstuvwx")];
    const probe = probeTerminalCapability({
      stdin,
      stdout,
      env: {},
      isTTY: true,
      maxReplayBytes: 16,
      timeoutMs: 50,
      replay: (bytes) => handedOff.push(Buffer.from(bytes)),
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    for (const chunk of chunks) stdin.write(chunk);
    const result = await probe;

    expect(result.timedOut).toBe(false);
    expect(result.reason).toContain("replay");
    expect(Buffer.concat(handedOff)).toEqual(Buffer.concat(chunks));
    expect(result.replay).toEqual(Buffer.alloc(0));
  });

  it("recognizes Sixel only with WT_SESSION, DA1 4, and bounded cell pixels", async () => {
    const positive = streams();
    const positiveProbe = probeTerminalCapability({
      stdin: positive.stdin,
      stdout: positive.stdout,
      env: { WT_SESSION: "1" },
      isTTY: true,
      timeoutMs: 10,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    positive.stdin.write(`${da1}${cellPixels}`);
    await expect(positiveProbe).resolves.toMatchObject({ protocol: "sixel" });

    const noHint = streams();
    const noHintProbe = probeTerminalCapability({
      stdin: noHint.stdin,
      stdout: noHint.stdout,
      env: {},
      isTTY: true,
      timeoutMs: 5,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    noHint.stdin.write(`${da1}${cellPixels}`);
    await expect(noHintProbe).resolves.toMatchObject({ protocol: "unsupported" });
  });

  it("retains trusted iTerm identity when probing times out and ignores late replies", async () => {
    const { stdin, stdout } = streams();
    const probe = probeTerminalCapability({
      stdin,
      stdout,
      env: { TERM_PROGRAM: "iTerm.app", TERM_PROGRAM_VERSION: "3.5.14" },
      isTTY: true,
      timeoutMs: 5,
    });
    const result = await probe;
    expect(result.protocol).toBe("iterm2");
    expect(result.timedOut).toBe(true);
    stdin.write(kittyOk);
    expect(result.protocol).toBe("iterm2");
    expect(stdin.listenerCount("data")).toBe(0);
  });

  it("fails closed on an oversized partial reply while replaying every byte", async () => {
    const { stdin, stdout } = streams();
    const oversized = Buffer.concat([Buffer.from("\u001b_G"), Buffer.alloc(300, 0x41)]);
    const probe = probeTerminalCapability({
      stdin,
      stdout,
      env: {},
      isTTY: true,
      maxResponseBytes: 256,
      timeoutMs: 50,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    stdin.write(oversized);
    await expect(probe).resolves.toMatchObject({ protocol: "unsupported", timedOut: false });
    const result = await probe;
    expect(Buffer.from(result.replay)).toEqual(oversized);
  });
});
