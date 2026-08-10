import { Buffer } from "node:buffer";
import { type ReasoningIntent, splitCanonicalModelId } from "@researk/contracts";
import { closeManagedLatexRenderer } from "@researk/latex-renderer";
import { render } from "ink";
import type { CliArguments } from "./args.js";
import { type AppConfig, AppConfigStore } from "./config/config.js";
import type { CredentialStore } from "./config/credentials.js";
import { type DataDirs, ensureDataDirs } from "./config/paths.js";
import { PersistentProviderRegistry } from "./config/providers.js";
import { type Session, SessionStore } from "./config/sessions.js";
import { FileConfigStore } from "./config/store.js";
import { write } from "./io.js";
import { probeTerminalCapability } from "./rendering/terminal-query.js";
import { safeErrorMessage } from "./safety.js";
import { isThemeName } from "./theme.js";
import { App } from "./tui/App.js";
import type { ClipboardTerminalContext } from "./tui/clipboard.js";
import { TuiController } from "./tui/controller.js";
import { createFormulaGraphicsRuntime, type FormulaGraphicsRuntime } from "./tui/graphics.js";
import { DISABLE_MOUSE_TRACKING } from "./tui/mouse.js";
import {
  createInitialState,
  MAX_TUI_CONVERSATION_ENTRIES,
  type ProviderConnection,
} from "./tui/state.js";
import type { CliDependencies, CliIo, ProviderConnectionKind } from "./types.js";
import { openWorkspace } from "./workspace.js";

/**
 * Runtime color policy. These restrictions describe the output channel, so a persisted preference
 * must never be allowed to turn color back on when the channel cannot safely carry it.
 */
export function isRuntimeColorAllowed(
  initial: CliArguments,
  io: CliIo,
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  return (
    io.isTTY &&
    !initial.raw &&
    !initial.json &&
    !initial.accessible &&
    env.NO_COLOR === undefined &&
    env.TERM?.toLowerCase() !== "dumb"
  );
}

/** Applies the persisted color preference without allowing it to bypass runtime restrictions. */
export function resolveStartupColorEnabled(
  runtimeAllowed: boolean,
  persisted: boolean | undefined,
): boolean {
  return runtimeAllowed && persisted !== false;
}

/** Startup and interactive session loading share this workspace boundary. */
export function isSessionInWorkspace(
  session: Pick<Session, "workspace"> | null,
  workspaceRoot: string,
): boolean {
  return session !== null && session.workspace === workspaceRoot;
}

/** Creates the safe credential backend used by normal TUI startup. */
export function createNonPersistentCredentialStore(): CredentialStore {
  return new NonPersistentCredentialStore();
}

/**
 * Graphics probing is an interactive-only capability query. Keeping this gate separate from Ink
 * startup makes it auditable and lets callers prove that raw, JSON, accessible, piped, CI, dumb,
 * and unverified multiplexer sessions never receive a probe sequence.
 */
export function isFormulaGraphicsProbeEligible(
  initial: CliArguments,
  io: CliIo,
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  const term = env.TERM?.toLowerCase();
  return (
    io.isTTY &&
    (initial.command === undefined || initial.command === "chat") &&
    !initial.raw &&
    !initial.json &&
    !initial.accessible &&
    env.CI === undefined &&
    term !== "dumb" &&
    env.TMUX === undefined &&
    env.STY === undefined &&
    env.ZELLIJ === undefined &&
    term !== "screen" &&
    !term?.startsWith("screen-") &&
    term !== "tmux" &&
    !term?.startsWith("tmux-")
  );
}

/** Replays probe bytes before Ink subscribes to stdin, preserving user input byte-for-byte. */
export function replayTerminalInput(io: CliIo, bytes: Uint8Array): void {
  if (bytes.length === 0) return;
  // Node Readable.unshift is the only pre-mount path that preserves ordering without writing user
  // bytes back to a terminal. CliIo.stdin is always a Readable, but retain a guarded fallback for
  // minimal embedding fakes so a capability result can still be used safely.
  io.stdin.unshift(Buffer.from(bytes));
}

