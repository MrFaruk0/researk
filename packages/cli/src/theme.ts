export const THEME_NAMES = [
  "system",
  "dark",
  "light",
  "high-contrast",
  "mono",
  "nord",
  "dracula",
  "solarized-dark",
  "gruvbox",
] as const;

export type ThemeName = (typeof THEME_NAMES)[number];

export interface CliTheme {
  readonly name: ThemeName;
  readonly colorEnabled: boolean;
  accent(value: string): string;
  muted(value: string): string;
  heading(value: string): string;
  error(value: string): string;
  math(value: string): string;
  code(value: string): string;
  prompt(): string;
}

export function isThemeName(value: string): value is ThemeName {
  return (THEME_NAMES as readonly string[]).includes(value);
}

export function createTheme(
  name: ThemeName,
  options: Readonly<{
    isTTY: boolean;
    env: Readonly<Record<string, string | undefined>>;
    plain?: boolean;
  }>,
): CliTheme {
  const colorEnabled =
    options.isTTY &&
    options.plain !== true &&
    options.env.NO_COLOR === undefined &&
    options.env.TERM !== "dumb";
  const palette = PALETTES[name];
  const style = (code: string, value: string): string =>
    colorEnabled ? `\u001b[${code}m${value}\u001b[0m` : value;

  return Object.freeze({
    name,
    colorEnabled,
    accent: (value: string) => style(palette.accent, value),
    muted: (value: string) => style(palette.muted, value),
    heading: (value: string) => style(palette.heading, value),
    error: (value: string) => style(palette.error, value),
    math: (value: string) => style(palette.math, value),
    code: (value: string) => style(palette.code, value),
    prompt: () => `${style(palette.accent, "researk")}${style(palette.muted, " > ")}`,
  });
}

const PALETTES: Readonly<
  Record<
    ThemeName,
    Readonly<Record<"accent" | "muted" | "heading" | "error" | "math" | "code", string>>
  >
> = Object.freeze({
  system: Object.freeze({
    accent: "36;1",
    muted: "2",
    heading: "1",
    error: "31;1",
    math: "36",
    code: "33",
  }),
  dark: Object.freeze({
    accent: "38;5;81;1",
    muted: "38;5;245",
    heading: "38;5;255;1",
    error: "38;5;203;1",
    math: "38;5;117",
    code: "38;5;222",
  }),
  light: Object.freeze({
    accent: "34;1",
    muted: "90",
    heading: "30;1",
    error: "31;1",
    math: "34",
    code: "33",
  }),
  "high-contrast": Object.freeze({
    accent: "97;44;1",
    muted: "97",
    heading: "30;103;1",
    error: "97;41;1",
    math: "97;44;1",
    code: "30;103",
  }),
  mono: Object.freeze({
    accent: "37;1",
    muted: "37;2",
    heading: "37;1",
    error: "37;1",
    math: "37",
    code: "37;2",
  }),
  nord: Object.freeze({
    accent: "38;5;110;1",
    muted: "38;5;109",
    heading: "38;5;255;1",
    error: "38;5;174;1",
    math: "38;5;110",
    code: "38;5;221",
  }),
  dracula: Object.freeze({
    accent: "38;5;141;1",
    muted: "38;5;61",
    heading: "38;5;231;1",
    error: "38;5;203;1",
    math: "38;5;212",
    code: "38;5;228",
  }),
  "solarized-dark": Object.freeze({
    accent: "38;5;37;1",
    muted: "38;5;244",
    heading: "38;5;230;1",
    error: "38;5;166;1",
    math: "38;5;37",
    code: "38;5;136",
  }),
  gruvbox: Object.freeze({
    accent: "38;5;108;1",
    muted: "38;5;245",
    heading: "38;5;223;1",
    error: "38;5;167;1",
    math: "38;5;142",
    code: "38;5;214",
  }),
});
