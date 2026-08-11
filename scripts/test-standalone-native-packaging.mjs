import { spawnSync } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function main() {
  const { artifact, sbom } = readArguments(process.argv.slice(2));
  await access(artifact);
  await access(sbom);

  const lockfile = JSON.parse(await readFile(join(repositoryRoot, "package-lock.json"), "utf8"));
  const expectedNativePackages = discoverNativePackages(lockfile);
  if (expectedNativePackages.length === 0) {
    throw new Error("The production lockfile does not expose any native optional packages.");
  }

  const archiveFiles = listArchiveFiles(artifact);
  const noticeEntry = archiveFiles.find((file) => file === "package/THIRD_PARTY_NOTICES.md");
  if (noticeEntry === undefined) {
    throw new Error("Standalone archive is missing package/THIRD_PARTY_NOTICES.md.");
  }
  const noticeContents = readArchiveEntry(artifact, noticeEntry);
  if (noticeContents.trim().length === 0) {
    throw new Error("Standalone archive contains an empty THIRD_PARTY_NOTICES.md.");
  }
  for (const packageRecord of expectedNativePackages) {
    const packagePrefix = `node_modules/${packageRecord.name}/`;
    const packageFiles = archiveFiles.filter((file) => file.includes(packagePrefix));
    if (!packageFiles.some((file) => file.endsWith(`${packagePrefix}package.json`))) {
      throw new Error(`Standalone artifact is missing ${packageRecord.name}/package.json.`);
    }

    const nativeFiles = packageFiles.filter((file) => file.toLowerCase().endsWith(".node"));
    const metadataOnly = packageFiles.every((file) => {
      const relativePath = file.slice(file.lastIndexOf(packagePrefix) + packagePrefix.length);
      return relativePath === "README.md" || relativePath === "package.json";
    });
    if (nativeFiles.length === 0 && !metadataOnly) {
      throw new Error(
        `Standalone artifact is missing the native binary for ${packageRecord.name}.`,
      );
    }
  }

  const sbomDocument = JSON.parse(await readFile(sbom, "utf8"));
  const sbomPackages = Array.isArray(sbomDocument.packages) ? sbomDocument.packages : [];
  for (const packageRecord of expectedNativePackages) {
    if (
      !sbomPackages.some(
        (entry) =>
          entry !== null &&
          entry.name === packageRecord.name &&
          entry.versionInfo === packageRecord.version,
      )
    ) {
      throw new Error(
        `Standalone SPDX SBOM is missing ${packageRecord.name}@${packageRecord.version}.`,
      );
    }
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        artifact,
        expectedNativePackages: expectedNativePackages.length,
        verifiedNativePackages: expectedNativePackages.map(
          (packageRecord) => `${packageRecord.name}@${packageRecord.version}`,
        ),
        sbom,
      },
      null,
      2,
    )}\n`,
  );
}

function readArguments(argumentsList) {
  const values = new Map();
  for (let index = 0; index < argumentsList.length; index += 2) {
    values.set(argumentsList[index], argumentsList[index + 1]);
  }
  const artifact = values.get("--artifact");
  const requestedSbom = values.get("--sbom");
  if (argumentsList.length !== 2 && argumentsList.length !== 4) {
    throw new Error(
      "Usage: node scripts/test-standalone-native-packaging.mjs --artifact <tgz> [--sbom <json>]",
    );
  }
  if (artifact === undefined || values.size !== (requestedSbom === undefined ? 1 : 2)) {
    throw new Error(
      "Usage: node scripts/test-standalone-native-packaging.mjs --artifact <tgz> [--sbom <json>]",
    );
  }
  return {
    artifact: isAbsolute(artifact) ? artifact : resolve(repositoryRoot, artifact),
    sbom:
      requestedSbom === undefined
        ? join(
            dirname(isAbsolute(artifact) ? artifact : resolve(repositoryRoot, artifact)),
            "researk-standalone.spdx.json",
          )
        : isAbsolute(requestedSbom)
          ? requestedSbom
          : resolve(repositoryRoot, requestedSbom),
  };
}

function discoverNativePackages(lockfile) {
  const lockPackages = lockfile?.packages;
  if (lockPackages === undefined || typeof lockPackages !== "object") {
    throw new Error("package-lock.json must contain a packages map.");
  }

  const queue = [];
  for (const [lockPath, packageJson] of Object.entries(lockPackages)) {
    if (
      lockPath.startsWith("packages/") &&
      packageJson !== null &&
      typeof packageJson === "object"
    ) {
      enqueueDependencies(queue, packageJson);
    }
  }

  const visited = new Set();
  const nativePackages = new Map();
  while (queue.length > 0) {
    const dependency = queue.pop();
    if (dependency === undefined || dependency.name.startsWith("@researk/")) {
      continue;
    }
    const lockPackage = findLockedPackage(lockPackages, dependency.name, dependency.spec);
    if (lockPackage === undefined) {
      if (dependency.optional) {
        continue;
      }
      throw new Error(
        `Production dependency ${dependency.name} is missing from package-lock.json.`,
      );
    }
    if (visited.has(lockPackage.lockPath)) {
      continue;
    }
    visited.add(lockPackage.lockPath);
    if (
      lockPackage.optional === true &&
      (hasNonEmptyArray(lockPackage.os) || hasNonEmptyArray(lockPackage.cpu))
    ) {
      nativePackages.set(lockPackage.name, lockPackage);
    }
    enqueueDependencies(queue, lockPackage);
  }
  return [...nativePackages.values()].sort((first, second) =>
    first.name.localeCompare(second.name),
  );
}

function enqueueDependencies(queue, packageJson) {
  for (const [name, spec] of Object.entries(packageJson.dependencies ?? {})) {
    queue.push({ name, optional: false, spec });
  }
  for (const [name, spec] of Object.entries(packageJson.optionalDependencies ?? {})) {
    queue.push({ name, optional: true, spec });
  }
  for (const [name, spec] of Object.entries(packageJson.peerDependencies ?? {})) {
    queue.push({
      name,
      optional: packageJson.peerDependenciesMeta?.[name]?.optional === true,
      spec,
    });
  }
}

function findLockedPackage(lockPackages, packageName, dependencySpec) {
  const suffix = `node_modules/${packageName}`;
  const candidates = Object.entries(lockPackages)
    .filter(
      ([lockPath, packageJson]) =>
        (lockPath === suffix || lockPath.endsWith(`/${suffix}`)) &&
        packageJson !== null &&
        typeof packageJson === "object" &&
        typeof packageJson.version === "string",
    )
    .map(([lockPath, packageJson]) => ({ lockPath, ...packageJson, name: packageName }));
  if (candidates.length === 0) {
    return undefined;
  }
  const exact = candidates.filter((candidate) => candidate.version === dependencySpec);
  if (exact.length === 1) {
    return exact[0];
  }
  if (candidates.length === 1) {
    return candidates[0];
  }
  throw new Error(`Ambiguous lockfile records for ${packageName}.`);
}

function hasNonEmptyArray(value) {
  return (
    Array.isArray(value) && value.length > 0 && value.every((entry) => typeof entry === "string")
  );
}

function listArchiveFiles(artifact) {
  const result = spawnSync("tar", ["-tf", artifact], {
    encoding: "utf8",
    maxBuffer: 100 * 1024 * 1024,
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(
      `Unable to inspect standalone archive: ${result.error?.message ?? result.stderr}`,
    );
  }
  return (result.stdout ?? "")
    .split(/\r?\n/u)
    .filter((entry) => entry.length > 0)
    .map((entry) => entry.replaceAll("\\", "/"));
}

function readArchiveEntry(artifact, entry) {
  const result = spawnSync("tar", ["-xOf", artifact, entry], {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(
      `Unable to read ${entry} from standalone archive: ${result.error?.message ?? result.stderr}`,
    );
  }
  return result.stdout ?? "";
}

await main();
