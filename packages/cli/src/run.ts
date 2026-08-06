import { randomUUID } from "node:crypto";
import {
  type ModelSelection,
  type ReasoningIntent,
  type RunEvent,
  RunRequestSchema,
  splitCanonicalModelId,
} from "@researk/contracts";
import { type CredentialResolver, Harness, ProviderRegistry } from "@researk/harness";
import { OpenAiCompatibleAdapter } from "@researk/provider-openai-compatible";
import { OpenRouterAdapter } from "@researk/provider-openrouter";
import { type CliArguments, parseArguments } from "./args.js";
import { HELP, VERSION } from "./help.js";
import { processIo, readAll, write } from "./io.js";
import { IncrementalMarkdownMathParser } from "./rendering/parser.js";
import { renderExactSource } from "./rendering/renderer.js";
import {
  configuredSecretValues,
  redactSecrets,
  safeErrorMessage,
  safeJson,
  safeTerminalText,
} from "./safety.js";
import type {
  CliDependencies,
  CliHarness,
  CliIo,
  HarnessRunOptions,
  ProviderEnvironmentReference,
} from "./types.js";

export interface ChatExecutionResult {
  readonly exitCode: number;
  readonly text: string;
  readonly selection?: ModelSelection;
}

export async function runCli(
  argv: readonly string[],
  dependencies: CliDependencies = {},
): Promise<number> {
  const io = dependencies.io ?? processIo();
  const env = dependencies.env ?? process.env;
  let args: CliArguments;
  try {
    args = parseArguments(argv, env);
  } catch (error) {
    await write(io.stderr, `Error: ${safeErrorMessage(error)}\n`);
    return 2;
  }

  if (args.help || args.command === "help") {
    await write(io.stdout, HELP);
    return 0;
  }
  if (args.version || args.command === "version") {
    await write(io.stdout, `${VERSION}\n`);
    return 0;
  }
  if (args.command === "doctor") return doctor(args, io, env);

  if (args.command === undefined) {
    if (!io.isTTY) {
      await write(io.stderr, "Error: a command is required when standard input is not a TTY.\n");
      return 2;
    }
    const { startRepl } = await import("./repl.js");
    return startRepl(args, dependencies, io, env);
  }

  const harnessResult = await resolveHarness(args, dependencies, env, io);
  if (typeof harnessResult === "number") return harnessResult;

  if (args.command === "models") {
    return listModels(harnessResult, args, io, env, dependencies.signal);
  }

  let prompt = args.prompt;
  if (prompt.length === 0 && !io.isTTY) prompt = (await readAll(io.stdin)).trimEnd();
  if (prompt.length === 0) {
    await write(io.stderr, "Error: chat requires a prompt.\n");
    return 2;
  }
  if (args.model === undefined) {
    await write(io.stderr, "Error: chat requires --model provider:model.\n");
    return 2;
  }

  const result = await executeChat({
    harness: harnessResult,
    model: args.model,
    reasoning: args.reasoning,
    messages: [{ role: "user", content: prompt }],
    io,
    json: args.json,
    raw: args.raw || !io.isTTY,
    env,
    apiKeyEnvironmentVariable: args.apiKeyEnvironmentVariable,
    ...(dependencies.signal === undefined ? {} : { signal: dependencies.signal }),
    ...(dependencies.createRunId === undefined ? {} : { createRunId: dependencies.createRunId }),
    ...(dependencies.onApprovalRequest === undefined
      ? {}
      : { onApprovalRequest: dependencies.onApprovalRequest }),
  });
  return result.exitCode;
}

