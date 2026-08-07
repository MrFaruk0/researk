import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * These are host-process regressions. Inherited `execArgv` and worker event-loop references are
 * only observable in a real Node host, so the built package is driven from a child process rather
 * than from the in-process Vitest worker.
 */
const packageEntry = new URL("../dist/index.js", import.meta.url).href;

/** The child is killed well before this, so a hang fails as a normal assertion rather than a hang. */
const childTimeoutMs = 30_000;
const testTimeoutMs = 60_000;

interface ChildOutcome {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

/** Runs an ES module through stdin, which is exactly what forces `--input-type=module`. */
async function runModule(source: string): Promise<ChildOutcome> {
  const child = spawn(process.execPath, ["--input-type=module"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.stdin.end(source);
  return new Promise<ChildOutcome>((resolve, reject) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, childTimeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

describe("renderer host-process lifecycle", () => {
  // The child imports the published entry point, so a stale `dist` would otherwise fail as an
  // unexplained empty stdout instead of a missing build.
  beforeAll(async () => {
    await access(fileURLToPath(packageEntry)).catch(() => {
      throw new Error(
        "packages/latex-renderer/dist is missing. Run `npm run build --workspace @researk/latex-renderer` first.",
      );
    });
  });

  it(
    "renders from a host started with --input-type=module",
    async () => {
      const outcome = await runModule(`
        import { renderTexToSvg } from ${JSON.stringify(packageEntry)};
        const result = await renderTexToSvg({ tex: "x^2" });
        process.stdout.write(result.svg.startsWith("<svg") ? "RENDERED\\n" : "UNEXPECTED\\n");
      `);

      expect(outcome.stderr).not.toContain("ERR_INPUT_TYPE_NOT_ALLOWED");
      expect(outcome.timedOut).toBe(false);
      expect(outcome.stdout).toContain("RENDERED");
      expect(outcome.code).toBe(0);
    },
    testTimeoutMs,
  );

  it(
    "exits a one-shot render process without an explicit renderer shutdown",
    async () => {
      const outcome = await runModule(`
        import { renderTexToSvg } from ${JSON.stringify(packageEntry)};
        await renderTexToSvg({ tex: "x^2" });
        process.stdout.write("DONE\\n");
      `);

      expect(outcome.timedOut).toBe(false);
      expect(outcome.stdout).toContain("DONE");
      expect(outcome.code).toBe(0);
    },
    testTimeoutMs,
  );

  it(
    "exits when the pool is pre-warmed but never used",
    async () => {
      const outcome = await runModule(`
        import { getManagedLatexRenderer } from ${JSON.stringify(packageEntry)};
        getManagedLatexRenderer();
        process.stdout.write("WARMED\\n");
      `);

      expect(outcome.timedOut).toBe(false);
      expect(outcome.stdout).toContain("WARMED");
      expect(outcome.code).toBe(0);
    },
    testTimeoutMs,
  );

  it(
    "exits after a deterministic shutdown and reopens the pool for a later render",
    async () => {
      const outcome = await runModule(`
        import {
          closeManagedLatexRenderer,
          getManagedLatexRenderer,
          LatexRenderBudget,
          renderTexToSvg,
        } from ${JSON.stringify(packageEntry)};
        const renderer = getManagedLatexRenderer();
        await renderTexToSvg({ tex: "x^2" });
        await closeManagedLatexRenderer();
        await renderer.render({ tex: "x^2" }, new LatexRenderBudget()).then(
          () => process.stdout.write("UNEXPECTED\\n"),
          (error) => process.stdout.write(\`CLOSED \${error.code}\\n\`),
        );
        const svg = (await renderTexToSvg({ tex: "x^2" })).svg;
        process.stdout.write(svg.startsWith("<svg") ? "REOPENED\\n" : "UNEXPECTED\\n");
      `);

      expect(outcome.timedOut).toBe(false);
      expect(outcome.stdout).toContain("CLOSED worker_failed");
      expect(outcome.stdout).toContain("REOPENED");
      expect(outcome.code).toBe(0);
    },
    testTimeoutMs,
  );

  it(
    "does not exit while a render is in flight",
    async () => {
      const outcome = await runModule(`
        import { renderTexToSvg } from ${JSON.stringify(packageEntry)};
        const pending = renderTexToSvg({ tex: "\\\\frac{1}{2}" });
        pending.then(
          (result) => process.stdout.write(
            result.svg.startsWith("<svg") ? "SETTLED\\n" : "UNEXPECTED\\n",
          ),
          () => process.stdout.write("REJECTED\\n"),
        );
      `);

      expect(outcome.timedOut).toBe(false);
      expect(outcome.stdout).toContain("SETTLED");
      expect(outcome.code).toBe(0);
    },
    testTimeoutMs,
  );
});