/**
 * Mounts the full-screen TUI in the terminal's alternate screen buffer.
 *
 * Ink owns entering and leaving the alternate screen, cursor visibility, and raw mode. Restoration
 * runs on normal exit and on an error, because `unmount` and `cleanup` are invoked from
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

  // --- Persistence -----------------------------------------------------------------
  // Every store is optional and each construction is guarded: when the platform has no per-user
  // data root, or a directory cannot be created, the TUI still runs with in-memory state only.
  const stores = await createStores();

  const controller = new TuiController({
    dependencies,
    env,
    workspace,
    storage: {
      ...(stores.configStore === undefined ? {} : { configStore: stores.configStore }),
      ...(stores.sessionStore === undefined ? {} : { sessionStore: stores.sessionStore }),
      ...(stores.providerRegistry === undefined
        ? {}
        : { providerRegistry: stores.providerRegistry }),
      ...(stores.credentialStore === undefined ? {} : { credentialStore: stores.credentialStore }),
    },
  });
  const runtimeColorAllowed = isRuntimeColorAllowed(initial, io, env);
  const mouseTrackingEnabled = isMouseTrackingEligible(initial, io, env);

  const connection = connectionFromArguments(initial);

  // Restore the persisted provider connection, model, variant, theme, and color preference. The
  // values derived here are fallbacks: an explicit CLI flag always wins over a persisted value, and
  // runtime output restrictions always win over the persisted color preference.
  let loadedConfig: Awaited<ReturnType<AppConfigStore["loadConfig"]>> | null = null;
  if (stores.configStore !== undefined) {
    try {
      loadedConfig = await stores.configStore.loadConfig();
    } catch {
      // Non-fatal: startup continues with defaults.
    }
  }

  let restored: Awaited<ReturnType<typeof restoreState>>;
  try {
    restored = await restoreState(loadedConfig, stores.providerRegistry);
  } catch {
    // Non-fatal: startup continues without a restored connection.
    restored = { credentialValues: {}, variant: "auto" };
  }
  const restoredTheme =
    loadedConfig?.theme !== undefined && isThemeName(loadedConfig.theme)
      ? loadedConfig.theme
      : "system";

  // Restore the last session's conversation when it is persisted. The session metadata and
  // conversation are carried in the initial state, so the restored transcript renders immediately.
  let session: Session | null = null;
  if (loadedConfig?.lastSessionId != null && stores.sessionStore !== undefined) {
    try {
      session = await stores.sessionStore.loadSession(loadedConfig.lastSessionId);
    } catch {
      // Non-fatal: the session is simply not restored.
    }
    if (!isSessionInWorkspace(session, workspace.root)) {
      // A session pointer is global to the local config, but its transcript is workspace-scoped.
      // Do not hydrate a session from another workspace into this TUI.
      session = null;
    }
    // Prune a stale, corrupt, or foreign-workspace pointer so it does not silently persist.
    if (session === null && stores.configStore !== undefined && loadedConfig !== null) {
      try {
        const pruned: AppConfig = { ...loadedConfig, lastSessionId: null };
        await stores.configStore.saveConfig(pruned);
      } catch {
        // Best-effort: the stale pointer is harmless even if the prune fails.
      }
    }
  }

  const initialState = createInitialState({
    workspaceRoot: workspace.root,
    themeName: restoredTheme,
    colorEnabled: resolveStartupColorEnabled(runtimeColorAllowed, loadedConfig?.colorEnabled),
    // An explicit CLI connection/model wins; the restored value is only a fallback.
    ...(connection === undefined ? {} : { connection }),
    ...(connection === undefined && restored.connection !== undefined
      ? { connection: restored.connection }
      : {}),
    ...(initial.model === undefined ? {} : { model: initial.model }),
    ...(initial.model === undefined && restored.model !== undefined
      ? { model: restored.model }
      : {}),
    variant: initial.reasoning === "auto" ? restored.variant : initial.reasoning,
    credentialValues: {
      ...(dependencies.credentialValues ?? {}),
      ...restored.credentialValues,
    },
    ...(session === null
      ? {}
      : {
          sessionId: session.id,
          sessionTitle: session.title,
          sessionUpdatedAt: session.updatedAt,
          conversation: session.messages
            .slice(-MAX_TUI_CONVERSATION_ENTRIES)
            .map((message, index) => ({
              id: `${message.role}-${index}-${Date.now().toString(36)}`,
              role: isMessageRole(message.role) ? message.role : "user",
              source: message.content,
              streaming: false,
              createdAt: Date.now(),
            })),
        }),
  });

  // Probe before Ink mounts so its alternate-screen transition cannot swallow terminal replies or
  // user bytes. A single runtime is retained for the whole TUI lifetime, including unsupported
  // fallback sessions where it remains inert and guarantees source-only rendering.
  const probeEligible = isFormulaGraphicsProbeEligible(initial, io, env);
  let capability: Awaited<ReturnType<typeof probeTerminalCapability>> | undefined;
  if (probeEligible) {
    try {
      capability = await probeTerminalCapability({
        stdin: io.stdin,
        stdout: io.stdout,
        env,
        isTTY: io.isTTY,
        interactive: true,
        accessible: initial.accessible,
        raw: initial.raw,
        json: initial.json,
        replay: (bytes) => replayTerminalInput(io, bytes),
      });
    } catch {
      // The graphics path is optional. A failed probe must leave the normal source TUI usable.
      capability = undefined;
    }
  }
  let graphicsRuntime: FormulaGraphicsRuntime;
  let instance: ReturnType<typeof render> | undefined;
  const pendingGenerations: number[] = [];
  const queueAfterFrame = (generation: number): void => {
    if (instance === undefined) {
      pendingGenerations.push(generation);
      return;
    }
    void graphicsRuntime
      .afterFrame(generation, instance.waitUntilRenderFlush())
      .catch(() => undefined);
  };
  let registrationFrameRequested = false;
  let registrationFrameScheduled = false;
  const scheduleRegistrationFrame = (): void => {
    if (registrationFrameScheduled) return;
    registrationFrameScheduled = true;
    queueMicrotask(() => {
      registrationFrameScheduled = false;
      if (!registrationFrameRequested || graphicsRuntime.disposed) return;
      if (instance === undefined) {
        // The synchronous Ink mount can run layout effects before render() returns. The request
        // remains bounded and is picked up by the post-mount drain below.
        return;
      }
      registrationFrameRequested = false;
      onRender();
    });
  };
  const requestRegistrationFrame = (): void => {
    if (graphicsRuntime?.disposed || registrationFrameRequested) return;
    registrationFrameRequested = true;
    scheduleRegistrationFrame();
  };
  const onRender = (): void => {
    // If registration landed before Ink's commit callback, this render already includes it and the
    // queued follow-up is unnecessary. A registration after this callback leaves the flag set and
    // receives exactly one coalesced post-registration frame.
    registrationFrameRequested = false;
    const generation = graphicsRuntime.beforeFrame(
      terminalColumns(io.stdout),
      terminalRows(io.stdout),
    );
    queueAfterFrame(generation);
  };
  graphicsRuntime = createFormulaGraphicsRuntime({
    stdout: io.stdout,
    capability: capability ?? {
      protocol: "unsupported",
      reason: probeEligible
        ? "terminal graphics probe failed"
        : "terminal graphics probe ineligible",
    },
    requestFrame: requestRegistrationFrame,
    terminalSize: {
      columns: terminalColumns(io.stdout),
      rows: terminalRows(io.stdout),
    },
  });
  try {
    instance = render(
      <App
        controller={controller}
        initialState={initialState}
        mouseTrackingEnabled={mouseTrackingEnabled}
        graphicsRuntime={graphicsRuntime}
        env={env}
        formulaClipboardContext={formulaClipboardContext(io, env, initial.accessible)}
      />,
      {
        stdout: io.stdout as NodeJS.WriteStream,
        stdin: io.stdin as NodeJS.ReadStream,
        stderr: io.stderr as NodeJS.WriteStream,
        // The application consumes Ctrl+C as a no-op and uses Ctrl+X for active-run cancellation.
        exitOnCtrlC: false,
        alternateScreen: true,
        patchConsole: true,
        onRender,
      },
    );
    // Ink invokes onRender during the synchronous mount, before render() returns. Drain those
    // generations only after the instance exists so every graphic waits for the matching Ink
    // flush; subsequent renders queue directly in generation order.
    for (const generation of pendingGenerations.splice(0)) queueAfterFrame(generation);
    if (registrationFrameRequested) scheduleRegistrationFrame();
    await instance.waitUntilExit();
    return 0;
  } catch (error) {
    await write(io.stderr, `Error: ${safeErrorMessage(error)}\n`);
    return 1;
  } finally {
    // Dispose while the alternate screen is still active. This synchronously aborts render work and
    // prevents queued protocol writes from racing Ink's unmount/cleanup or mouse restoration.
    graphicsRuntime.dispose();
    try {
      instance?.unmount();
    } catch {
      // Continue with cleanup and terminal-mode restoration if unmount itself fails.
    }
    // Restores the primary screen, the cursor, and raw mode even if rendering threw.
    try {
      instance?.cleanup();
    } catch {
      // Continue to terminal-mode restoration even if Ink cleanup itself fails.
    }
    if (mouseTrackingEnabled) {
      // Ink and App normally clean this up on unmount; this final write also covers a render or
      // cleanup exception. Sending it twice is harmless and safer than leaving a terminal mode on.
      try {
        await write(io.stdout, DISABLE_MOUSE_TRACKING);
      } catch {
        // A closed output stream cannot be restored from here.
      }
    }
    // A long-lived session may have warmed the renderer pool; release it deterministically.
    await closeManagedLatexRenderer();
  }
}

function isMouseTrackingEligible(
  initial: CliArguments,
  io: CliIo,
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  return (
    io.isTTY &&
    !initial.raw &&
    !initial.json &&
    !initial.accessible &&
    env.TERM?.toLowerCase() !== "dumb" &&
    env.CI === undefined &&
    env.TMUX === undefined &&
    env.STY === undefined
  );
}

function terminalColumns(stdout: object): number {
  const value = (stdout as { readonly columns?: unknown }).columns;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 80;
}

function terminalRows(stdout: object): number {
  const value = (stdout as { readonly rows?: unknown }).rows;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 24;
}

function formulaClipboardContext(
  io: CliIo,
  env: Readonly<Record<string, string | undefined>>,
  accessible: boolean,
): ClipboardTerminalContext {
  return {
    interactive: io.isTTY,
    stdoutIsTTY: io.isTTY,
    env,
    accessible,
  };
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

/**
 * Resolves and creates the persistence stores, or returns `undefined` stores when the platform has
 * no usable per-user data root or a directory could not be created. Persistence is best-effort: its
 * absence must never prevent the TUI from running.
 */