export async function executeChat(
  options: Readonly<{
    harness: CliHarness;
    model: string;
    reasoning: ReasoningIntent;
    messages: readonly Readonly<{
      role: "system" | "user" | "assistant" | "tool";
      content: string;
    }>[];
    io: CliIo;
    json: boolean;
    raw: boolean;
    env: Readonly<Record<string, string | undefined>>;
    apiKeyEnvironmentVariable: string;
    signal?: AbortSignal;
    createRunId?: () => string;
    onApprovalRequest?: HarnessRunOptions["onApprovalRequest"];
  }>,
): Promise<ChatExecutionResult> {
  const parsedModel = splitCanonicalModelId(options.model);
  const request = RunRequestSchema.parse({
    schemaVersion: 1,
    runId: (options.createRunId ?? randomUUID)(),
    selection: {
      providerId: parsedModel.providerId,
      modelId: parsedModel.modelId,
      reasoning: { intent: options.reasoning },
    },
    messages: options.messages,
    requiredCapabilities: {},
    toolPermissions: [],
    stream: true,
  });
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (options.signal?.aborted) controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  const removeInterrupt = options.io.onInterrupt?.(abort);
  const secrets = configuredSecretValues(options.env, options.apiKeyEnvironmentVariable);
  const parser = new IncrementalMarkdownMathParser();
  let text = "";
  let selection: ModelSelection | undefined;
  let exitCode = 0;

  try {
    for await (const event of options.harness.run(request, {
      signal: controller.signal,
      ...(options.onApprovalRequest === undefined
        ? {}
        : { onApprovalRequest: options.onApprovalRequest }),
    })) {
      if (event.type === "text_delta") text += redactSecrets(event.delta, secrets);
      if (event.type === "selection") selection = event.selection;
      const eventCode = await renderEvent(event, options, parser, secrets);
      if (eventCode !== undefined) exitCode = eventCode;
    }
    if (!options.json && !options.raw) {
      const tail = await renderExactSource(parser.finish(), undefined, controller.signal);
      await write(options.io.stdout, safeTerminalText(tail, secrets));
      if (text.length > 0) await write(options.io.stdout, "\n");
    }
  } finally {
    removeInterrupt?.();
    options.signal?.removeEventListener("abort", abort);
  }
  return {
    exitCode,
    text,
    ...(selection === undefined ? {} : { selection }),
  };
}

async function renderEvent(
  event: RunEvent,
  options: Readonly<{
    io: CliIo;
    json: boolean;
    raw: boolean;
    onApprovalRequest?: HarnessRunOptions["onApprovalRequest"];
  }>,
  parser: IncrementalMarkdownMathParser,
  secrets: readonly string[],
): Promise<number | undefined> {
  if (options.json) {
    await write(options.io.stdout, `${safeJson(event, secrets)}\n`);
  } else if (event.type === "text_delta") {
    const safeDelta = redactSecrets(event.delta, secrets);
    if (options.raw) {
      await write(options.io.stdout, safeTerminalText(safeDelta));
    } else {
      const rendered = await renderExactSource(parser.push(safeDelta));
      await write(options.io.stdout, safeTerminalText(rendered));
    }
  } else if (event.type === "phase" && !options.raw) {
    await write(options.io.stderr, `[${event.phase}] ${event.status}\n`);
  } else if (event.type === "selection" && !options.raw) {
    await write(
      options.io.stderr,
      `[model] ${event.selection.canonicalId} reasoning=${event.selection.reasoning.effectiveIntent ?? event.selection.reasoning.requestedIntent}\n`,
    );
  } else if (event.type === "diagnostic") {
    await write(options.io.stderr, `${event.level}: ${redact(event.message, secrets)}\n`);
  } else if (event.type === "approval_request") {
    if (!options.raw)
      await write(options.io.stderr, `[approval] ${safeTerminalText(event.title, secrets)}\n`);
  } else if (event.type === "error") {
    await write(options.io.stderr, `Error: ${redact(event.error.message, secrets)}\n`);
    return 1;
  } else if (event.type === "cancelled") {
    await write(options.io.stderr, "Cancelled.\n");
    return 130;
  }
  if (event.type === "error") return 1;
  if (event.type === "cancelled") return 130;
  return undefined;
}

