import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
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
  const lockfile = await readJson(join(repositoryRoot, "package-lock.json"));
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
    const externalPackages = await discoverExternalRuntimeClosure(workspacePackages, lockfile);
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
    await assertNonEmptyFile(
      join(packageDirectory, "THIRD_PARTY_NOTICES.md"),
      "staged third-party notices",
    );
    await assertStagedNativePackages(packageDirectory, runtimePackages);

    const sbomPath = join(outputDirectory, "researk-standalone.spdx.json");
    const sbom = runNpm(["sbom", "--sbom-format", "spdx", "--omit", "dev"], packageDirectory, {
      captureOutput: true,
      npmCacheDirectory,
    });
    assertSbomNativePackages(sbom, runtimePackages);
    await writeFile(sbomPath, sbom, "utf8");
    const packMetadata = parseNpmJson(
      runNpm(
        ["pack", "--pack-destination", outputDirectory, "--ignore-scripts", "--json"],
        packageDirectory,
        { captureOutput: true, maxBuffer: 100 * 1024 * 1024 },
      ),
      "npm pack",
    );

    const tarballs = (await readdir(outputDirectory)).filter((entry) => entry.endsWith(".tgz"));
    if (tarballs.length !== 1) {
      throw new Error("Expected exactly one standalone CLI tarball.");
    }
    assertArtifactNativePackages(packMetadata, runtimePackages);

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

