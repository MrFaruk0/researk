import { describe, expect, it } from "vitest";
import { createTuiTheme, formulaRenderStyle, tuiColorToCss } from "../src/tui/theme.js";

describe("TUI formula theme styles", () => {
  it("maps Ink named colors to deterministic CSS colors", () => {
    expect(tuiColorToCss("whiteBright")).toBe("#ffffff");
    expect(tuiColorToCss("cyan")).toBe("#00cdcd");
    expect(tuiColorToCss("#ABCDEF")).toBe("#abcdef");
  });

  it("keeps Kitty transparent while giving Sixel a theme-backed canvas", () => {
    const dark = createTuiTheme("dark", { colorEnabled: true });
    expect(formulaRenderStyle(dark, "kitty")).toEqual({
      dpi: 96,
      fontScale: 1,
      foreground: "#5fd7ff",
    });
    expect(formulaRenderStyle(dark, "sixel")).toEqual({
      background: "#242832",
      dpi: 96,
      fontScale: 1,
      foreground: "#5fd7ff",
    });
  });

  it("uses a dark math foreground and actual background for the light theme", () => {
    const light = createTuiTheme("light", { colorEnabled: true });
    expect(formulaRenderStyle(light, "sixel")).toEqual({
      background: "#f5f7fa",
      dpi: 96,
      fontScale: 1,
      foreground: "#005faf",
    });
  });

  it("keeps the system theme foreground semantic while omitting its unknown background", () => {
    const system = createTuiTheme("system", { colorEnabled: true });
    expect(formulaRenderStyle(system, "sixel")).toEqual({
      dpi: 96,
      fontScale: 1,
      foreground: "#00cdcd",
    });
  });

  it("does not produce a graphics style when color is disabled", () => {
    expect(formulaRenderStyle(createTuiTheme("dark", { colorEnabled: false }), "kitty")).toBe(
      undefined,
    );
  });
});
