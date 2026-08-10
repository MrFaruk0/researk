import { describe, expect, it } from "vitest";
import {
  displayCellWidth,
  displayRowCount,
  getDisplayLayout,
  paginateDisplayText,
  paginateRenderedText,
} from "../src/tui/layout.js";

describe("bounded terminal display layout", () => {
  it("wraps an unbroken source line into bounded pages without losing characters", () => {
    const source = "x".repeat(503);
    const first = paginateDisplayText(source, 17, 0, 4);
    expect(first.totalRows).toBe(30);
    expect(first.rows.join("")).toBe("x".repeat(68));

    const last = paginateDisplayText(source, 17, 10_000, 4);
    expect(last.offset).toBe(26);
    expect(last.rows.join("")).toBe("x".repeat(503 - 26 * 17));
    expect(displayRowCount(source, 17)).toBe(first.totalRows);
  });

  it("uses grapheme and terminal-cell widths, including explicit tab stops", () => {
    const source = "界e\u0301😀\tZ";
    const page = paginateDisplayText(source, 8, 0, 20);
    expect(page.rows.every((row) => displayCellWidth(row) <= 8)).toBe(true);
    expect(page.rows.join("")).toContain("界e\u0301😀\tZ");
    expect(displayCellWidth("界e\u0301😀")).toBe(5);
  });

  it("neutralizes controls and retains CRLF line structure in the display projection", () => {
    const source = `alpha\r\nbeta\rgamma\u001b]0;pwned\u0007`;
    const page = paginateDisplayText(source, 80, 0, 20);
    const rendered = page.rows.join("\n");
    expect(rendered).not.toContain("\u001b");
    expect(rendered).not.toContain("\r");
    expect(rendered).toContain("alpha");
    expect(rendered).toContain("beta");
    expect(rendered).toContain("\\u{000d}");
    expect(rendered).toContain("\\u{001b}]0;pwned\\u{0007}");
  });

  it("pages already-rendered composer text without changing its visual rows", () => {
    const rendered = "a\t界e\u0301";
    const page = paginateRenderedText(rendered, 8, 0, 20);
    expect(page.totalRows).toBeGreaterThanOrEqual(1);
    expect(page.rows.join("")).toBe(rendered);
  });

  it("reuses one sparse display layout for repeated page extraction", () => {
    const source = `${"x".repeat(503)} FINAL-UNBROKEN-MARKER`;
    const layout = getDisplayLayout(source, 17);
    expect(getDisplayLayout(source, 17)).toBe(layout);
    expect(layout.page(0, 4).rows.join("")).toBe("x".repeat(68));
    expect(layout.page(10, 4).offset).toBe(10);
    expect(layout.page(10, 4).rows.join("")).toBe("x".repeat(68));
    expect(layout.page(10_000, 4).rows.join("")).toContain("FINAL-UNBROKEN-MARKER");
    expect(getDisplayLayout(source, 18)).not.toBe(layout);
  });
});
