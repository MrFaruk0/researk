import { render } from "ink";
import { closeManagedLatexRenderer } from "@researk/latex-renderer";
import type { CliArguments } from "./args.js";
import { write } from "./io.js";
import { safeErrorMessage } from "./safety.js";
import type { CliDependencies, CliIo, ProviderConnectionKind } from "./types.js";
import { openWorkspace } from "./workspace.js";
import { splitCanonicalModelId } from "@researk/contracts";
import { App } from "./tui/App.js";
import { TuiController } from "./tui/controller.js";
import { createInitialState, type ProviderConnection } from "./tui/state.js";

/**
 * Mounts the full-screen TUI in the terminal's alternate screen buffer.
 *
 * Ink owns entering and leaving the alternate screen, cursor visibility, and raw mode. Restoration
 * runs on normal exit, on Ctrl+C, and on an error, because `unmount` and `cleanup` are invoked from
 * a `finally` block that cannot be skipped.
 */
export async function startTui(
  initial: CliArguments,
  dependencies: CliDependencies,
  io: CliIo,
  env: Readonly<Record<string, string | undefined>>,
): Promise<number> {
  let workspace: Awaited<ReturnType<typeof openWorkspace>>;
  try {
    workspace = await openWorkspace(dependencies.cwd ?? process.cwd());
  } catch (error) {
    await write(io.stderr, `Error: ${safeErrorMessage(error)}\n`);
    return 1;
  }

  const controller = new TuiController({ dependencies, env, workspace });
  const colorEnabled =
    io.isTTY &&
    !initial.raw &&
    !initial.json &&
    !initial.accessible &&
    env.NO_COLOR === undefined &&
    env.TERM !== "dumb";

  const connection = connectionFromArguments(initial);
  const initialState = createInitialState({
    workspaceRoot: workspace.root,
    themeName: "system",
    colorEnabled,
    ...(connection === undefined ? {} : { connection }),
    ...(initial.model === undefined ? {} : { model: initial.model }),
    variant: initial.reasoning,
    ...(dependencies.credentialValues === undefined
      ? {}
      : { credentialValues: dependencies.credentialValues }),
  });

  const instance = render(<App controller={controller} initialState={initialState} />, {
    stdout: io.stdout as NodeJS.WriteStream,
    stdin: io.stdin as NodeJS.ReadStream,
    stderr: io.stderr as NodeJS.WriteStream,
    // The application handles Ctrl+C itself so it can cancel a run without exiting.
    exitOnCtrlC: false,
    alternateScreen: true,
    patchConsole: true,
  });

  try {
    await instance.waitUntilExit();
    return 0;
  } catch (error) {
    instance.unmount();
    await write(io.stderr, `Error: ${safeErrorMessage(error)}\n`);
    return 1;
  } finally {
    // Restores the primary screen, the cursor, and raw mode even if rendering threw.
    instance.cleanup();
    // A long-lived session may have warmed the renderer pool; release it deterministically.
    await closeManagedLatexRenderer();
  }
}

function connectionFromArguments(initial: CliArguments): ProviderConnection | undefined {
  const providerId =
    initial.providerId ??
    (initial.model === undefined ? undefined : splitCanonicalModelId(initial.model).providerId);
  if (providerId === undefined) return undefined;
  const kind: ProviderConnectionKind = providerId === "openrouter" ? "openrouter" : "compatible";
  return {
    providerId,
    ...(initial.baseUrl === undefined ? {} : { baseUrl: initial.baseUrl }),
    apiKeyEnvironmentVariable: initial.apiKeyEnvironmentVariable,
    kind,
  };
}
