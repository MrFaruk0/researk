import { randomUUID } from "node:crypto";
import {
  type ModelSelection,
  type ReasoningIntent,
  type RunEvent,
  RunRequestSchema,
  splitCanonicalModelId,
} from "@researk/contracts";
import { type CredentialResolver, Harness, ProviderRegistry } from "@researk/harness";
import { LatexRenderBudget } from "@researk/latex-renderer";
import { OpenAiCompatibleAdapter } from "@researk/provider-openai-compatible";
import { OpenRouterAdapter } from "@researk/provider-openrouter";
import { type CliArguments, parseArguments } from "./args.js";
import { HELP, VERSION } from "./help.js";
import { processIo, readAll, write } from "./io.js";
import { IncrementalMarkdownMathParser } from "./rendering/parser.js";
import { renderInteractiveEvents } from "./rendering/renderer.js";
import {
  configuredSecretValues,
  StreamingSecretRedactor,
  safeErrorMessage,
  safeJson,
  safeTerminalText,
} from "./safety.js";
import type { CliTheme } from "./theme.js";
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
    return listModels(
      harnessResult,
      args,
      io,
      env,
      dependencies.credentialValues,
      dependencies.signal,
    );
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
    accessible: args.accessible,
    env,
    apiKeyEnvironmentVariable: args.apiKeyEnvironmentVariable,
    ...(dependencies.credentialValues === undefined
      ? {}
      : { credentialValues: dependencies.credentialValues }),
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
    /** Ephemeral credentials to redact from every event and returned value. */
    credentialValues?: Readonly<Record<string, string>>;
    signal?: AbortSignal;
    createRunId?: () => string;
    onApprovalRequest?: HarnessRunOptions["onApprovalRequest"];
    theme?: CliTheme;
    accessible?: boolean;
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
  const secrets = configuredSecretValues(
    options.env,
    options.apiKeyEnvironmentVariable,
    options.credentialValues,
  );
  const parser = new IncrementalMarkdownMathParser();
  const latexRenderBudget = new LatexRenderBudget();
  const streamRedactor = new StreamingSecretRedactor(secrets);
  let text = "";
  let pendingTextEvent: Extract<RunEvent, { type: "text_delta" }> | undefined;
  let selection: ModelSelection | undefined;
  let exitCode = 0;

  try {
    for await (const event of options.harness.run(request, {
      signal: controller.signal,
      ...(options.onApprovalRequest === undefined
        ? {}
        : { onApprovalRequest: options.onApprovalRequest }),
    })) {
      if (event.type === "text_delta") {
        pendingTextEvent = event;
        const safeDelta = streamRedactor.push(event.delta);
        if (safeDelta.length === 0) continue;
        text += safeDelta;
        const eventCode = await renderEvent(
          { ...event, delta: safeDelta },
          options,
          parser,
          secrets,
          latexRenderBudget,
        );
        if (eventCode !== undefined) exitCode = eventCode;
        continue;
      }
      if (event.type === "selection") selection = redactSelection(event.selection, secrets);
      const eventCode = await renderEvent(event, options, parser, secrets, latexRenderBudget);
      if (eventCode !== undefined) exitCode = eventCode;
    }
    if (pendingTextEvent !== undefined) {
      const tail = streamRedactor.finish();
      if (tail.length > 0) {
        text += tail;
        await renderEvent(
          { ...pendingTextEvent, delta: tail },
          options,
          parser,
          secrets,
          latexRenderBudget,
        );
      }
    }
    if (!options.json && !options.raw) {
      // The parser only ever received text already redacted and neutralized by renderEvent, so the
      // tail events are inert and the renderer's own theme ANSI is written verbatim.
      const tail = await renderInteractiveEvents(parser.finish(), {
        interactive: options.io.isTTY && !options.raw,
        stdout: options.io.stdout,
        env: options.env,
        writeText: (value) => write(options.io.stdout, value),
        ...(options.theme === undefined ? {} : { theme: options.theme }),
        ...(options.accessible === undefined ? {} : { accessible: options.accessible }),
        budget: latexRenderBudget,
        signal: controller.signal,
      });
      await write(options.io.stdout, tail);
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
    theme?: CliTheme;
    accessible?: boolean;
    env: Readonly<Record<string, string | undefined>>;
  }>,
  parser: IncrementalMarkdownMathParser,
  secrets: readonly string[],
  latexRenderBudget: LatexRenderBudget,
): Promise<number | undefined> {
  if (options.json) {
    await write(options.io.stdout, `${safeJson(event, secrets)}\n`);
  } else if (event.type === "text_delta") {
    // Untrusted model text is redacted and neutralized once, here, before it can reach the parser
    // or the theme. Escaping is per code point and never spans a chunk boundary, and it preserves
    // tab, carriage return, and line feed, so incremental Markdown and math parsing is unaffected.
    const safeDelta = safeTerminalText(event.delta, secrets);
    if (options.raw) {
      await write(options.io.stdout, safeDelta);
    } else {
      // The renderer output is trusted: it carries theme ANSI over already-neutralized source, so
      // it is written verbatim rather than escaped a second time.
      const rendered = await renderInteractiveEvents(parser.push(safeDelta), {
        interactive: options.io.isTTY,
        stdout: options.io.stdout,
        env: options.env,
        writeText: (value) => write(options.io.stdout, value),
        ...(options.theme === undefined ? {} : { theme: options.theme }),
        ...(options.accessible === undefined ? {} : { accessible: options.accessible }),
        budget: latexRenderBudget,
      });
      await write(options.io.stdout, rendered);
    }
  } else if (event.type === "phase" && !options.raw) {
    await write(options.io.stderr, `[${event.phase}] ${event.status}\n`);
  } else if (event.type === "selection" && !options.raw) {
    await write(
      options.io.stderr,
      `[model] ${safeTerminalText(event.selection.canonicalId, secrets)} reasoning=${event.selection.reasoning.effectiveIntent ?? event.selection.reasoning.requestedIntent}\n`,
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
      ? createInProcessHarness(configuration, env, dependencies.credentialValues)
      : await dependencies.createHarness(configuration, dependencies.credentialValues ?? {});
  } catch (error) {
    await write(
      io.stderr,
      `Error: ${safeErrorMessage(
        error,
        configuredSecretValues(env, args.apiKeyEnvironmentVariable, dependencies.credentialValues),
      )}\n`,
    );
    return 1;
  }
}

export function createInProcessHarness(
  configuration: ProviderEnvironmentReference,
  env: Readonly<Record<string, string | undefined>>,
  credentialValues: Readonly<Record<string, string>> = {},
): CliHarness {
  const registry = new ProviderRegistry();
  const credentials: CredentialResolver = {
    async resolve(reference, signal) {
      signal.throwIfAborted();
      const value = credentialValues[reference] ?? env[reference];
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
  credentialValues: Readonly<Record<string, string>> | undefined,
  signal?: AbortSignal,
): Promise<number> {
  const secrets = configuredSecretValues(env, args.apiKeyEnvironmentVariable, credentialValues);
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

function redactSelection(selection: ModelSelection, secrets: readonly string[]): ModelSelection {
  return JSON.parse(safeJson(selection, secrets)) as ModelSelection;
}
