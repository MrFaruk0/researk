# ADR 0010: Self-contained GitHub Release CLI artifact

- **Status:** Accepted
- **Date:** 2026-08-06
- **Decision owner:** Project maintainers
- **Supersedes:** [ADR 0009](0009-npm-and-github-release-distribution.md)
- **Superseded by:** None
- **Related docs:** [Releasing](../RELEASING.md), [Versioning](../VERSIONING.md),
  [ADR 0008](0008-typescript-node-toolchain.md)

## Context

The first Researk build is a Node.js/npm workspace. The CLI imports Harness and other
`@researk/*` packages. A CLI tarball that resolves those packages from npm is not a usable GitHub
Release download before those packages are published.

Users need one downloadable GitHub Release asset that installs the `researk` command without
fetching unpublished Researk packages or transitive runtime packages. The project also needs a
future public npm path for the reusable Harness and package APIs.

## Decision

Each GitHub Release will contain one self-contained npm tarball named `researk` for command-line
installation. The tarball contains the compiled CLI, all public `@researk/*` runtime packages, and
the complete resolved runtime dependency closure as npm bundled dependencies. It does not depend
on a package registry at install time.

The release workflow must build this artifact from a clean tag checkout, install it globally with
an empty npm cache and `--offline`, then run `researk help` and `researk version` from an unrelated
directory. A generated artifact is not documented as an installation command until that exact
path succeeds.

GitHub Release assets also include the standalone artifact's SPDX SBOM, a `SHA256SUMS` manifest,
and GitHub build-provenance attestation. Source archives remain supplemental only.

The public workspace packages remain independently publishable in a future npm release path:

- `@researk/contracts`
- `@researk/harness`
- `@researk/provider-openai-compatible`
- `@researk/provider-openrouter`
- `@researk/research`
- `@researk/latex-renderer`
- `@researk/cli`

They are versioned together and published in dependency order through npm Trusted Publishing with
GitHub Actions OIDC. This npm path never replaces the self-contained GitHub Release acceptance
test. No npm token or provider credential is stored in the repository.

## Consequences

### Positive

- GitHub users can install one verified artifact even before the internal package set is available
  on npm.
- The offline smoke test catches missing bundled dependencies and accidental registry resolution.
- The reusable Harness packages retain a conventional future npm distribution path.
- Artifact checksums, SBOMs, and provenance are attached to the exact downloadable CLI artifact.

### Negative

- The standalone artifact is larger than a thin CLI package because it carries its full runtime
  closure.
- The packer must reject incomplete builds, unresolved runtime dependencies, or conflicting
  flattened runtime versions.
- Release automation has two delivery concerns: the standalone GitHub artifact and future npm
  publication.

## Rejected alternatives

### Publish a thin CLI tarball to GitHub Releases

It would request unpublished `@researk/*` dependencies from npm and fail for ordinary users.

### Use GitHub source archives as the installation method

Source archives do not provide a tested global command, a built dependency closure, or an offline
installation guarantee.

### Delay all GitHub downloads until npm publication

This makes the requested GitHub installation route depend on an external registry and fails the
one-artifact requirement.

### Commit a registry token or provider key

This violates the credential and local-first constraints in ADR 0003 and ADR 0008.

## Security and privacy effects

The packer treats package metadata as build input and verifies the resolved runtime closure before
packing. It runs package installation with lifecycle scripts disabled and a fresh offline npm
cache. The release workflow contains no provider credential, does not invoke a model, and does not
perform research traffic.

The artifact does not add telemetry, a hosted service, system TeX, browser automation, or an
external renderer.

## Validation criteria

- A clean tag checkout passes build, typecheck, test, lint, format, and whitespace gates.
- The standalone tarball contains the public Researk runtime packages and their resolved runtime
  dependency closure.
- An empty-cache `npm install --global --offline` of that one tarball succeeds from an unrelated
  directory and exposes `researk`.
- `SHA256SUMS`, the standalone SPDX SBOM, and GitHub provenance cover the exact attached asset.
- The public workspace npm path is attempted only after all release gates pass and required OIDC
  trusted publishers have been configured.
- Adding the workflow does not create a tag, GitHub Release, or npm publication.

## Follow-up

- Configure npm Trusted Publishing for each public `@researk/*` package before the first npm
  publication.
- Add detached maintainer signatures if verification outside GitHub becomes a requirement.
- Revisit native binaries only with a platform-support and updater decision.
