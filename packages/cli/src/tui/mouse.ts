/**
 * Enables xterm's button-event tracking and SGR (1006) coordinates. The SGR mode is enabled after
 * button tracking so reports use the unambiguous extended-coordinate form.
 */
export const ENABLE_MOUSE_TRACKING = "\u001b[?1000h\u001b[?1006h";

/**
 * Disables SGR coordinates before button tracking. Keeping cleanup in the reverse order of setup
 * leaves no tracking mode enabled if the terminal processes the two sequences incrementally.
 */
export const DISABLE_MOUSE_TRACKING = "\u001b[?1006l\u001b[?1000l";

const MAX_REPORT_LENGTH = 64;
const MAX_COORDINATE = 10_000;
const MAX_BUTTON_CODE = 127;

/** Every valid report is consumable; only vertical wheel reports request transcript movement. */
export type SgrMouseReport =
  | { readonly kind: "scroll"; readonly direction: "up" | "down" }
  | {
      readonly kind: "mouse";
      readonly event: "press" | "release" | "horizontal-scroll" | "motion";
    };

/**
 * Parses exactly one SGR mouse report.
 *
 * Ink's useInput callback receives the CSI body without its leading ESC, while direct stdin tests
 * and other callers may retain it. Both forms are accepted; all other CSI input is rejected.
 */
export function parseSgrMouseReport(input: string): SgrMouseReport | undefined {
  if (typeof input !== "string" || input.length > MAX_REPORT_LENGTH) return undefined;

  const body = input.startsWith("\u001b") ? input.slice(1) : input;
  const match = /^\[<([0-9]{1,3});([0-9]{1,5});([0-9]{1,5})([Mm])$/u.exec(body);
  if (match === null) return undefined;

  const buttonCode = Number(match[1]);
  const x = Number(match[2]);
  const y = Number(match[3]);
  if (
    !Number.isInteger(buttonCode) ||
    !Number.isInteger(x) ||
    !Number.isInteger(y) ||
    buttonCode < 0 ||
    buttonCode > MAX_BUTTON_CODE ||
    x < 1 ||
    x > MAX_COORDINATE ||
    y < 1 ||
    y > MAX_COORDINATE
  ) {
    return undefined;
  }

  const button = buttonCode & 0b11;
  const isWheel = (buttonCode & 0b1000000) !== 0;
  const isMotion = (buttonCode & 0b100000) !== 0;

  if (isWheel && !isMotion && (button === 0 || button === 1)) {
    return { kind: "scroll", direction: button === 0 ? "up" : "down" };
  }

  let event: Extract<SgrMouseReport, { readonly kind: "mouse" }>["event"];
  if (isMotion) event = "motion";
  else if (isWheel && button >= 2) event = "horizontal-scroll";
  else if (match[4] === "m" || button === 3) event = "release";
  else event = "press";
  return { kind: "mouse", event };
}