async function createStores(): Promise<
  Readonly<{
    configStore?: AppConfigStore;
    sessionStore?: SessionStore;
    providerRegistry?: PersistentProviderRegistry;
    credentialStore?: CredentialStore;
  }>
> {
  let dirs: DataDirs;
  try {
    dirs = await ensureDataDirs();
  } catch {
    return {};
  }
  const configStore = new AppConfigStore(new FileConfigStore(dirs.config, "app"));
  // ADR 0003 requires OS-backed credential storage. No OS backend is available in this package
  // yet, so normal TUI startup deliberately disables credential persistence rather than creating
  // plaintext files. Provider profiles and non-secret configuration may still persist; an
  // environment variable or an explicitly injected credential resolver supplies secrets.
  const credentialStore = createNonPersistentCredentialStore();
  const providerRegistry = new PersistentProviderRegistry(
    new FileConfigStore(dirs.config, "providers"),
    credentialStore,
  );
  const sessionStore = new SessionStore(dirs.sessions);
  return { configStore, sessionStore, providerRegistry, credentialStore };
}

/**
 * Safe default credential backend for normal TUI startup. It intentionally drops writes and never
 * reads a credential file; FileCredentialStore remains available only to explicit callers/tests.
 */
class NonPersistentCredentialStore implements CredentialStore {
  async get(_ref: string): Promise<string | null> {
    return null;
  }

