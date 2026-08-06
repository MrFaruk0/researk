import { spawnSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const npmCliPath =
  process.platform === "win32"
    ? join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")
    : resolve(dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js");

async function main() {
  const publishTag = readPublishTag(process.argv.slice(2));
  const packages = await discoverPublicPackages();
  const orderedPackages = sortByWorkspaceDependencies(packages);

  for (const packageRecord of orderedPackages) {
    runNpm([
      "publish",
      "--workspace",
      packageRecord.name,
      "--access",
      "public",
      "--provenance",
      "--tag",
      publishTag,
      "--ignore-scripts",
    ]);
  }
}

function readPublishTag(argumentsList) {
  if (argumentsList.length !== 2 || argumentsList[0] !== "--tag") {
    throw new Error("Usage: node scripts/publish-public-workspaces.mjs --tag <latest|next>");
  }
  const publishTag = argumentsList[1];
  if (publishTag !== "latest" && publishTag !== "next") {
    throw new Error("The npm publish tag must be latest or next.");
  }
  return publishTag;
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
    if (packageJson.publishConfig?.access !== "public") {
      throw new Error(`${packageJson.name} must set publishConfig.access to public.`);
    }
    publicPackages.push({
      dependencies: Object.keys(packageJson.dependencies ?? {}),
      name: packageJson.name,
    });
  }

  return publicPackages;
}

function sortByWorkspaceDependencies(packages) {
  const byName = new Map(packages.map((packageRecord) => [packageRecord.name, packageRecord]));
  const remainingDependencies = new Map(
    packages.map((packageRecord) => [
      packageRecord.name,
      new Set(packageRecord.dependencies.filter((dependency) => byName.has(dependency))),
    ]),
  );
  const orderedPackages = [];

  while (remainingDependencies.size > 0) {
    const readyNames = [...remainingDependencies.entries()]
      .filter(([, dependencies]) => dependencies.size === 0)
      .map(([name]) => name)
      .sort();
    if (readyNames.length === 0) {
      throw new Error("Public workspace dependencies contain a publication cycle.");
    }

    for (const name of readyNames) {
      const packageRecord = byName.get(name);
      if (packageRecord === undefined) {
        throw new Error(`Missing public workspace record for ${name}.`);
      }
      orderedPackages.push(packageRecord);
      remainingDependencies.delete(name);
      for (const dependencies of remainingDependencies.values()) {
        dependencies.delete(name);
      }
    }
  }

  return orderedPackages;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function runNpm(argumentsList) {
  const result = spawnSync(process.execPath, [npmCliPath, ...argumentsList], {
    cwd: repositoryRoot,
    stdio: "inherit",
  });
  if (result.error !== undefined) {
    throw new Error(`Unable to start npm publish: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`npm publish failed with status ${result.status ?? "unknown"}.`);
  }
}

await main();
