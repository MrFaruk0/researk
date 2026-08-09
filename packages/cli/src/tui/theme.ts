import { THEME_NAMES, type ThemeName } from "../theme.js";

/**
 * Semantic presentation tokens for the full-screen TUI. Components reference token names only, so a
 * theme change repaints the whole application without scattered literal colors.
 */
export interface TuiPalette {
  readonly background: string | undefined;
  readonly foreground: string;
  readonly muted: string;
  readonly border: string;
  readonly accent: string;
  readonly success: string;
  readonly warning: string;
  readonly error: string;
  readonly userMessage: string;
  readonly assistantMessage: string;
  readonly toolMessage: string;
}

export type TuiThemeToken = keyof TuiPalette;

export interface TuiTheme {
  readonly name: ThemeName;
  readonly palette: TuiPalette;
  /** False when color must be suppressed, so components render structure without styling. */
  readonly colorEnabled: boolean;
}

export const TUI_THEME_TOKENS = Object.freeze([
  "background",
  "foreground",
  "muted",
  "border",
  "accent",
  "success",
  "warning",
  "error",
  "userMessage",
  "assistantMessage",
  "toolMessage",
]) as readonly TuiThemeToken[];

const PALETTES: Readonly<Record<ThemeName, TuiPalette>> = Object.freeze({
  system: Object.freeze({
    background: undefined,
    foreground: "white",
    muted: "gray",
    border: "gray",
    accent: "cyan",
    success: "green",
    warning: "yellow",
    error: "red",
    userMessage: "cyan",
    assistantMessage: "white",
    toolMessage: "magenta",
  }),
  dark: Object.freeze({
    background: undefined,
    foreground: "#e6e6e6",
    muted: "#8a8a8a",
    border: "#3f4757",
    accent: "#5fd7ff",
    success: "#87d787",
    warning: "#ffd75f",
    error: "#ff5f5f",
    userMessage: "#5fd7ff",
    assistantMessage: "#e6e6e6",
    toolMessage: "#d787ff",
  }),
  light: Object.freeze({
    background: undefined,
    foreground: "#1c1c1c",
    muted: "#6c6c6c",
    border: "#b2b2b2",
    accent: "#005faf",
    success: "#008700",
    warning: "#af5f00",
    error: "#af0000",
    userMessage: "#005faf",
    assistantMessage: "#1c1c1c",
    toolMessage: "#8700af",
  }),
  "high-contrast": Object.freeze({
    background: undefined,
    foreground: "whiteBright",
    muted: "whiteBright",
    border: "whiteBright",
    accent: "yellowBright",
    success: "greenBright",
    warning: "yellowBright",
    error: "redBright",
    userMessage: "cyanBright",
    assistantMessage: "whiteBright",
    toolMessage: "magentaBright",
  }),
  mono: Object.freeze({
    background: undefined,
    foreground: "white",
    muted: "gray",
    border: "gray",
    accent: "white",
    success: "white",
    warning: "white",
    error: "white",
    userMessage: "white",
    assistantMessage: "white",
    toolMessage: "white",
  }),
  nord: Object.freeze({
    background: "#2e3440",
    foreground: "#d8dee9",
    muted: "#81a1c1",
    border: "#4c566a",
    accent: "#88c0d0",
    success: "#a3be8c",
    warning: "#ebcb8b",
    error: "#bf616a",
    userMessage: "#88c0d0",
    assistantMessage: "#d8dee9",
    toolMessage: "#b48ead",
  }),
  dracula: Object.freeze({
    background: "#282a36",
    foreground: "#f8f8f2",
    muted: "#6272a4",
    border: "#44475a",
    accent: "#bd93f9",
    success: "#50fa7b",
    warning: "#f1fa8c",
    error: "#ff5555",
    userMessage: "#8be9fd",
    assistantMessage: "#f8f8f2",
    toolMessage: "#ff79c6",
  }),
  "solarized-dark": Object.freeze({
    background: "#002b36",
    foreground: "#839496",
    muted: "#586e75",
    border: "#073642",
    accent: "#2aa198",
    success: "#859900",
    warning: "#b58900",
    error: "#dc322f",
    userMessage: "#2aa198",
    assistantMessage: "#839496",
    toolMessage: "#d33682",
  }),
  gruvbox: Object.freeze({
    background: "#282828",
    foreground: "#ebdbb2",
    muted: "#928374",
    border: "#504945",
    accent: "#83a598",
    success: "#b8bb26",
    warning: "#fabd2f",
    error: "#fb4934",
    userMessage: "#83a598",
    assistantMessage: "#ebdbb2",
    toolMessage: "#d3869b",
  }),
});

export function createTuiTheme(
  name: ThemeName,
  options: Readonly<{ colorEnabled: boolean }>,
): TuiTheme {
  return Object.freeze({
    name,
    palette: PALETTES[name],
    colorEnabled: options.colorEnabled,
  });
}

export function tuiThemeNames(): readonly ThemeName[] {
  return THEME_NAMES;
}

/**
 * Resolves a semantic token to a color for Ink, or `undefined` when color is disabled. Returning
 * `undefined` keeps the same component tree usable in accessible and no-color terminals.
 */
export function themeColor(theme: TuiTheme, token: TuiThemeToken): string | undefined {
  if (!theme.colorEnabled) return undefined;
  return theme.palette[token];
}