  async set(_ref: string, _secret: string): Promise<void> {}

  async delete(_ref: string): Promise<void> {}
}

/**
 * Derives the persisted connection, its credential values, and the default model and variant from
 * the loaded app config. Returns only what the config actually holds; the caller decides precedence
 * against explicit CLI flags.
 */
async function restoreState(
  config: Awaited<ReturnType<AppConfigStore["loadConfig"]>> | null,
  providerRegistry: PersistentProviderRegistry | undefined,
): Promise<
  Readonly<{
    connection?: ProviderConnection;
    credentialValues: Record<string, string>;
    model?: string;
    variant: ReasoningIntent;
  }>
> {
  const credentialValues: Record<string, string> = {};
  if (config?.activeProviderId == null || providerRegistry === undefined) {
    return { credentialValues, variant: "auto" };
  }
  const profile = await providerRegistry.getProvider(config.activeProviderId);
  if (profile === undefined) return { credentialValues, variant: "auto" };

  const baseUrl = providerRegistry.resolveBaseUrl(profile);
  const kind: ProviderConnectionKind =
    profile.protocol === "openrouter" ? "openrouter" : "compatible";
  const connection: ProviderConnection = {
    providerId: profile.id,
    ...(baseUrl === undefined ? {} : { baseUrl }),
    apiKeyEnvironmentVariable: profile.credentialRef,
    kind,
  };
  const secret = await providerRegistry.resolveCredential(profile.id);
  if (secret !== null) credentialValues[profile.credentialRef] = secret;

  const model = config.defaultModelByProvider[config.activeProviderId];
  const variant: ReasoningIntent =
    model === undefined
      ? "auto"
      : ((config.selectedVariantByModel[model] as ReasoningIntent | undefined) ?? "auto");
  return { connection, credentialValues, ...(model === undefined ? {} : { model }), variant };
}

const MESSAGE_ROLES: readonly string[] = ["user", "assistant", "tool", "system"];

/** Guards a persisted session role string before it becomes a conversation entry role. */
function isMessageRole(value: string): value is "user" | "assistant" | "tool" | "system" {
  return MESSAGE_ROLES.includes(value);
}
