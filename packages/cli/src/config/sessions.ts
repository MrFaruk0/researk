import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  CanonicalModelIdSchema,
  ModelIdSchema,
  ProviderIdSchema,
  ReasoningIntentSchema,
} from "@researk/contracts";
import { dataDirs } from "./paths.js";

export const SESSION_SCHEMA_VERSION = 1;
export const AUTO_TITLE_MAX_CHARACTERS = 80;

/** Defensive limits for untrusted session files. These bounds apply before records enter TUI state. */
export const MAX_SESSION_FILE_BYTES = 32 * 1024 * 1024;
export const MAX_SESSION_MESSAGES = 100;
export const MAX_SESSION_ID_CHARACTERS = 128;
export const MAX_SESSION_TITLE_CHARACTERS = 256;
export const MAX_SESSION_WORKSPACE_CHARACTERS = 4_096;
export const MAX_SESSION_METADATA_CHARACTERS = 512;
export const MAX_SESSION_MESSAGE_CHARACTERS = 16 * 1024 * 1024;

/** Queues writes/deletes by their final session path while leaving unrelated sessions independent. */
const writeQueues = new Map<string, Promise<void>>();

export interface SessionMessage {
  readonly role: "user" | "assistant" | "tool" | "system";
  readonly content: string;
}

export interface SessionMeta {
  readonly id: string;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly workspace: string;
  readonly providerId: string | null;
  readonly modelId: string | null;
  readonly variantId: string | null;
  readonly messageCount: number;
}

export interface Session {
  readonly schemaVersion: number;
  readonly id: string;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly workspace: string;
  readonly providerId: string | null;
  readonly modelId: string | null;
  readonly variantId: string | null;
  readonly messages: readonly SessionMessage[];
}

/** Maps a session id to a safe filename inside the sessions directory. */
function sessionFileName(id: string): string {
  return `${encodeURIComponent(id)}.json`;
}

/**
 * Plain-title generator for a conversation: the first user message, truncated to 80 characters.
 * Empty user text falls back to a neutral title.
 */
export function autoTitle(messages: readonly SessionMessage[]): string {
  const firstUser = messages.find((message) => message.role === "user");
  const source = firstUser?.content.trim() ?? "";
  if (source.length === 0) return "New session";
  const characters = Array.from(source);
  const truncated = characters.slice(0, AUTO_TITLE_MAX_CHARACTERS).join("");
  return characters.length > AUTO_TITLE_MAX_CHARACTERS ? `${truncated}…` : truncated;
}

/**
 * Per-session JSON files in the sessions directory. Every write is atomic (temporary file then
 * rename) and every read is defensive: a missing, corrupt, or unreadable file surfaces as `null`
 * rather than an exception, so a single bad session can never break the session list.
 */
export class SessionStore {
  readonly #directory: string;

  constructor(directory?: string) {
    this.#directory = directory ?? defaultSessionsDirectory();
  }

