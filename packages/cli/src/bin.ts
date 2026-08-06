#!/usr/bin/env node

import { runCli } from "./run.js";
import { escapeUnsafeTerminalControls } from "./safety.js";

try {
  process.exitCode = await runCli(process.argv.slice(2));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Fatal error: ${escapeUnsafeTerminalControls(message)}\n`);
  process.exitCode = 1;
}