export async function resolveHarness(
  args: CliArguments,
  dependencies: CliDependencies,
  env: Readonly<Record<string, string | undefined>>,
  io: CliIo,
): Promise<CliHarness | number> {
  if (dependencies.harness !== undefined) return dependencies.harness;
  const model = args.model === undefined ? undefined : splitCanonicalModelId(args.model);
  const providerId = args.providerId ?? model?.providerId;
  if (providerId === undefined) {
    await write(
      io.stderr,
      "Error: configure --provider-id or an explicit --model provider:model.\n",
    );
    return 2;
  }
  const configuration: ProviderEnvironmentReference = {
    providerId,
    ...(model === undefined ? {} : { modelId: model.modelId }),
    ...(args.baseUrl === undefined ? {} : { baseUrl: args.baseUrl }),
    apiKeyEnvironmentVariable: args.apiKeyEnvironmentVariable,
    kind: providerId === "openrouter" ? "openrouter" : "compatible",
  };
  try {
    return dependencies.createHarness === undefined
      ? createInProcessHarness(configuration, env)
      : await dependencies.createHarness(configuration);
  } catch (error) {
    await write(
      io.stderr,
      `Error: ${safeErrorMessage(error, configuredSecretValues(env, args.apiKeyEnvironmentVariable))}\n`,
    );
    return 1;
  }
}

export function createInProcessHarness(
  configuration: ProviderEnvironmentReference,
  env: Readonly<Record<string, string | undefined>>,
): CliHarness {
  const registry = new ProviderRegistry();
  const credentials: CredentialResolver = {
    async resolve(reference, signal) {
      signal.throwIfAborted();
      const value = env[reference];
      if (value === undefined || value.length === 0) {
        throw new Error(`Credential environment variable '${reference}' is not set.`);
      }
      return value;
    },
  };

  if (configuration.providerId === "openrouter") {
    registry.register(
      new OpenRouterAdapter({
        apiKeyReference: configuration.apiKeyEnvironmentVariable,
        ...(configuration.baseUrl === undefined ? {} : { baseUrl: configuration.baseUrl }),
      }),
    );
  } else if (configuration.baseUrl === undefined) {
    throw new Error(
      "Custom OpenAI-compatible providers require --base-url or RESEARK_OPENAI_BASE_URL.",
    );
  } else {
    validateProviderBaseUrl(configuration.baseUrl);
    registry.register(
      new OpenAiCompatibleAdapter({
        providerId: configuration.providerId,
        displayName: configuration.providerId,
        baseUrl: configuration.baseUrl,
        apiKeyReference: configuration.apiKeyEnvironmentVariable,
        kind: "custom",
      }),
    );
  }

  const harness = new Harness({ registry, credentials });
  return {
    run(request, options) {
      return harness.run(request, options.signal);
    },
    async listModels(signal = new AbortController().signal) {
      return (await registry.discover(configuration.providerId, { credentials, signal })).models;
    },
  };
}

function validateProviderBaseUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Provider base URLs must be valid absolute URLs.");
  }
  if (
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new Error("Provider base URLs cannot contain credentials, query strings, or fragments.");
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !local) {
    throw new Error("Provider base URLs must use HTTPS unless they are local loopback endpoints.");
  }
}
async function listModels(
  harness: CliHarness,
  args: CliArguments,
  io: CliIo,
  env: Readonly<Record<string, string | undefined>>,
  signal?: AbortSignal,
): Promise<number> {
  const secrets = configuredSecretValues(env, args.apiKeyEnvironmentVariable);
  try {
    const models = await harness.listModels(signal);
    for (const model of models) {
      if (args.json) {
        await write(io.stdout, `${safeJson(model, secrets)}\n`);
      } else {
        await write(
          io.stdout,
          `${safeTerminalText(model.canonicalId, secrets)}\t${model.status}\n`,
        );
      }
    }
    return 0;
  } catch (error) {
    await write(io.stderr, `Error: ${safeErrorMessage(error, secrets)}\n`);
    return 1;
  }
}

async function doctor(
  args: CliArguments,
  io: CliIo,
  env: Readonly<Record<string, string | undefined>>,
): Promise<number> {
  const report = {
    version: VERSION,
    node: process.version,
    tty: io.isTTY,
    providerConfigured: args.providerId !== undefined || args.model !== undefined,
    baseUrlConfigured: args.baseUrl !== undefined,
    credentialConfigured: Boolean(env[args.apiKeyEnvironmentVariable]),
    telemetry: false,
  } as const;
  if (args.json) await write(io.stdout, `${JSON.stringify(report)}\n`);
  else
    for (const [key, value] of Object.entries(report)) await write(io.stdout, `${key}: ${value}\n`);
  return 0;
}

function redact(value: string, secrets: readonly string[]): string {
  return safeTerminalText(value, secrets);
}