async function discoverExternalRuntimeClosure(workspacePackages, lockfile) {
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

    const lockPackage = findLockedPackage(lockfile, dependency.name, dependency.spec);
    const directory = await findInstalledPackageDirectory(
      dependency.name,
      dependency.fromDirectory,
    );
    if (directory === undefined) {
      if (dependency.optional && dependency.source === "peer") {
        continue;
      }
      if (lockPackage === undefined && dependency.optional) {
        throw new Error(
          `Optional runtime dependency ${dependency.name} is missing from package-lock.json.`,
        );
      }
      if (dependency.optional && !isNativeOptionalPackage(lockPackage)) {
        continue;
      }
      if (dependency.optional && lockPackage !== undefined) {
        const packageRecord = createLockedPackageRecord(dependency.name, lockPackage);
        addExternalPackage(externalPackages, packageRecord);
        pendingDependencies.push(
          ...runtimeDependencies(packageRecord.packageJson).map((nestedDependency) => ({
            ...nestedDependency,
            fromDirectory: packageRecord.directory ?? repositoryRoot,
          })),
        );
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

    if (lockPackage === undefined) {
      throw new Error(`Runtime dependency ${dependency.name} is missing from package-lock.json.`);
    }
    if (packageJson.version !== lockPackage.version) {
      throw new Error(
        `Installed package ${dependency.name} is ${packageJson.version}, but package-lock.json pins ${lockPackage.version}.`,
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
      lockPackage,
    };
    addExternalPackage(externalPackages, packageRecord);
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
    dependencies.push({ name, optional, spec: packageJson.peerDependencies[name], source: "peer" });
  }

  return dependencies;
}

function findLockedPackage(lockfile, packageName, dependencySpec) {
  const packages = lockfile?.packages;
  if (packages === undefined || typeof packages !== "object") {
    throw new Error("package-lock.json must contain a packages map.");
  }

  const suffix = `node_modules/${assertPackageName(packageName)}`;
  const candidates = Object.entries(packages)
    .filter(([lockPath, packageJson]) => {
      return (
        (lockPath === suffix || lockPath.endsWith(`/${suffix}`)) &&
        packageJson !== null &&
        typeof packageJson === "object" &&
        typeof packageJson.version === "string"
      );
    })
    .map(([lockPath, packageJson]) => ({ lockPath, ...packageJson }));

  if (candidates.length === 0) {
    return undefined;
  }

  const exactVersion = isExactVersion(dependencySpec) ? dependencySpec : undefined;
  const matchingCandidates =
    exactVersion === undefined
      ? candidates
      : candidates.filter((candidate) => candidate.version === exactVersion);
  if (matchingCandidates.length === 1) {
    return { ...matchingCandidates[0], name: packageName };
  }
  if (candidates.length === 1) {
    return { ...candidates[0], name: packageName };
  }

  throw new Error(
    `package-lock.json contains ambiguous runtime records for ${packageName}${dependencySpec === undefined ? "" : ` (${dependencySpec})`}.`,
  );
}

function isExactVersion(value) {
  return (
    typeof value === "string" &&
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value)
  );
}

function isNativeOptionalPackage(packageJson) {
  return (
    packageJson !== undefined &&
    packageJson.optional === true &&
    (hasNonEmptyArray(packageJson.os) || hasNonEmptyArray(packageJson.cpu))
  );
}

function hasNonEmptyArray(value) {
  return (
    Array.isArray(value) && value.length > 0 && value.every((entry) => typeof entry === "string")
  );
}

function assertPackageName(packageName) {
  if (typeof packageName !== "string" || !/^(@[a-z0-9._~-]+\/)?[a-z0-9._~-]+$/i.test(packageName)) {
    throw new Error(`Unsafe package name in runtime dependency graph: ${String(packageName)}.`);
  }
  return packageName;
}

function createLockedPackageRecord(packageName, lockPackage) {
  if (!isNativeOptionalPackage(lockPackage)) {
    throw new Error(`Locked package ${packageName} is not a native optional package.`);
  }
  return {
    directory: undefined,
    lockPackage,
    name: packageName,
    packageJson: {
      name: packageName,
      version: lockPackage.version,
      dependencies: lockPackage.dependencies,
      optionalDependencies: lockPackage.optionalDependencies,
      peerDependencies: lockPackage.peerDependencies,
      peerDependenciesMeta: lockPackage.peerDependenciesMeta,
    },
    version: lockPackage.version,
  };
}

function addExternalPackage(externalPackages, packageRecord) {
  const existing = externalPackages.get(packageRecord.name);
  if (existing !== undefined) {
    if (existing.version !== packageRecord.version) {
      throw new Error(
        `The standalone distribution cannot flatten multiple runtime versions of ${packageRecord.name}: ${existing.version} and ${packageRecord.version}.`,
      );
    }
    return false;
  }
  externalPackages.set(packageRecord.name, packageRecord);
  return true;
}

function addRuntimeDependencies(dependencies, dependencyMap, optional) {
  for (const name of Object.keys(dependencyMap ?? {})) {
    dependencies.push({ name, optional, spec: dependencyMap[name] });
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
    if (isNativeOptionalPackage(packageRecord.lockPackage)) {
      await packLockedNativePackage(packageRecord, inputTarballDirectory);
      continue;
    }

    if (packageRecord.directory === undefined) {
      throw new Error(`Runtime package ${packageRecord.name} has no installed directory.`);
    }
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

async function packLockedNativePackage(packageRecord, inputTarballDirectory) {
  const lockPackage = packageRecord.lockPackage;
  if (
    lockPackage === undefined ||
    typeof lockPackage.resolved !== "string" ||
    typeof lockPackage.integrity !== "string"
  ) {
    throw new Error(
      `Native package ${packageRecord.name}@${packageRecord.version} has no resolved URL and integrity in package-lock.json.`,
    );
  }

  const resolvedUrl = new URL(lockPackage.resolved);
  if (resolvedUrl.protocol !== "https:" || resolvedUrl.username || resolvedUrl.password) {
    throw new Error(`Native package ${packageRecord.name} has an unsafe resolved URL.`);
  }
  if (!/^sha512-[A-Za-z0-9+/]+=*$/.test(lockPackage.integrity)) {
    throw new Error(`Native package ${packageRecord.name} has an unsupported integrity value.`);
  }

  const npmOutput = runNpm(
    [
      "pack",
      lockPackage.resolved,
      "--pack-destination",
      inputTarballDirectory,
      "--ignore-scripts",
      "--json",
    ],
    repositoryRoot,
    { captureOutput: true },
  );
  const metadata = parseNpmJson(npmOutput, `npm pack ${packageRecord.name}`);
  if (metadata.length !== 1 || metadata[0] === undefined) {
    throw new Error(`npm pack returned invalid metadata for ${packageRecord.name}.`);
  }

  const packed = metadata[0];
  if (packed.name !== packageRecord.name || packed.version !== packageRecord.version) {
    throw new Error(
      `Resolved tarball identity mismatch for ${packageRecord.name}: ${packed.name ?? "unknown"}@${packed.version ?? "unknown"}.`,
    );
  }
  if (packed.integrity !== lockPackage.integrity) {
    throw new Error(`Integrity mismatch for resolved native package ${packageRecord.name}.`);
  }
  if (
    typeof packed.filename !== "string" ||
    packed.filename !== basename(packed.filename) ||
    packed.filename.split(/[\\/]+/u).length !== 1 ||
    !isSafeArchivePath(packed.filename)
  ) {
    throw new Error(`npm pack returned an unsafe filename for ${packageRecord.name}.`);
  }
  const tarballPath = join(inputTarballDirectory, packed.filename);
  const actualIntegrity = `sha512-${createHash("sha512")
    .update(await readFile(tarballPath))
    .digest("base64")}`;
  if (actualIntegrity !== lockPackage.integrity) {
    throw new Error(
      `Downloaded native package bytes failed integrity verification: ${packageRecord.name}.`,
    );
  }

  if (!Array.isArray(packed.files) || packed.files.length === 0) {
    throw new Error(`Resolved native package ${packageRecord.name} has no file listing.`);
  }
  for (const file of packed.files) {
    if (file === null || typeof file !== "object" || !isSafeArchivePath(file.path)) {
      throw new Error(
        `Resolved native package ${packageRecord.name} contains an unsafe archive path.`,
      );
    }
  }
  const hasNativeBinary = packed.files.some((file) => file.path.toLowerCase().endsWith(".node"));
  if (!hasNativeBinary && !isMetadataOnlyNativePackage(packed.files)) {
    throw new Error(
      `Resolved native package ${packageRecord.name} does not contain a native .node binary.`,
    );
  }
  // A small number of upstream platform packages are published as an empty
  // metadata-only marker for an unsupported target (currently resvg's Android
  // armeabi package). Keep the lock-pinned marker in the portable closure but
  // do not pretend it provides a loadable native binary.
  packageRecord.hasNativeBinary = hasNativeBinary;
}

function parseNpmJson(output, operation) {
  try {
    const parsed = JSON.parse(output);
    if (!Array.isArray(parsed)) {
      throw new Error("expected an array");
    }
    return parsed;
  } catch (error) {
    throw new Error(
      `Unable to parse ${operation} metadata: ${error instanceof Error ? error.message : String(error)}.`,
    );
  }
}

function isSafeArchivePath(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !value.includes("\0") &&
    !value.startsWith("/") &&
    !value.startsWith("\\") &&
    !value.split(/[\\/]+/u).includes("..")
  );
}

function isMetadataOnlyNativePackage(files) {
  return files.every((file) => file.path === "README.md" || file.path === "package.json");
}

async function writeStandalonePackage(packageDirectory, rootPackage, dependencies) {
  await mkdir(join(packageDirectory, "bin"), { recursive: true });
  const thirdPartyNoticesPath = join(repositoryRoot, "THIRD_PARTY_NOTICES.md");
  await assertNonEmptyFile(thirdPartyNoticesPath, "repository third-party notices");

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
    files: ["bin", "LICENSE", "README.md", "THIRD_PARTY_NOTICES.md"],
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
    '#!/usr/bin/env node\nimport "@researk/cli/bin";\n',
    "utf8",
  );
  await copyFile(join(repositoryRoot, "LICENSE"), join(packageDirectory, "LICENSE"));
  await copyFile(thirdPartyNoticesPath, join(packageDirectory, "THIRD_PARTY_NOTICES.md"));
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
      // The staging install intentionally materializes every lock-pinned native
      // optional package, including packages for other target platforms. The
      // final artifact install remains platform-aware; --force is only needed
      // while assembling the portable bundled-dependency tree.
      "--force",
      "--no-audit",
      "--no-fund",
      "--no-save",
      ...tarballs,
    ],
    packageDirectory,
    { npmCacheDirectory },
  );
}

