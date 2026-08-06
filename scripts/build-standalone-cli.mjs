import { spawnSync } from "node:child_process";
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = join(repositoryRoot, "packages");
const npmCliPath =
  process.platform === "win32"
    ? join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")
    : resolve(dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js");

async function main() {
  const outputDirectory = readOutputDirectory(process.argv.slice(2));
  await assertEmptyOutputDirectory(outputDirectory);

  const rootPackage = await readJson(join(repositoryRoot, "package.json"));
  const workspacePackages = await discoverWorkspacePackages(rootPackage.version);
  await assertBuiltWorkspace(workspacePackages);

  const stageDirectory = await mkdtemp(join(tmpdir(), "researk-standalone-"));

  try {
    const packageDirectory = join(stageDirectory, "package");
    const inputTarballDirectory = join(stageDirectory, "input-tarballs");
    const npmCacheDirectory = join(stageDirectory, "npm-cache");
    await mkdir(packageDirectory, { recursive: true });
    await mkdir(inputTarballDirectory, { recursive: true });
    await mkdir(npmCacheDirectory, { recursive: true });

    await packWorkspacePackages(workspacePackages, inputTarballDirectory);
    const externalPackages = await discoverExternalRuntimeClosure(workspacePackages);
    await packExternalRuntimeDependencies(externalPackages, inputTarballDirectory);

    const runtimePackages = [...workspacePackages, ...externalPackages].sort(comparePackageNames);
    const dependencies = Object.fromEntries(
      runtimePackages.map((packageRecord) => [packageRecord.name, packageRecord.version]),
    );
    await writeStandalonePackage(packageDirectory, rootPackage, dependencies);
    await installBundledDependencies(
      packageDirectory,
      inputTarballDirectory,
      runtimePackages,
      npmCacheDirectory,
    );

    const sbomPath = join(outputDirectory, "researk-standalone.spdx.json");
    const sbom = runNpm(["sbom", "--sbom-format", "spdx", "--omit", "dev"], packageDirectory, {
      captureOutput: true,
      npmCacheDirectory,
    });
    await writeFile(sbomPath, sbom, "utf8");
    runNpm(["pack", "--pack-destination", outputDirectory, "--ignore-scripts"], packageDirectory);

    const tarballs = (await readdir(outputDirectory)).filter((entry) => entry.endsWith(".tgz"));
    if (tarballs.length !== 1) {
      throw new Error("Expected exactly one standalone CLI tarball.");
    }

    process.stdout.write(
      `${JSON.stringify(
        {
          artifact: join(outputDirectory, tarballs[0]),
          bundledPackages: runtimePackages.map(
            (packageRecord) => `${packageRecord.name}@${packageRecord.version}`,
          ),
          sbom: sbomPath,
          version: rootPackage.version,
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    await rm(stageDirectory, { force: true, recursive: true });
  }
}

function readOutputDirectory(argumentsList) {
  if (argumentsList.length !== 2 || argumentsList[0] !== "--output") {
    throw new Error("Usage: node scripts/build-standalone-cli.mjs --output <empty-directory>");
  }

  const requestedPath = argumentsList[1];
  if (requestedPath === undefined || requestedPath.length === 0) {
    throw new Error("The standalone artifact output directory is required.");
  }

  return isAbsolute(requestedPath) ? requestedPath : resolve(repositoryRoot, requestedPath);
}

async function assertEmptyOutputDirectory(outputDirectory) {
  await mkdir(outputDirectory, { recursive: true });
  const existingEntries = await readdir(outputDirectory);
  if (existingEntries.length > 0) {
    throw new Error(`Standalone artifact output directory must be empty: ${outputDirectory}`);
  }
}

async function discoverWorkspacePackages(releaseVersion) {
  const entries = await readdir(workspaceRoot, { withFileTypes: true });
  const workspacePackages = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const directory = join(workspaceRoot, entry.name);
    const packageJsonPath = join(directory, "package.json");
    try {
      await access(packageJsonPath);
    } catch {
      continue;
    }

    const packageJson = await readJson(packageJsonPath);
    if (packageJson.private === true) {
      continue;
    }
    if (typeof packageJson.name !== "string" || !packageJson.name.startsWith("@researk/")) {
      throw new Error(`Workspace package at ${directory} must have an @researk/* name.`);
    }
    if (packageJson.version !== releaseVersion) {
      throw new Error(`${packageJson.name} must have release version ${releaseVersion}.`);
    }

    workspacePackages.push({
      directory,
      name: packageJson.name,
      packageJson,
      version: packageJson.version,
    });
  }

  workspacePackages.sort(comparePackageNames);
  if (!workspacePackages.some((packageRecord) => packageRecord.name === "@researk/cli")) {
    throw new Error("The standalone distribution requires an @researk/cli workspace package.");
  }
  return workspacePackages;
}

async function assertBuiltWorkspace(workspacePackages) {
  for (const packageRecord of workspacePackages) {
    await access(join(packageRecord.directory, "dist"));
  }

  await access(join(repositoryRoot, "packages", "cli", "dist", "bin.js"));
}

async function packWorkspacePackages(workspacePackages, inputTarballDirectory) {
  for (const packageRecord of workspacePackages) {
    runNpm(
      [
        "pack",
        "--workspace",
        packageRecord.name,
        "--pack-destination",
        inputTarballDirectory,
        "--ignore-scripts",
      ],
      repositoryRoot,
    );
  }
}

async function discoverExternalRuntimeClosure(workspacePackages) {
  const workspaceNames = new Set(workspacePackages.map((packageRecord) => packageRecord.name));
  const externalPackages = new Map();
  const pendingDependencies = workspacePackages.flatMap((packageRecord) =>
    runtimeDependencies(packageRecord.packageJson).map((dependency) => ({
      ...dependency,
      fromDirectory: packageRecord.directory,
    })),
  );

  while (pendingDependencies.length > 0) {
    const dependency = pendingDependencies.pop();
    if (dependency === undefined || workspaceNames.has(dependency.name)) {
      continue;
    }

    const directory = await findInstalledPackageDirectory(
      dependency.name,
      dependency.fromDirectory,
    );
    if (directory === undefined) {
      if (dependency.optional) {
        continue;
      }
      throw new Error(
        `Required runtime dependency ${dependency.name} is not installed for ${dependency.fromDirectory}.`,
      );
    }

    const packageJson = await readJson(join(directory, "package.json"));
    if (packageJson.name !== dependency.name || typeof packageJson.version !== "string") {
      throw new Error(
        `Installed package metadata is invalid for runtime dependency ${dependency.name}.`,
      );
    }

    const existing = externalPackages.get(packageJson.name);
    if (existing !== undefined) {
      if (existing.version !== packageJson.version) {
        throw new Error(
          `The standalone distribution cannot flatten multiple runtime versions of ${packageJson.name}: ${existing.version} and ${packageJson.version}.`,
        );
      }
      continue;
    }

    const packageRecord = {
      directory,
      name: packageJson.name,
      packageJson,
      version: packageJson.version,
    };
    externalPackages.set(packageRecord.name, packageRecord);
    pendingDependencies.push(
      ...runtimeDependencies(packageJson).map((nestedDependency) => ({
        ...nestedDependency,
        fromDirectory: directory,
      })),
    );
  }

  return [...externalPackages.values()].sort(comparePackageNames);
}

function runtimeDependencies(packageJson) {
  const dependencies = [];
  addRuntimeDependencies(dependencies, packageJson.dependencies, false);
  addRuntimeDependencies(dependencies, packageJson.optionalDependencies, true);

  for (const name of Object.keys(packageJson.peerDependencies ?? {})) {
    const optional = packageJson.peerDependenciesMeta?.[name]?.optional === true;
    dependencies.push({ name, optional });
  }

  return dependencies;
}

function addRuntimeDependencies(dependencies, dependencyMap, optional) {
  for (const name of Object.keys(dependencyMap ?? {})) {
    dependencies.push({ name, optional });
  }
}

async function findInstalledPackageDirectory(packageName, fromDirectory) {
  let candidateParent = fromDirectory;

  while (true) {
    const packageDirectory = join(candidateParent, "node_modules", ...packageName.split("/"));
    try {
      await access(join(packageDirectory, "package.json"));
      return packageDirectory;
    } catch {
      if (candidateParent === repositoryRoot) {
        return undefined;
      }
      const parentDirectory = dirname(candidateParent);
      if (parentDirectory === candidateParent) {
        return undefined;
      }
      candidateParent = parentDirectory;
    }
  }
}

async function packExternalRuntimeDependencies(externalPackages, inputTarballDirectory) {
  for (const packageRecord of externalPackages) {
    runNpm(
      [
        "pack",
        packageRecord.directory,
        "--pack-destination",
        inputTarballDirectory,
        "--ignore-scripts",
      ],
      repositoryRoot,
    );
  }
}

async function writeStandalonePackage(packageDirectory, rootPackage, dependencies) {
  await mkdir(join(packageDirectory, "bin"), { recursive: true });

  const packageJson = {
    name: "researk",
    version: rootPackage.version,
    description: "Self-contained Researk CLI distribution",
    license: "Apache-2.0",
    type: "module",
    engines: rootPackage.engines,
    repository: rootPackage.repository,
    bugs: rootPackage.bugs,
    homepage: rootPackage.homepage,
    bin: {
      researk: "./bin/researk.js",
    },
    files: ["bin", "LICENSE", "README.md"],
    dependencies,
    bundledDependencies: Object.keys(dependencies),
  };

  await writeFile(
    join(packageDirectory, "package.json"),
    `${JSON.stringify(packageJson, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    join(packageDirectory, "bin", "researk.js"),
    '#!/usr/bin/env node\nimport "@researk/cli/dist/bin.js";\n',
    "utf8",
  );
  await copyFile(join(repositoryRoot, "LICENSE"), join(packageDirectory, "LICENSE"));
  await writeFile(
    join(packageDirectory, "README.md"),
    `# Researk ${rootPackage.version}\n\nThis GitHub Release artifact bundles the Researk CLI and its complete runtime dependency closure.\n`,
    "utf8",
  );
}

async function installBundledDependencies(
  packageDirectory,
  inputTarballDirectory,
  runtimePackages,
  npmCacheDirectory,
) {
  const tarballs = (await readdir(inputTarballDirectory))
    .filter((entry) => entry.endsWith(".tgz"))
    .sort()
    .map((entry) => join(inputTarballDirectory, entry));

  if (tarballs.length !== runtimePackages.length) {
    throw new Error(
      `Expected ${runtimePackages.length} bundled runtime tarballs, found ${tarballs.length}.`,
    );
  }

  runNpm(
    [
      "install",
      "--offline",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--no-save",
      ...tarballs,
    ],
    packageDirectory,
    { npmCacheDirectory },
  );
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function comparePackageNames(first, second) {
  return first.name.localeCompare(second.name);
}

function runNpm(argumentsList, cwd, { captureOutput = false, npmCacheDirectory } = {}) {
  const result = spawnSync(process.execPath, [npmCliPath, ...argumentsList], {
    cwd,
    encoding: "utf8",
    env:
      npmCacheDirectory === undefined
        ? process.env
        : { ...process.env, npm_config_cache: npmCacheDirectory, npm_config_offline: "true" },
    stdio: captureOutput ? ["ignore", "pipe", "inherit"] : "inherit",
  });

  if (result.error !== undefined) {
    throw new Error(`Unable to start npm ${argumentsList[0] ?? ""}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `npm ${argumentsList[0] ?? ""} failed with status ${result.status ?? "unknown"}.`,
    );
  }

  return captureOutput ? (result.stdout ?? "") : undefined;
}

await main();
