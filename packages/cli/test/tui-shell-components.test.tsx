import { render as inkRender } from "ink-testing-library";
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import {
  Composer,
  composerInputRows,
  composerSuggestionRows,
  suggestionLines,
} from "../src/tui/components/Composer.js";
import { Footer } from "../src/tui/components/Footer.js";
import { Header } from "../src/tui/components/Header.js";
import { Notices } from "../src/tui/components/Notices.js";
import { Welcome } from "../src/tui/components/Welcome.js";
import { displayCellWidth } from "../src/tui/layout.js";
import { type AppState, createInitialState } from "../src/tui/state.js";
import { createTuiTheme } from "../src/tui/theme.js";

const theme = createTuiTheme("dark", { colorEnabled: false });
type InkInstance = ReturnType<typeof inkRender>;
const mountedApps = new Set<InkInstance>();

function render(element: React.ReactElement): InkInstance {
  const instance = inkRender(element);
  mountedApps.add(instance);
  return instance;
}

afterEach(() => {
  for (const app of mountedApps) {
    try {
      app.unmount();
    } catch {
      // Keep a failed component assertion from leaving Ink resources alive.
    }
  }
  mountedApps.clear();
});

function state(overrides: Partial<AppState> = {}): AppState {
  return {
    ...createInitialState({
      workspaceRoot: "/tmp/researk-project",
      themeName: "dark",
      colorEnabled: false,
      variant: "auto",
    }),
    ...overrides,
  };
}

describe("low-noise shell components", () => {
  it("uses the full welcome wordmark wide and a compact mark at narrow widths", () => {
    const wide = render(
      React.createElement(Welcome, {
        theme,
        width: 80,
        state: state(),
      }),
    );
    expect(wide.lastFrame() ?? "").toContain("rrr  eee  sss  eee  aaa  rrr");
    expect(wide.lastFrame() ?? "").not.toContain("Researk");
    wide.unmount();

    const narrow = render(
      React.createElement(Welcome, {
        theme,
        width: 50,
        state: state(),
      }),
    );
    expect((narrow.lastFrame() ?? "").split("\n").some((line) => line.trim() === "researk")).toBe(
      true,
    );
    expect(narrow.lastFrame() ?? "").toContain("/provider");
    narrow.unmount();
  });

  it("keeps banned run labels out of header and footer at idle and during a run", () => {
    for (const runStatus of ["idle", "streaming"] as const) {
      const current = state({ runStatus });
      const header = render(
        React.createElement(Header, { theme, state: current, version: "0.1.0", width: 80 }),
      );
      const footer = render(React.createElement(Footer, { theme, state: current, width: 80 }));
      const frame = `${header.lastFrame() ?? ""}\n${footer.lastFrame() ?? ""}`;
      expect(frame).not.toMatch(/\b(?:ready|streaming|starting|cancelling)\b/iu);
      expect(frame).not.toContain("info:");
      expect(frame).not.toContain("[external]");
      header.unmount();
      footer.unmount();
    }
  });

  it("shows only the newest warning or error notice", () => {
    const notices = [
      { id: "i", level: "info" as const, message: "routine info", createdAt: 1 },
      { id: "s", level: "success" as const, message: "routine success", createdAt: 2 },
      { id: "w", level: "warning" as const, message: "older warning", createdAt: 3 },
      { id: "e", level: "error" as const, message: "newest error", createdAt: 4 },
    ];
    const view = render(React.createElement(Notices, { theme, notices, width: 70 }));
    const frame = view.lastFrame() ?? "";
    expect(frame).toContain("newest error");
    expect(frame).not.toContain("routine info");
    expect(frame).not.toContain("routine success");
    expect(frame).not.toContain("older warning");
    expect(frame).not.toMatch(/(?:info:|error:)/iu);
    view.unmount();
  });

  it("keeps the cursor visible and uses a concise disabled affordance", () => {
    const input = render(
      React.createElement(Composer, {
        theme,
        composer: { value: "abc", cursor: 1, history: [], draft: "" },
        disabled: false,
        width: 50,
      }),
    );
    expect(input.lastFrame() ?? "").toContain("a█bc");
    input.unmount();

    const disabled = render(
      React.createElement(Composer, {
        theme,
        composer: { value: "", cursor: 0, history: [], draft: "" },
        disabled: true,
        width: 50,
      }),
    );
    const frame = disabled.lastFrame() ?? "";
    expect(frame).toContain("Ctrl+X cancel");
    expect(frame).not.toMatch(/\b(?:streaming|ready)\b/iu);
    disabled.unmount();
  });

  it("retains structure with colors disabled", () => {
    const view = render(
      React.createElement(Composer, {
        theme,
        composer: { value: "/", cursor: 1, history: [], draft: "" },
        disabled: false,
        width: 50,
      }),
    );
    const frame = view.lastFrame() ?? "";
    expect(frame).toContain("›");
    expect(frame).toContain("█");
    expect(frame.includes(String.fromCharCode(27))).toBe(false);
    view.unmount();
  });

  it("bounds slash suggestions while keeping the input row and cursor visible", () => {
    const composer = { value: "/", cursor: 1, history: [], draft: "" } as const;
    expect(composerSuggestionRows(composer.value, 0)).toBe(0);
    expect(composerSuggestionRows(composer.value, 1)).toBe(1);
    expect(composerSuggestionRows(composer.value, 2)).toBe(2);
    expect(suggestionLines(composer.value, 1)[0]).toMatch(/\+\d+ more/u);

    const view = render(
      React.createElement(Composer, {
        theme,
        composer,
        disabled: false,
        width: 50,
        maxSuggestionRows: 1,
      }),
    );
    const frame = view.lastFrame() ?? "";
    expect(frame).toContain("/\u2588");
    expect(frame).toContain("+12 more");
    expect(frame.split("\n").every((line) => displayCellWidth(line) <= 50)).toBe(true);
    expect(composerInputRows(composer, false, 50)).toBeGreaterThanOrEqual(1);
    view.unmount();
  });
});
