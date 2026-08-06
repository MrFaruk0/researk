# ADR 0009: npm and GitHub Release distribution

- **Status:** Accepted
- **Date:** 2026-08-06
- **Decision owner:** Project maintainers
- **Supersedes:** None
- **Superseded by:** None
- **Related docs:** [Releasing](../RELEASING.md), [Versioning](../VERSIONING.md),
  [ADR 0008](0008-typescript-node-toolchain.md)

## Context

The first Researk build is a Node.js/npm workspace. Its CLI imports the Harness, contracts,
Research Domain, and provider adapter as separate workspace packages. A single CLI tarball that
references unpublished internal versions is not installable by users.

ADR 0008 requires a later decision before a release may claim installation, checksums, SBOMs, or
provenance. GitHub source archives alone are not an installable CLI distribution and must not be
represented as one.

## Decision

Researk distributes the first downloadable pre-alpha as public, synchronously versioned npm
packages:

- `@researk/contracts`
- `@researk/harness`
- `@researk/provider-openai-compatible`
- `@researk/research`
- `@researk/latex-renderer`
- `@researk/cli`

`@researk/cli` is the only package that exposes the global `researk` command. Its internal
dependencies use the exact release version, so a registry installation can resolve the same
artifact set that passed release verification. The root workspace remains private and is never
published.

A release tag is `vX.Y.Z` or an allowed SemVer prerelease form and must match every public package
version after removing the leading `v`. A release workflow builds only from that tag after the
required clean-install gates pass. It packs every public workspace package, generates a
`SHA256SUMS` manifest, creates SPDX SBOMs from the lockfile for every package, and requests a
GitHub build-provenance attestation for the release artifacts.

The official user installation path, after npm publication succeeds, is:

```text
npm install --global @researk/cli@X.Y.Z
```

GitHub Releases mirror the complete verified npm tarball set, checksums, SBOMs, and attestations.
They do not claim that a lone CLI tarball can resolve unpublished internal dependencies. The
workflow verifies the tarball set by installing all generated tarballs into an empty global prefix
and running `researk` from an unrelated directory.

npm publication uses npm Trusted Publishing with GitHub Actions OIDC. Maintainers must configure
the trusted publisher for each scoped package before a release tag is created. No npm token or
credential is stored in the repository, artifacts, workflows, SBOMs, or logs.

## Consequences

### Positive

- Users receive the expected one-command npm install after the package is actually published.
- GitHub Release assets are traceable to the tagged source commit and independently checkable.
- The clean global-install smoke test verifies the same package boundaries users receive.
- GitHub OIDC can attach provenance without a long-lived repository token.

### Negative

- Maintainers must own the `@researk` npm scope and configure Trusted Publishing for every public
  package.
- The pre-alpha release is JavaScript/npm distribution, not a native binary or installer.
- Publishing multiple packages requires an ordered release workflow.
- GitHub artifact attestation is GitHub-specific; a maintainer-managed detached signature remains a
  future enhancement.

## Rejected alternatives

### Publish only the CLI package with unpublished internal dependencies

This produces an npm tarball that cannot resolve its required Harness packages for users.

### Treat GitHub source archives as installable executables

Source archives lack a verified built command, dependency closure, and installation smoke test.

### Commit an npm token for release automation

This violates the credential and supply-chain constraints in ADR 0003 and ADR 0008.

### Ship a native binary now

The current Node.js toolchain has no approved native launcher or platform support decision.

## Security and privacy effects

Release automation uses `npm ci --ignore-scripts` before it runs project-controlled build commands.
Artifacts are built from a clean tag checkout and are checked for unexpected source changes.
The workflow contains no provider credential and does not invoke live model or research traffic.

The release workflow does not change the local-first scope, add telemetry, or approve a graphical
math rasterizer. The MPL-2.0 `@resvg/resvg-js` binding remains excluded pending a separate review.

## Validation criteria

- CI completes the root build, typecheck, test, lint, format, and whitespace gates on the declared
  operating-system matrix.
- The release workflow packs all public workspaces from a clean tagged checkout.
- The generated tarball set installs into a clean global prefix and runs `researk help` and
  `researk version` from an unrelated directory.
- Every attached release artifact appears in `SHA256SUMS`, has an SPDX SBOM, and has a GitHub
  provenance attestation when GitHub Actions supports it.
- No release is created, tag pushed, or package published merely by adding this workflow.

## Follow-up

- Configure npm Trusted Publishing for the `@researk` scope before the first tag.
- Add detached maintainer signatures if a non-GitHub verification channel becomes required.
- Revisit native installation only with a supported-platform and updater decision.
