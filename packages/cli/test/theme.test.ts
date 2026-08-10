import { describe, expect, it } from "vitest";
import { createTheme, THEME_NAMES } from "../src/theme.js";

describe("CLI themes", () => {
  it("offers the complete built-in theme list", () => {
    expect(THEME_NAMES).toEqual([
      "system",
      "dark",
      "light",
      "high-contrast",
      "mono",
      "nord",
      "dracula",
      "solarized-dark",
      "gruvbox",
      "tokyo-night",
      "catppuccin",
      "rose-pine",
      "everforest",
    ]);
  });

  it("never emits ANSI controls outside an interactive color-enabled terminal", () => {
    const noColor = createTheme("tokyo-night", { isTTY: true, env: { NO_COLOR: "1" } });
    const nonTty = createTheme("light", { isTTY: false, env: {} });
    const raw = createTheme("high-contrast", { isTTY: true, env: {}, plain: true });

    for (const theme of [noColor, nonTty, raw]) {
      expect(theme.colorEnabled).toBe(false);
      expect(theme.prompt()).not.toContain("\u001b");
      expect(theme.heading("status")).not.toContain("\u001b");
    }
  });

  it("creates every extended theme", () => {
    for (const name of THEME_NAMES) {
      const theme = createTheme(name, { isTTY: true, env: {} });
      expect(theme.accent("x")).toContain("x");
      expect(theme.heading("x")).toContain("x");
    }
  });
});
