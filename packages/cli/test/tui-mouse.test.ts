import { describe, expect, it } from "vitest";
import {
  DISABLE_MOUSE_TRACKING,
  ENABLE_MOUSE_TRACKING,
  parseSgrMouseReport,
} from "../src/tui/mouse.js";

describe("SGR mouse protocol", () => {
  it("exports deterministic enable and reverse-order disable sequences", () => {
    expect(ENABLE_MOUSE_TRACKING).toBe("\u001b[?1000h\u001b[?1006h");
    expect(DISABLE_MOUSE_TRACKING).toBe("\u001b[?1006l\u001b[?1000l");
  });

  it("parses vertical wheel up in Ink and raw forms", () => {
    expect(parseSgrMouseReport("[<64;12;8M")).toEqual({ kind: "scroll", direction: "up" });
    expect(parseSgrMouseReport("\u001b[<64;12;8M")).toEqual({
      kind: "scroll",
      direction: "up",
    });
  });

  it("parses vertical wheel down and preserves modifier tolerance", () => {
    expect(parseSgrMouseReport("[<65;12;8M")).toEqual({ kind: "scroll", direction: "down" });
    expect(parseSgrMouseReport("[<93;12;8M")).toEqual({
      kind: "scroll",
      direction: "down",
    });
  });

  it("consumes valid clicks, releases, horizontal wheels, and motion as non-scroll events", () => {
    expect(parseSgrMouseReport("[<0;1;1M")).toEqual({ kind: "mouse", event: "press" });
    expect(parseSgrMouseReport("[<3;1;1m")).toEqual({ kind: "mouse", event: "release" });
    expect(parseSgrMouseReport("[<66;1;1M")).toEqual({
      kind: "mouse",
      event: "horizontal-scroll",
    });
    expect(parseSgrMouseReport("[<32;1;1M")).toEqual({ kind: "mouse", event: "motion" });
  });

  it("rejects partial, concatenated, contaminated, and non-mouse CSI input", () => {
    const invalid = [
      "",
      "[<64;1;1",
      "\u001b[<64;1;1",
      "[<64;1;1M[<65;1;1M",
      "\u001b[<64;1;1M\u001b[A",
      "\u001b[A",
      "[A",
      "[<64;1;1M\n",
      "\u001b\u001b[<64;1;1M",
      "[<64;1;1M\u0000",
    ];
    for (const input of invalid) expect(parseSgrMouseReport(input)).toBeUndefined();
  });

  it("rejects zero, negative, absurd, and unbounded fields", () => {
    const invalid = [
      "[<64;0;1M",
      "[<64;1;0M",
      "[<64;-1;1M",
      "[<64;1;-1M",
      "[<64;10001;1M",
      "[<64;1;10001M",
      "[<128;1;1M",
      "[<999999;1;1M",
      "[<64;999999;1M",
    ];
    for (const input of invalid) expect(parseSgrMouseReport(input)).toBeUndefined();
  });
});
