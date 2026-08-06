import { describe, expect, it } from "vitest";
import { createTheme, THEME_NAMES } from "../src/theme.js";

describe("CLI themes", () => {
  it("offers the original built-in themes", () => {
    expect(THEME_NAMES).toEqual(["system", "dark", "light", "high-contrast", "mono"]);
  });

  it("never emits ANSI controls outside an interactive color-enabled terminal", () => {
    const noColor = createTheme("dark", { isTTY: true, env: { NO_COLOR: "1" } });
    const nonTty = createTheme("light", { isTTY: false, env: {} });
    const raw = createTheme("high-contrast", { isTTY: true, env: {}, plain: true });

    for (const theme of [noColor, nonTty, raw]) {
      expect(theme.colorEnabled).toBe(false);
      expect(theme.prompt()).not.toContain("\u001b");
      expect(theme.heading("status")).not.toContain("\u001b");
    }
  });
});
