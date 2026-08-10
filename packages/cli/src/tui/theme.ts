import { THEME_NAMES, type ThemeName } from "../theme.js";

/**
 * Semantic presentation tokens for the full-screen TUI. Components reference token names only, so a
 * theme change repaints the whole application without scattered literal colors.
 */
export interface TuiPalette {
  readonly background: string | undefined;
  readonly surface: string | undefined;
  readonly surfaceMuted: string | undefined;
  readonly userSurface: string | undefined;
  readonly assistantSurface: string | undefined;
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
  readonly math: string;
  readonly code: string;
  readonly citation: string;
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
  "surface",
  "surfaceMuted",
  "userSurface",
  "assistantSurface",
  "math",
  "code",
  "citation",
]) as readonly TuiThemeToken[];

const PALETTES: Readonly<Record<ThemeName, TuiPalette>> = Object.freeze({
  system: Object.freeze({
    background: undefined,
    surface: undefined,
    surfaceMuted: undefined,
    userSurface: undefined,
    assistantSurface: undefined,
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
    math: "cyan",
    code: "yellow",
    citation: "magenta",
  }),
  dark: Object.freeze({
    background: undefined,
    surface: "#242832",
    surfaceMuted: "#1e222b",
    userSurface: "#26384b",
    assistantSurface: "#242832",
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
    math: "#5fd7ff",
    code: "#ffd75f",
    citation: "#d787ff",
  }),
  light: Object.freeze({
    background: undefined,
    surface: "#f5f7fa",
    surfaceMuted: "#e8edf2",
    userSurface: "#dceeff",
    assistantSurface: "#f5f7fa",
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
    math: "#005faf",
    code: "#875f00",
    citation: "#8700af",
  }),
  "high-contrast": Object.freeze({
    background: undefined,
    surface: undefined,
    surfaceMuted: undefined,
    userSurface: undefined,
    assistantSurface: undefined,
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
    math: "cyanBright",
    code: "yellowBright",
    citation: "magentaBright",
  }),
  mono: Object.freeze({
    background: undefined,
    surface: undefined,
    surfaceMuted: undefined,
    userSurface: undefined,
    assistantSurface: undefined,
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
    math: "white",
    code: "white",
    citation: "white",
  }),
  nord: Object.freeze({
    background: "#2e3440",
    surface: "#3b4252",
    surfaceMuted: "#353b49",
    userSurface: "#34495c",
    assistantSurface: "#3b4252",
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
    math: "#88c0d0",
    code: "#ebcb8b",
    citation: "#b48ead",
  }),
  dracula: Object.freeze({
    background: "#282a36",
    surface: "#343746",
    surfaceMuted: "#303240",
    userSurface: "#2e4050",
    assistantSurface: "#343746",
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
    math: "#8be9fd",
    code: "#f1fa8c",
    citation: "#ff79c6",
  }),
  "solarized-dark": Object.freeze({
    background: "#002b36",
    surface: "#073642",
    surfaceMuted: "#06313c",
    userSurface: "#08454c",
    assistantSurface: "#073642",
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
    math: "#2aa198",
    code: "#b58900",
    citation: "#d33682",
  }),
  gruvbox: Object.freeze({
    background: "#282828",
    surface: "#3c3836",
    surfaceMuted: "#32302f",
    userSurface: "#3b4642",
    assistantSurface: "#3c3836",
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
    math: "#83a598",
    code: "#fabd2f",
    citation: "#d3869b",
  }),
  "tokyo-night": Object.freeze({
    background: "#1a1b26",
    surface: "#24283b",
    surfaceMuted: "#1f2335",
    userSurface: "#283457",
    assistantSurface: "#24283b",
    foreground: "#c0caf5",
    muted: "#7982a9",
    border: "#3b4261",
    accent: "#7aa2f7",
    success: "#9ece6a",
    warning: "#e0af68",
    error: "#f7768e",
    userMessage: "#7dcfff",
    assistantMessage: "#c0caf5",
    toolMessage: "#bb9af7",
    math: "#7dcfff",
    code: "#e0af68",
    citation: "#bb9af7",
  }),
  catppuccin: Object.freeze({
    background: "#1f1e31",
    surface: "#2d2c43",
    surfaceMuted: "#191827",
    userSurface: "#263654",
    assistantSurface: "#2d2c43",
    foreground: "#d3daf4",
    muted: "#949ab6",
    border: "#555a76",
    accent: "#8db8f6",
    success: "#a9e5a2",
    warning: "#f5dda8",
    error: "#ee8ea9",
    userMessage: "#83dfe9",
    assistantMessage: "#d3daf4",
    toolMessage: "#c9a8f4",
    math: "#78c9ed",
    code: "#f5dda8",
    citation: "#efc1dc",
  }),
  "rose-pine": Object.freeze({
    background: "#1d1a2a",
    surface: "#2a273f",
    surfaceMuted: "#242238",
    userSurface: "#333052",
    assistantSurface: "#2a273f",
    foreground: "#e0def4",
    muted: "#908caa",
    border: "#4a4566",
    accent: "#c4a7e7",
    success: "#9ccfd8",
    warning: "#f6c177",
    error: "#eb6f92",
    userMessage: "#9ccfd8",
    assistantMessage: "#e0def4",
    toolMessage: "#f6c177",
    math: "#9ccfd8",
    code: "#f6c177",
    citation: "#ebbcf1",
  }),
  everforest: Object.freeze({
    background: "#202a26",
    surface: "#2a3630",
    surfaceMuted: "#252f2b",
    userSurface: "#31423a",
    assistantSurface: "#2a3630",
    foreground: "#d7dfcf",
    muted: "#84958b",
    border: "#47574e",
    accent: "#a7c080",
    success: "#83c092",
    warning: "#dbbc7f",
    error: "#e67e80",
    userMessage: "#7fbbb3",
    assistantMessage: "#d7dfcf",
    toolMessage: "#d699b6",
    math: "#7fbbb3",
    code: "#dbbc7f",
    citation: "#d699b6",
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