async function assertStagedNativePackages(packageDirectory, runtimePackages) {
  const nativePackages = runtimePackages.filter((packageRecord) =>
    isNativeOptionalPackage(packageRecord.lockPackage),
  );
  if (nativePackages.length === 0) {
    throw new Error("The standalone runtime closure contains no staged native package records.");
  }

  for (const packageRecord of nativePackages) {
    const packagePath = join(packageDirectory, "node_modules", ...packageRecord.name.split("/"));
    const packageJson = await readJson(join(packagePath, "package.json"));
    if (packageJson.name !== packageRecord.name || packageJson.version !== packageRecord.version) {
      throw new Error(`Staged native package identity mismatch for ${packageRecord.name}.`);
    }
    const entries = await readdir(packagePath, { recursive: true });
    if (
      packageRecord.hasNativeBinary === true &&
      !entries.some((entry) => typeof entry === "string" && entry.toLowerCase().endsWith(".node"))
    ) {
      throw new Error(`Staged native package ${packageRecord.name} has no .node binary.`);
    }
  }
}

async function assertNonEmptyFile(path, description) {
  let contents;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    throw new Error(
      `The ${description} file is unavailable: ${error instanceof Error ? error.message : String(error)}.`,
    );
  }
  if (contents.trim().length === 0) {
    throw new Error(`The ${description} file must not be empty.`);
  }
}

