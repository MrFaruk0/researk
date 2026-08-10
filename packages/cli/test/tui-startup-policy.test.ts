import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { parseArguments } from "../src/args.js";
import {
  createNonPersistentCredentialStore,
  isFormulaGraphicsProbeEligible,
  isRuntimeColorAllowed,
  isSessionInWorkspace,
  replayTerminalInput,
  resolveStartupColorEnabled,
} from "../src/tui.js";
import type { CliIo } from "../src/types.js";

function io(isTTY: boolean): CliIo {
  return {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    isTTY,
  };
}

describe("TUI startup policy", () => {
  it.each([
    ["NO_COLOR", [], true, { NO_COLOR: "" }],
    ["TERM=dumb", [], true, { TERM: "DUMB" }],
    ["--accessible", ["--accessible"], true, {}],
    ["--raw", ["--raw"], true, {}],
    ["--json", ["--json"], true, {}],
    ["non-TTY", [], false, {}],
  ])("blocks runtime color for %s", (_name, argv, isTTY, env) => {
    expect(isRuntimeColorAllowed(parseArguments(argv, env), io(isTTY), env)).toBe(false);
    expect(resolveStartupColorEnabled(false, true)).toBe(false);
  });

  it("allows a persisted false preference to disable color, but not a persisted true preference to bypass runtime policy", () => {
    const args = parseArguments([], {});
    expect(isRuntimeColorAllowed(args, io(true), {})).toBe(true);
    expect(resolveStartupColorEnabled(true, false)).toBe(false);
    expect(resolveStartupColorEnabled(true, true)).toBe(true);
    expect(resolveStartupColorEnabled(true, undefined)).toBe(true);
    expect(resolveStartupColorEnabled(false, true)).toBe(false);
  });

  it("accepts only sessions belonging to the current workspace", () => {
    expect(isSessionInWorkspace({ workspace: "C:/research" }, "C:/research")).toBe(true);
    expect(isSessionInWorkspace({ workspace: "C:/other" }, "C:/research")).toBe(false);
    expect(isSessionInWorkspace(null, "C:/research")).toBe(false);
  });

  it("uses a non-persistent credential backend for normal startup", async () => {
    const credentials = createNonPersistentCredentialStore();
    await credentials.set("OPENROUTER_API_KEY", "synthetic-secret");
    await expect(credentials.get("OPENROUTER_API_KEY")).resolves.toBeNull();
  });

  it.each([
    ["raw", ["--raw"], true, {}],
    ["json", ["--json"], true, {}],
    ["accessible", ["--accessible"], true, {}],
    ["non-TTY", [], false, {}],
    ["CI", [], true, { CI: "1" }],
    ["dumb", [], true, { TERM: "dumb" }],
    ["multiplexer", [], true, { TMUX: "1" }],
  ])("does not authorize graphics probing for %s", (_name, argv, isTTY, env) => {
    expect(isFormulaGraphicsProbeEligible(parseArguments(argv, env), io(isTTY), env)).toBe(false);
  });

  it("authorizes only the normal interactive chat TUI", () => {
    const env = { TERM: "xterm-256color" };
    expect(isFormulaGraphicsProbeEligible(parseArguments([], env), io(true), env)).toBe(true);
    expect(isFormulaGraphicsProbeEligible(parseArguments(["help"], env), io(true), env)).toBe(
      false,
    );
  });

  it("replays unmatched probe bytes into stdin before the consumer mounts", () => {
    const streams = io(true);
    const bytes = Buffer.from("typed-before-ink", "utf8");
    replayTerminalInput(streams, bytes);
    expect(streams.stdin.read()).toEqual(bytes);
  });
});
