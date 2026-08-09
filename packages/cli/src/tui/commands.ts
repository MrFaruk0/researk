export interface SlashCommand {
  readonly name: `/${string}`;
  readonly summary: string;
  /** Longer help-overlay description. */
  readonly detail: string;
}

/**
 * The complete slash-command surface of the TUI. Discovery, routing, and the help overlay all read
 * this one list, so a command cannot appear in one place and be missing from another.
 */
export const SLASH_COMMANDS: readonly SlashCommand[] = Object.freeze([
  Object.freeze({
    name: "/provider",
    summary: "Connect a model provider",
    detail: "Choose OpenRouter or an OpenAI-compatible endpoint and complete the connection form.",
  }),
  Object.freeze({
    name: "/model",
    summary: "Select a catalog model",
    detail: "Search the connected provider's live catalog and select an available model.",
  }),
  Object.freeze({
    name: "/variant",
    summary: "Select a reasoning variant",
    detail: "List the reasoning variants advertised by the selected model's capabilities.",
  }),
  Object.freeze({
    name: "/themes",
    summary: "Change the colour theme",
    detail: "Preview and apply a semantic palette across the whole application.",
  }),
  Object.freeze({
    name: "/read",
    summary: "Stage a workspace document",
    detail:
      "Read a bounded UTF-8 .txt/.md/.markdown/.tex/.latex/.bib file from the current workspace. " +
      "It stays local until the next prompt, which sends it once as untrusted reference data.",
  }),
  Object.freeze({
    name: "/source",
    summary: "Show canonical assistant source",
    detail: "Reveal the exact, unmodified Markdown and LaTeX source of the latest response.",
  }),
  Object.freeze({
    name: "/commands",
    summary: "Browse every command",
    detail: "Open a keyboard-selectable list of all commands and run the highlighted one.",
  }),
  Object.freeze({
    name: "/help",
    summary: "Show keyboard help",
    detail: "List commands and key bindings.",
  }),
  Object.freeze({
    name: "/clear",
    summary: "Clear the conversation",
    detail: "Discard the in-memory conversation for this session.",
  }),
  Object.freeze({
    name: "/exit",
    summary: "Exit Researk",
    detail: "Leave the alternate screen and restore the terminal.",
  }),
]);

/**
 * Returns the commands offered while the user types a leading slash. An exact match still returns
 * that command so the discovery list confirms the pending selection rather than disappearing.
 */
export function discoverSlashCommands(input: string): readonly SlashCommand[] {
  if (!input.startsWith("/")) return [];
  const head = input.split(/\s/u, 1)[0] ?? input;
  if (input.length > head.length) return [];
  const lowered = head.toLowerCase();
  return SLASH_COMMANDS.filter((command) => command.name.startsWith(lowered));
}

/**
 * Completes only an unambiguous command prefix; Tab never submits the composer.
 *
 * The result reports the matched command so the caller (and tests) can confirm exactly which command
 * a completion expanded to. When zero or multiple commands match the prefix, the input is returned
 * unchanged and no `command` is reported, so Tab is a no-op and the discovery list stays the only
 * guidance.
 */
export function completeSlashCommand(
  input: string,
  cursor: number,
): Readonly<{ value: string; cursor: number; command?: SlashCommand }> {
  const safeCursor = Math.min(Math.max(cursor, 0), input.length);
  const beforeCursor = input.slice(0, safeCursor);
  if (!beforeCursor.startsWith("/") || /\s/u.test(beforeCursor)) {
    return { value: input, cursor: safeCursor };
  }
  const matches = discoverSlashCommands(beforeCursor);
  if (matches.length !== 1) return { value: input, cursor: safeCursor };
  const command = matches[0];
  if (command === undefined) return { value: input, cursor: safeCursor };
  const value = command.name + input.slice(safeCursor);
  return { value, cursor: command.name.length, command };
}

export interface ParsedSlashCommand {
  readonly name: string;
  readonly argument: string;
}

export function parseSlashCommand(line: string): ParsedSlashCommand | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("/")) return undefined;
  const name = trimmed.split(/\s/u, 1)[0] ?? trimmed;
  return { name: name.toLowerCase(), argument: trimmed.slice(name.length).trim() };
}

export function isKnownSlashCommand(name: string): boolean {
  return SLASH_COMMANDS.some((command) => command.name === name);
}
