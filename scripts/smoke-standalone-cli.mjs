import { spawnSync } from "node:child_process";
import { access, mkdir, readdir } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const npmCliPath =
  process.platform === "win32"
    ? join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")
    : resolve(dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js");

async function main() {
  const { artifact, rootDirectory } = readArguments(process.argv.slice(2));
  await access(artifact);
  await assertEmptyDirectory(rootDirectory);

  const prefixDirectory = join(rootDirectory, "global-prefix");
  const workingDirectory = join(rootDirectory, "unrelated-working-directory");
  const npmCacheDirectory = join(rootDirectory, "empty-npm-cache");
  await Promise.all([
    mkdir(prefixDirectory, { recursive: true }),
    mkdir(workingDirectory, { recursive: true }),
    mkdir(npmCacheDirectory, { recursive: true }),
  ]);

  const npmEnvironment = {
    ...process.env,
    npm_config_cache: npmCacheDirectory,
    npm_config_offline: "true",
  };
  runNpm(
    [
      "install",
      "--global",
      "--prefix",
      prefixDirectory,
      "--offline",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--cache",
      npmCacheDirectory,
      artifact,
    ],
    workingDirectory,
    npmEnvironment,
  );

  const executable =
    process.platform === "win32"
      ? join(prefixDirectory, "researk.cmd")
      : join(prefixDirectory, "bin", "researk");
  await access(executable);
  runReseark(executable, ["help"], workingDirectory, npmEnvironment);
  runReseark(executable, ["version"], workingDirectory, npmEnvironment);

  process.stdout.write(
    `${JSON.stringify(
      {
        artifact,
        cache: npmCacheDirectory,
        command: executable,
        prefix: prefixDirectory,
        workingDirectory,
      },
      null,
      2,
    )}\n`,
  );
}

function readArguments(argumentsList) {
  if (argumentsList.length !== 4) {
    throw new Error(
      "Usage: node scripts/smoke-standalone-cli.mjs --artifact <tarball> --root <empty-directory>",
    );
  }

  const values = new Map();
  for (let index = 0; index < argumentsList.length; index += 2) {
    values.set(argumentsList[index], argumentsList[index + 1]);
  }

  const artifact = values.get("--artifact");
  const rootDirectory = values.get("--root");
  if (artifact === undefined || rootDirectory === undefined || values.size !== 2) {
    throw new Error(
      "Usage: node scripts/smoke-standalone-cli.mjs --artifact <tarball> --root <empty-directory>",
    );
  }

  return {
    artifact: isAbsolute(artifact) ? artifact : resolve(repositoryRoot, artifact),
    rootDirectory: isAbsolute(rootDirectory)
      ? rootDirectory
      : resolve(repositoryRoot, rootDirectory),
  };
}

async function assertEmptyDirectory(directory) {
  await mkdir(directory, { recursive: true });
  const entries = await readdir(directory);
  if (entries.length > 0) {
    throw new Error(`Standalone smoke-test root must be empty: ${directory}`);
  }
}

function run(command, argumentsList, cwd, env) {
  const result = spawnSync(command, argumentsList, { cwd, env, stdio: "inherit" });
  if (result.error !== undefined) {
    throw new Error(`Unable to start ${command}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`${command} failed with status ${result.status ?? "unknown"}.`);
  }
}

function runNpm(argumentsList, cwd, env) {
  run(process.execPath, [npmCliPath, ...argumentsList], cwd, env);
}

function runReseark(executable, argumentsList, cwd, env) {
  if (process.platform !== "win32") {
    run(executable, argumentsList, cwd, env);
    return;
  }

  if (/["%&|<>()^!]/.test(executable)) {
    throw new Error(
      "The Windows standalone smoke-test path contains unsafe command-shell characters.",
    );
  }
  const command = [`"${executable}"`, ...argumentsList].join(" ");
  run(process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe", ["/d", "/c", command], cwd, env);
}

await main();
