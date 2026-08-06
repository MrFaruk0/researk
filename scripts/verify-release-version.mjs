import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function main() {
  const tag = readTag(process.argv.slice(2));
  const version = tag.slice(1);
  const rootPackage = await readJson(join(repositoryRoot, "package.json"));
  if (rootPackage.version !== version) {
    throw new Error(`Root package version ${rootPackage.version} does not match tag ${tag}.`);
  }

  const packageDirectory = join(repositoryRoot, "packages");
  const entries = await readdir(packageDirectory, { withFileTypes: true });
  const publicPackages = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const packageJson = await readJson(join(packageDirectory, entry.name, "package.json"));
    if (packageJson.private === true) {
      continue;
    }
    if (typeof packageJson.name !== "string" || !packageJson.name.startsWith("@researk/")) {
      throw new Error(`Public workspace ${entry.name} must use an @researk/* package name.`);
    }
    if (packageJson.version !== version) {
      throw new Error(
        `${packageJson.name} version ${packageJson.version} does not match tag ${tag}.`,
      );
    }
    publicPackages.push(packageJson.name);
  }

  if (!publicPackages.includes("@researk/cli")) {
    throw new Error("The release must include @researk/cli.");
  }

  process.stdout.write(
    `${JSON.stringify({ publicPackages: publicPackages.sort(), tag, version }, null, 2)}\n`,
  );
}

function readTag(argumentsList) {
  if (argumentsList.length !== 2 || argumentsList[0] !== "--tag") {
    throw new Error("Usage: node scripts/verify-release-version.mjs --tag vX.Y.Z[-prerelease]");
  }

  const tag = argumentsList[1];
  if (tag === undefined || !isValidReleaseTag(tag)) {
    throw new Error(`Release tag is not valid SemVer: ${tag ?? ""}`);
  }
  return tag;
}

function isValidReleaseTag(tag) {
  const match =
    /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(
      tag,
    );
  if (match === null) {
    return false;
  }

  return (match[1] ?? "").split(".").every((identifier) => {
    return !/^\d+$/.test(identifier) || /^(0|[1-9]\d*)$/.test(identifier);
  });
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

await main();
