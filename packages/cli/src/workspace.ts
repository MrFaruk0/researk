import { lstat, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

export const MAX_WORKSPACE_DOCUMENT_BYTES = 1_000_000;
export const MAX_STAGED_WORKSPACE_DOCUMENTS = 8;
export const MAX_STAGED_WORKSPACE_BYTES = 4_000_000;

const SUPPORTED_EXTENSIONS = new Set([".txt", ".md", ".markdown", ".tex", ".latex", ".bib"]);

export interface Workspace {
  readonly root: string;
}

export interface WorkspaceDocument {
  readonly relativePath: string;
  readonly content: string;
  readonly byteLength: number;
}

export class WorkspaceAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceAccessError";
  }
}

/** Resolves the current directory once and treats that real path as the hard workspace boundary. */
export async function openWorkspace(root: string): Promise<Workspace> {
  let resolved: string;
  try {
    resolved = await realpath(root);
  } catch {
    throw new WorkspaceAccessError("The current directory cannot be resolved as a workspace.");
  }

  const details = await stat(resolved);
  if (!details.isDirectory()) {
    throw new WorkspaceAccessError("The current workspace path is not a directory.");
  }
  return Object.freeze({ root: resolved });
}

/**
 * Reads a small, explicitly supported, UTF-8 text document without allowing the resolved target
 * to leave the workspace. The caller decides if and when the returned untrusted data is sent.
 */
export async function readWorkspaceDocument(
  workspace: Workspace,
  inputPath: string,
): Promise<WorkspaceDocument> {
  const relativePath = normalizeRelativePath(inputPath);
  const extension = path.extname(relativePath).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(extension)) {
    throw new WorkspaceAccessError(
      "Only .txt, .md, .markdown, .tex, .latex, and .bib workspace documents can be read.",
    );
  }

  const requestedPath = path.resolve(workspace.root, relativePath);
  if (!isWithin(workspace.root, requestedPath)) {
    throw new WorkspaceAccessError("The document path must remain inside the current workspace.");
  }

  let linkDetails: Awaited<ReturnType<typeof lstat>>;
  try {
    linkDetails = await lstat(requestedPath);
  } catch {
    throw new WorkspaceAccessError("The requested workspace document does not exist.");
  }
  if (linkDetails.isSymbolicLink()) {
    throw new WorkspaceAccessError("Symbolic-link documents are not supported.");
  }

  let targetPath: string;
  try {
    targetPath = await realpath(requestedPath);
  } catch {
    throw new WorkspaceAccessError("The requested workspace document cannot be resolved.");
  }
  if (!isWithin(workspace.root, targetPath)) {
    throw new WorkspaceAccessError(
      "The requested document resolves outside the current workspace.",
    );
  }

  const details = await stat(targetPath);
  if (!details.isFile()) {
    throw new WorkspaceAccessError("The requested workspace path is not a regular file.");
  }
  if (details.size > MAX_WORKSPACE_DOCUMENT_BYTES) {
    throw new WorkspaceAccessError(
      `Workspace documents are limited to ${MAX_WORKSPACE_DOCUMENT_BYTES.toLocaleString("en-US")} bytes.`,
    );
  }

  const bytes = await readFile(targetPath);
  if (bytes.byteLength > MAX_WORKSPACE_DOCUMENT_BYTES) {
    throw new WorkspaceAccessError(
      `Workspace documents are limited to ${MAX_WORKSPACE_DOCUMENT_BYTES.toLocaleString("en-US")} bytes.`,
    );
  }

  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new WorkspaceAccessError("The requested document is not valid UTF-8 text.");
  }
  if (containsBinaryControls(content)) {
    throw new WorkspaceAccessError("The requested document contains binary control bytes.");
  }

  return Object.freeze({
    relativePath: toPortablePath(path.relative(workspace.root, targetPath)),
    content,
    byteLength: bytes.byteLength,
  });
}

export function isSupportedWorkspaceDocumentPath(value: string): boolean {
  return SUPPORTED_EXTENSIONS.has(path.extname(value).toLowerCase());
}

function normalizeRelativePath(value: string): string {
  const source = unwrapQuotedPath(value.trim());
  if (source.length === 0) {
    throw new WorkspaceAccessError("/read requires a relative workspace path.");
  }
  if (path.isAbsolute(source) || path.parse(source).root.length > 0) {
    throw new WorkspaceAccessError("Absolute paths are not allowed in /read.");
  }

  const parts = source.split(/[\\/]+/u);
  if (parts.some((part) => part === "..")) {
    throw new WorkspaceAccessError("Parent-directory traversal is not allowed in /read.");
  }
  const normalized = path.normalize(source);
  if (normalized === "." || normalized.length === 0 || normalized.startsWith(`..${path.sep}`)) {
    throw new WorkspaceAccessError("The document path must remain inside the current workspace.");
  }
  return normalized;
}

function unwrapQuotedPath(value: string): string {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

function containsBinaryControls(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (
      code === 0 ||
      code === 0x7f ||
      (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d)
    ) {
      return true;
    }
  }
  return false;
}

function toPortablePath(value: string): string {
  return value.split(path.sep).join("/");
}