function assertSbomNativePackages(sbom, runtimePackages) {
  const document = parseJson(sbom, "standalone SPDX SBOM");
  const entries = Array.isArray(document.packages) ? document.packages : [];
  const nativePackages = runtimePackages.filter((packageRecord) =>
    isNativeOptionalPackage(packageRecord.lockPackage),
  );
  for (const packageRecord of nativePackages) {
    const entry = entries.find(
      (candidate) =>
        candidate !== null &&
        candidate.name === packageRecord.name &&
        candidate.versionInfo === packageRecord.version,
    );
    if (entry === undefined) {
      throw new Error(
        `Standalone SPDX SBOM does not contain native package ${packageRecord.name}@${packageRecord.version}.`,
      );
    }
  }
}

function assertArtifactNativePackages(packMetadata, runtimePackages) {
  if (
    packMetadata.length !== 1 ||
    packMetadata[0] === undefined ||
    !Array.isArray(packMetadata[0].files)
  ) {
    throw new Error("npm pack returned invalid standalone artifact metadata.");
  }
  const files = packMetadata[0].files;
  if (
    !files.some(
      (file) =>
        file !== null &&
        typeof file === "object" &&
        typeof file.path === "string" &&
        file.path.replaceAll("\\", "/") === "THIRD_PARTY_NOTICES.md",
    )
  ) {
    throw new Error("Standalone artifact metadata does not contain THIRD_PARTY_NOTICES.md.");
  }
  const nativePackages = runtimePackages.filter((packageRecord) =>
    isNativeOptionalPackage(packageRecord.lockPackage),
  );
  for (const packageRecord of nativePackages) {
    const packagePrefix = `node_modules/${packageRecord.name}/`;
    const packageFiles = files.filter(
      (file) =>
        file !== null &&
        typeof file === "object" &&
        typeof file.path === "string" &&
        file.path.replaceAll("\\", "/").startsWith(packagePrefix),
    );
    if (
      !packageFiles.some(
        (file) => file.path.replaceAll("\\", "/") === `${packagePrefix}package.json`,
      )
    ) {
      throw new Error(
        `Standalone artifact does not contain package metadata for ${packageRecord.name}@${packageRecord.version}.`,
      );
    }
    if (
      packageRecord.hasNativeBinary === true &&
      !packageFiles.some((file) => file.path.toLowerCase().endsWith(".node"))
    ) {
      throw new Error(
        `Standalone artifact does not contain native binary for ${packageRecord.name}@${packageRecord.version}.`,
      );
    }
  }
}

function parseJson(value, description) {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(
      `Unable to parse ${description}: ${error instanceof Error ? error.message : String(error)}.`,
    );
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function comparePackageNames(first, second) {
  return first.name.localeCompare(second.name);
}

function runNpm(
  argumentsList,
  cwd,
  { captureOutput = false, maxBuffer = 10 * 1024 * 1024, npmCacheDirectory } = {},
) {
  const result = spawnSync(process.execPath, [npmCliPath, ...argumentsList], {
    cwd,
    encoding: "utf8",
    env:
      npmCacheDirectory === undefined
        ? process.env
        : { ...process.env, npm_config_cache: npmCacheDirectory, npm_config_offline: "true" },
    stdio: captureOutput ? ["ignore", "pipe", "inherit"] : "inherit",
    maxBuffer,
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