  async listSessions(): Promise<SessionMeta[]> {
    const entries = await this.#readAllSessions();
    return entries
      .map((session) => toMeta(session))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async loadSession(id: string): Promise<Session | null> {
    if (!isBoundedMetadataString(id, MAX_SESSION_ID_CHARACTERS, false)) return null;
    return this.#readSession(sessionFileName(id));
  }

  async saveSession(session: Session): Promise<void> {
    if (!isSession(session)) throw new Error("Invalid session record.");
    const fileName = sessionFileName(session.id);
    const filePath = path.join(this.#directory, fileName);
    return enqueueWrite(filePath, () => writeSessionAtomically(filePath, session));
  }

  async deleteSession(id: string): Promise<void> {
    const filePath = path.join(this.#directory, sessionFileName(id));
    return enqueueWrite(filePath, () => rm(filePath, { force: true }));
  }

  async #readAllSessions(): Promise<Session[]> {
    let names: string[];
    try {
      names = await this.#listSessionFiles();
    } catch {
      return [];
    }
    const sessions: Session[] = [];
    for (const name of names) {
      const session = await this.#readSession(name);
      if (session !== null) sessions.push(session);
    }
    return sessions;
  }

  async #readSession(fileName: string): Promise<Session | null> {
    try {
      const details = await stat(path.join(this.#directory, fileName));
      if (!details.isFile() || details.size > MAX_SESSION_FILE_BYTES) return null;
    } catch (error) {
      if (isNodeError(error) && (error.code === "ENOENT" || error.code === "EACCES")) return null;
      throw error;
    }
    let raw: string;
    try {
      raw = await readFile(path.join(this.#directory, fileName), "utf8");
    } catch (error) {
      if (isNodeError(error) && (error.code === "ENOENT" || error.code === "EACCES")) {
        return null;
      }
      throw error;
    }
    if (Buffer.byteLength(raw, "utf8") > MAX_SESSION_FILE_BYTES) return null;
    try {
      const parsed: unknown = JSON.parse(raw);
      return isSession(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  async #listSessionFiles(): Promise<string[]> {
    const names = await readdir(this.#directory, { withFileTypes: true });
    return names
      .filter(
        (entry) =>
          entry.isFile() && entry.name.endsWith(".json") && !entry.name.endsWith(".json.tmp"),
      )
      .map((entry) => entry.name);
  }
}

/** Runs an operation after all earlier operations for the same session path have settled. */
function enqueueWrite<T>(targetPath: string, operation: () => Promise<T>): Promise<T> {
  const previous = writeQueues.get(targetPath) ?? Promise.resolve();
  const result = previous.then(operation);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  writeQueues.set(targetPath, tail);
  void tail.then(() => {
    if (writeQueues.get(targetPath) === tail) writeQueues.delete(targetPath);
  });
  return result;
}

/** Writes a session to a unique sibling temporary file before atomically replacing the target. */
async function writeSessionAtomically(filePath: string, session: Session): Promise<void> {
  const directory = path.dirname(filePath);
  const temporaryPath = path.join(directory, `${path.basename(filePath)}.${randomUUID()}.tmp`);
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(temporaryPath, `${JSON.stringify(session, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    await rename(temporaryPath, filePath);
  } finally {
    // The temp path is gone after rename; this cleanup covers partial writes and failed renames.
    await rm(temporaryPath, { force: true }).catch(() => {});
  }
}

function toMeta(session: Session): SessionMeta {
  return {
    id: session.id,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    workspace: session.workspace,
    providerId: session.providerId,
    modelId: session.modelId,
    variantId: session.variantId,
    messageCount: session.messages.length,
  };
}

function isSession(value: unknown): value is Session {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  const allowedFields = new Set([
    "schemaVersion",
    "id",
    "title",
    "createdAt",
    "updatedAt",
    "workspace",
    "providerId",
    "modelId",
    "variantId",
    "messages",
  ]);
  if (Object.keys(candidate).some((key) => !allowedFields.has(key))) return false;
  if (
    candidate.schemaVersion === SESSION_SCHEMA_VERSION &&
    isBoundedMetadataString(candidate.id, MAX_SESSION_ID_CHARACTERS, false) &&
    isBoundedMetadataString(candidate.title, MAX_SESSION_TITLE_CHARACTERS, true) &&
    isIsoTimestamp(candidate.createdAt) &&
    isIsoTimestamp(candidate.updatedAt) &&
    isBoundedMetadataString(candidate.workspace, MAX_SESSION_WORKSPACE_CHARACTERS, false) &&
    Array.isArray(candidate.messages)
  ) {
    if (candidate.messages.length > MAX_SESSION_MESSAGES) return false;
    const providerId = nullableString(candidate.providerId);
    const modelId = nullableString(candidate.modelId);
    const variantId = nullableString(candidate.variantId);
    if (providerId === undefined || modelId === undefined || variantId === undefined) return false;
    if (
      providerId !== null &&
      (!isBoundedMetadataString(providerId, MAX_SESSION_METADATA_CHARACTERS, false) ||
        !ProviderIdSchema.safeParse(providerId).success)
    ) {
      return false;
    }
    if (modelId !== null) {
      if (!isBoundedMetadataString(modelId, MAX_SESSION_METADATA_CHARACTERS, false)) return false;
      const parsedModel = CanonicalModelIdSchema.safeParse(modelId);
      // Provider/model consistency is checked at restoration time. Keep legacy provider-qualified
      // model ids readable here so their transcript can be inspected and repaired safely.
      if (!parsedModel.success && !ModelIdSchema.safeParse(modelId).success) {
        return false;
      }
    }
    if (
      variantId !== null &&
      (!isBoundedMetadataString(variantId, MAX_SESSION_METADATA_CHARACTERS, false) ||
        !ReasoningIntentSchema.safeParse(variantId).success)
    ) {
      return false;
    }
    if (
      !candidate.messages.every(
        (message) =>
          message !== null &&
          typeof message === "object" &&
          isExactMessage(message as Record<string, unknown>),
      )
    ) {
      return false;
    }
    // Older session files predate the explicit identity fields. Normalize absent values to null so
    // untrusted `undefined` metadata never enters the TUI state or gets re-serialized as a secret.
    Object.assign(candidate, { providerId, modelId, variantId });
    return true;
  }
  return false;
}

function nullableString(value: unknown): string | null | undefined {
  if (value === undefined) return null;
  return value === null || typeof value === "string" ? value : undefined;
}

function isSessionRole(value: unknown): value is SessionMessage["role"] {
  return value === "user" || value === "assistant" || value === "tool" || value === "system";
}

function isExactMessage(value: Record<string, unknown>): boolean {
  return (
    Object.keys(value).every((key) => key === "role" || key === "content") &&
    isSessionRole(value.role) &&
    typeof value.content === "string" &&
    Buffer.byteLength(value.content, "utf8") <= MAX_SESSION_MESSAGE_CHARACTERS
  );
}

function isBoundedMetadataString(
  value: unknown,
  maximumCharacters: number,
  allowEmpty: boolean,
): value is string {
  if (typeof value !== "string") return false;
  if (!allowEmpty && value.length === 0) return false;
  return value.length <= maximumCharacters && !containsUnsafeMetadataControls(value);
}

function containsUnsafeMetadataControls(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

function isIsoTimestamp(value: unknown): value is string {
  if (!isBoundedMetadataString(value, 64, false)) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function defaultSessionsDirectory(): string {
  const dirs = dataDirs();
  if (dirs === null) {
    throw new Error(
      "Researk sessions directory cannot be resolved: no APPDATA, HOME, or XDG_DATA_HOME is set.",
    );
  }
  return dirs.sessions;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
