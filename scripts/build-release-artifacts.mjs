import { spawnSync } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const npmCliPath =
  process.platform === "win32"
    ? join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")
    : resolve(dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js");

async function main() {
  const outputDirectory = readOutputDirectory(process.argv.slice(2));
  await assertEmptyDirectory(outputDirectory);

  const publicPackages = await discoverPublicPackages();
  const standaloneDirectory = join(outputDirectory, "standalone");
  const npmDirectory = join(outputDirectory, "npm");
  const sbomDirectory = join(outputDirectory, "sbom");
  await Promise.all([
    mkdir(standaloneDirectory, { recursive: true }),
    mkdir(npmDirectory, { recursive: true }),
    mkdir(sbomDirectory, { recursive: true }),
  ]);

  run(
    process.execPath,
    [join(repositoryRoot, "scripts", "build-standalone-cli.mjs"), "--output", standaloneDirectory],
    repositoryRoot,
  );

  for (const packageRecord of publicPackages) {
    runNpm(
      [
        "pack",
        "--workspace",
        packageRecord.name,
        "--pack-destination",
        npmDirectory,
        "--ignore-scripts",
      ],
      repositoryRoot,
    );
    const sbom = runNpm(
      [
        "sbom",
        "--workspace",
        packageRecord.name,
        "--sbom-format",
        "spdx",
        "--package-lock-only",
        "--omit",
        "dev",
      ],
      repositoryRoot,
      true,
    );
    await writeFile(
      join(sbomDirectory, `${packageRecord.name.replace("@", "").replace("/", "-")}.spdx.json`),
      sbom,
      "utf8",
    );
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        npmPackages: publicPackages.map((packageRecord) => packageRecord.name),
        outputDirectory,
        standaloneDirectory,
      },
      null,
      2,
    )}\n`,
  );
}

function readOutputDirectory(argumentsList) {
  if (
    argumentsList.length !== 2 ||
    argumentsList[0] !== "--output" ||
    argumentsList[1] === undefined
  ) {
    throw new Error("Usage: node scripts/build-release-artifacts.mjs --output <empty-directory>");
  }
  return isAbsolute(argumentsList[1])
    ? argumentsList[1]
    : resolve(repositoryRoot, argumentsList[1]);
}

async function assertEmptyDirectory(directory) {
  await mkdir(directory, { recursive: true });
  if ((await readdir(directory)).length > 0) {
    throw new Error(`Release artifact output directory must be empty: ${directory}`);
  }
}

async function discoverPublicPackages() {
  const rootPackage = await readJson(join(repositoryRoot, "package.json"));
  const entries = await readdir(join(repositoryRoot, "packages"), { withFileTypes: true });
  const publicPackages = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const packageJson = await readJson(
      join(repositoryRoot, "packages", entry.name, "package.json"),
    );
    if (packageJson.private === true) {
      continue;
    }
    if (typeof packageJson.name !== "string" || !packageJson.name.startsWith("@researk/")) {
      throw new Error(`Public workspace ${entry.name} must use an @researk/* package name.`);
    }
    if (packageJson.version !== rootPackage.version) {
      throw new Error(`${packageJson.name} must have version ${rootPackage.version}.`);
    }
    publicPackages.push({ name: packageJson.name });
  }

  publicPackages.sort((first, second) => first.name.localeCompare(second.name));
  return publicPackages;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function runNpm(argumentsList, cwd, captureOutput = false) {
  return run(process.execPath, [npmCliPath, ...argumentsList], cwd, captureOutput);
}

function run(command, argumentsList, cwd, captureOutput = false) {
  const result = spawnSync(command, argumentsList, {
    cwd,
    encoding: "utf8",
    stdio: captureOutput ? ["ignore", "pipe", "inherit"] : "inherit",
  });
  if (result.error !== undefined) {
    throw new Error(`Unable to start ${command}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`${command} failed with status ${result.status ?? "unknown"}.`);
  }
  return captureOutput ? (result.stdout ?? "") : undefined;
}

await main();
