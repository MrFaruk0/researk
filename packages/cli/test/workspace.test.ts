import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_WORKSPACE_DOCUMENT_BYTES,
  openWorkspace,
  readWorkspaceDocument,
  WorkspaceAccessError,
} from "../src/workspace.js";

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupPaths.splice(0).map((value) => rm(value, { recursive: true, force: true })),
  );
});

async function workspaceFixture(): Promise<Readonly<{ root: string; outside: string }>> {
  const root = await mkdtemp(path.join(tmpdir(), "researk-workspace-"));
  const outside = await mkdtemp(path.join(tmpdir(), "researk-outside-"));
  cleanupPaths.push(root, outside);
  return { root, outside };
}

describe("workspace document boundary", () => {
  it("reads a bounded UTF-8 scientific text document without transmitting it", async () => {
    const fixture = await workspaceFixture();
    await writeFile(path.join(fixture.root, "paper.tex"), "\\section{Methods}\\n$E=mc^2$", "utf8");

    const document = await readWorkspaceDocument(await openWorkspace(fixture.root), "paper.tex");
    expect(document).toMatchObject({
      relativePath: "paper.tex",
      content: "\\section{Methods}\\n$E=mc^2$",
    });
  });

  it("rejects traversal, absolute paths, and unsupported extensions", async () => {
    const fixture = await workspaceFixture();
    await writeFile(path.join(fixture.root, "binary.pdf"), "not a PDF", "utf8");
    const workspace = await openWorkspace(fixture.root);

    await expect(readWorkspaceDocument(workspace, "../outside.md")).rejects.toBeInstanceOf(
      WorkspaceAccessError,
    );
    await expect(
      readWorkspaceDocument(workspace, path.resolve(fixture.root, "binary.pdf")),
    ).rejects.toBeInstanceOf(WorkspaceAccessError);
    await expect(readWorkspaceDocument(workspace, "binary.pdf")).rejects.toBeInstanceOf(
      WorkspaceAccessError,
    );
  });

  it("rejects invalid UTF-8, binary controls, and oversized files", async () => {
    const fixture = await workspaceFixture();
    await writeFile(path.join(fixture.root, "invalid.md"), Buffer.from([0xff, 0xfe]));
    await writeFile(path.join(fixture.root, "control.txt"), "valid\u0000invalid", "utf8");
    await writeFile(
      path.join(fixture.root, "large.txt"),
      Buffer.alloc(MAX_WORKSPACE_DOCUMENT_BYTES + 1, 0x61),
    );
    const workspace = await openWorkspace(fixture.root);

    await expect(readWorkspaceDocument(workspace, "invalid.md")).rejects.toBeInstanceOf(
      WorkspaceAccessError,
    );
    await expect(readWorkspaceDocument(workspace, "control.txt")).rejects.toBeInstanceOf(
      WorkspaceAccessError,
    );
    await expect(readWorkspaceDocument(workspace, "large.txt")).rejects.toBeInstanceOf(
      WorkspaceAccessError,
    );
  });

  it("rejects a link or Windows directory junction that escapes the resolved workspace boundary", async () => {
    const fixture = await workspaceFixture();
    await writeFile(path.join(fixture.outside, "outside.tex"), "outside", "utf8");
    const linkPath = path.join(
      fixture.root,
      process.platform === "win32" ? "escape" : "escape.tex",
    );
    const inputPath = process.platform === "win32" ? "escape/outside.tex" : "escape.tex";
    await symlink(
      process.platform === "win32" ? fixture.outside : path.join(fixture.outside, "outside.tex"),
      linkPath,
      process.platform === "win32" ? "junction" : "file",
    );

    await expect(
      readWorkspaceDocument(await openWorkspace(fixture.root), inputPath),
    ).rejects.toBeInstanceOf(WorkspaceAccessError);
  });
});
