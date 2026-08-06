import {
  type CanonicalModelId,
  type ReasoningIntent,
  ReasoningIntentSchema,
  splitCanonicalModelId,
} from "@researk/contracts";

export interface CliArguments {
  readonly command?: "help" | "version" | "models" | "chat" | "doctor";
  readonly help: boolean;
  readonly version: boolean;
  readonly json: boolean;
  readonly raw: boolean;
  readonly model?: CanonicalModelId;
  readonly reasoning: ReasoningIntent;
  readonly providerId?: string;
  readonly baseUrl?: string;
  readonly apiKeyEnvironmentVariable: string;
  readonly prompt: string;
}

export function parseArguments(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): CliArguments {
  let command: CliArguments["command"];
  let help = false;
  let version = false;
  let json = false;
  let raw = false;
  let modelValue = env.RESEARK_MODEL;
  let reasoningValue = env.RESEARK_REASONING ?? "auto";
  let providerId = env.RESEARK_PROVIDER_ID;
  let baseUrl = env.RESEARK_OPENAI_BASE_URL;
  let apiKeyEnvironmentVariable = env.RESEARK_OPENAI_API_KEY_ENV ?? "OPENAI_API_KEY";
  const prompt: string[] = [];
  let optionsEnded = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (optionsEnded && argument !== undefined) {
      prompt.push(argument);
    } else if (argument === "--") {
      optionsEnded = true;
    } else if (command === undefined && prompt.length === 0 && isCommand(argument)) {
      command = argument;
    } else if (argument === "--help" || argument === "-h") {
      help = true;
    } else if (argument === "--version" || argument === "-v") {
      version = true;
    } else if (argument === "--json") {
      json = true;
    } else if (argument === "--raw") {
      raw = true;
    } else if (argument === "--model") {
      modelValue = requireValue(argv, ++index, "--model");
    } else if (argument === "--reasoning") {
      reasoningValue = requireValue(argv, ++index, "--reasoning");
    } else if (argument === "--provider-id") {
      providerId = requireValue(argv, ++index, "--provider-id");
    } else if (argument === "--base-url") {
      baseUrl = requireValue(argv, ++index, "--base-url");
    } else if (argument === "--api-key-env") {
      apiKeyEnvironmentVariable = requireValue(argv, ++index, "--api-key-env");
    } else if (argument?.startsWith("-")) {
      throw new Error(`Unknown option: ${argument}`);
    } else if (argument !== undefined) {
      prompt.push(argument);
    }
  }

  const reasoning = ReasoningIntentSchema.parse(reasoningValue);
  const model = modelValue === undefined ? undefined : parseModelIdentity(modelValue);
  if (json && raw) throw new Error("--json and --raw cannot be used together");
  if (command !== undefined && command !== "chat" && prompt.length > 0) {
    throw new Error(`${command} does not accept positional arguments`);
  }
  if (
    model !== undefined &&
    providerId !== undefined &&
    splitCanonicalModelId(model).providerId !== providerId
  ) {
    throw new Error("--provider-id must match the provider in --model provider:model");
  }

  return {
    ...(command === undefined ? {} : { command }),
    help,
    version,
    json,
    raw,
    ...(model === undefined ? {} : { model }),
    reasoning,
    ...(providerId === undefined ? {} : { providerId }),
    ...(baseUrl === undefined ? {} : { baseUrl }),
    apiKeyEnvironmentVariable,
    prompt: prompt.join(" "),
  };
}

export function parseModelIdentity(value: string): CanonicalModelId {
  const separator = value.indexOf(":");
  if (separator < 1 || separator === value.length - 1) {
    throw new Error("Model must use the explicit provider:model form");
  }
  const parsed = value as CanonicalModelId;
  splitCanonicalModelId(parsed);
  return parsed;
}

function requireValue(argv: readonly string[], index: number, option: string): string {
  const value = argv[index];
  if (value === undefined || value.startsWith("-")) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

function isCommand(value: string | undefined): value is NonNullable<CliArguments["command"]> {
  return (
    value === "help" ||
    value === "version" ||
    value === "models" ||
    value === "chat" ||
    value === "doctor"
  );
}
