import { createInterface } from "node:readline/promises";
import { type ChatMessage, type ReasoningIntent, ReasoningIntentSchema } from "@researk/contracts";
import type { CliArguments } from "./args.js";
import { parseModelIdentity } from "./args.js";
import { REPL_HELP } from "./help.js";
import { write } from "./io.js";
import { executeChat, resolveHarness } from "./run.js";
import { configuredSecretValues, safeErrorMessage } from "./safety.js";
import type { CliDependencies, CliHarness, CliIo } from "./types.js";

export async function startRepl(
  initial: CliArguments,
  dependencies: CliDependencies,
  io: CliIo,
  env: Readonly<Record<string, string | undefined>>,
): Promise<number> {
  const readline = createInterface({ input: io.stdin, output: io.stdout, terminal: io.isTTY });
  let model = initial.model;
  let reasoning: ReasoningIntent = initial.reasoning;
  let harness = dependencies.harness;
  let harnessProvider = initial.providerId;
  const messages: ChatMessage[] = [];
  const secrets = configuredSecretValues(env, initial.apiKeyEnvironmentVariable);
  let active: AbortController | undefined;

  const onSigint = () => {
    if (active !== undefined) active.abort();
  };
  readline.on("SIGINT", onSigint);
  await write(io.stdout, "Researk pre-alpha. Type /help for commands.\n");

  try {
    while (true) {
      let line: string;
      try {
        line = await readline.question("researk> ");
      } catch {
        break;
      }
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      if (trimmed === "/exit") break;
      if (trimmed === "/help") {
        await write(io.stdout, REPL_HELP);
        continue;
      }
      if (trimmed === "/status") {
        await write(io.stdout, `model: ${model ?? "not selected"}\nreasoning: ${reasoning}\n`);
        continue;
      }
      if (trimmed === "/models") {
        const resolved = await ensureHarness();
        if (resolved === undefined) continue;
        try {
          for (const item of await resolved.listModels()) {
            await write(io.stdout, `${item.canonicalId}\t${item.status}\n`);
          }
        } catch (error) {
          await write(io.stderr, `Error: ${safeErrorMessage(error, secrets)}\n`);
        }
        continue;
      }
      if (trimmed.startsWith("/model ")) {
        try {
          const next = parseModelIdentity(trimmed.slice(7).trim());
          const nextProvider = next.slice(0, next.indexOf(":"));
          if (harnessProvider !== nextProvider && dependencies.harness === undefined)
            harness = undefined;
          model = next;
          harnessProvider = nextProvider;
          await write(io.stdout, `Selected ${model}.\n`);
        } catch (error) {
          await write(io.stderr, `Error: ${safeErrorMessage(error, secrets)}\n`);
        }
        continue;
      }
      if (trimmed.startsWith("/reasoning ")) {
        const parsed = ReasoningIntentSchema.safeParse(trimmed.slice(11).trim());
        if (!parsed.success) {
          await write(io.stderr, "Error: invalid reasoning intent.\n");
        } else {
          reasoning = parsed.data;
          await write(io.stdout, `Reasoning set to ${reasoning}.\n`);
        }
        continue;
      }
      if (trimmed.startsWith("/")) {
        await write(io.stderr, "Error: unknown slash command. Use /help.\n");
        continue;
      }
      if (model === undefined) {
        await write(io.stderr, "Error: select an explicit provider:model with /model.\n");
        continue;
      }
      const resolved = await ensureHarness();
      if (resolved === undefined) continue;
      const controller = new AbortController();
      active = controller;
      messages.push({ role: "user", content: line });
      const result = await executeChat({
        harness: resolved,
        model,
        reasoning,
        messages,
        io,
        json: false,
        raw: false,
        env,
        apiKeyEnvironmentVariable: initial.apiKeyEnvironmentVariable,
        signal: controller.signal,
        ...(dependencies.createRunId === undefined
          ? {}
          : { createRunId: dependencies.createRunId }),
        ...(dependencies.onApprovalRequest === undefined
          ? {}
          : { onApprovalRequest: dependencies.onApprovalRequest }),
      });
      active = undefined;
      if (result.exitCode === 0 && result.text.length > 0) {
        messages.push({ role: "assistant", content: result.text });
      }
    }
  } finally {
    active?.abort();
    readline.off("SIGINT", onSigint);
    readline.close();
  }
  return 0;

  async function ensureHarness(): Promise<CliHarness | undefined> {
    if (harness !== undefined) return harness;
    const providerId =
      harnessProvider ??
      (model === undefined ? initial.providerId : model.slice(0, model.indexOf(":")));
    const resolved = await resolveHarness(
      {
        ...initial,
        ...(model === undefined ? {} : { model }),
        ...(providerId === undefined ? {} : { providerId }),
      },
      dependencies,
      env,
      io,
    );
    if (typeof resolved === "number") return undefined;
    harness = resolved;
    harnessProvider = providerId;
    return harness;
  }
}
