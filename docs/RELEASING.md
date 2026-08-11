# Releasing

## Status

Researk has a pre-alpha source implementation and local build, standalone-packaging, and smoke-test
scripts. It has no published GitHub Release or supported installer. The repository can build one
self-contained npm tarball and its SPDX SBOM from source, but this capability is not evidence that
a release is available. This document defines the release contract.

The Node.js 24 and npm workspace toolchain can build, type-check, test, lint, and format-check the
source. Signing, checksums, provenance, and release automation are not complete. The standalone
packer locks and validates the runtime dependency closure, including native optional records for
the renderer and keyring, and writes an SPDX SBOM. Until all release controls and platform smoke
tests exist and pass, maintainers MUST NOT publish an official executable release.

No continuous-integration configuration is introduced by this document.

## Versioning

Releases follow Semantic Versioning:

```text
MAJOR.MINOR.PATCH
```

Git tags use the form `vMAJOR.MINOR.PATCH`. Pre-releases use SemVer identifiers such as `v0.1.0-alpha.1`.

Before `v1.0.0`, breaking changes are allowed but MUST be documented. A version number does not weaken the release gates below.

## Authority

Only a maintainer may authorize an official release, create the release tag, and publish the corresponding GitHub Release.

The release must be built from a reviewed commit on the repository's protected default branch. Official artifacts must be produced from that exact commit by the project's release automation, not from a maintainer's unrecorded local workspace.

## Release gates

Before tagging, the release owner verifies that:

- the planned scope is complete and reviewed,
- automated tests and required platform checks pass,
- supported installation and offline startup smoke tests pass,
- the single standalone artifact passes `npm run pack:standalone -- --output <empty-dir>` and
  `npm run smoke:standalone -- --artifact <tarball> --root <empty-dir>` from an unrelated directory,
- security and dependency reviews have no unresolved release-blocking findings,
- user-facing behavior and configuration are documented,
- `CHANGELOG.md` contains the release notes and migration guidance,
- version metadata is consistent,
- dependency locks and required notices are current,
- [ADR 0011](decisions/0011-runtime-dependency-review.md) and
  [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) cover bundled renderer/keyring packages and
  native optional records,
- release artifacts can be generated reproducibly by the release workflow,
- every artifact will receive a checksum, a signature or attestation, an SBOM, and build provenance,
- no secrets, private research material, or development-only files enter an artifact.

A failed gate blocks the release. Maintainers must not replace a failed control with an undocumented manual exception.

## Release process

1. Open a release pull request from a dedicated branch.
2. Move completed entries from `Unreleased` into a dated version section in `CHANGELOG.md`.
3. Update version metadata, documentation, migration notes, and dependency notices.
4. Run the complete release verification defined by the implemented toolchain.
5. Obtain maintainer approval and merge the release pull request.
6. Verify the exact commit on the default branch.
7. Create a signed, annotated tag for the version.
8. Push the tag without moving or replacing any existing release tag.
9. Let release automation build artifacts from the tagged commit.
10. Generate a `SHA256SUMS` manifest, cryptographically sign that manifest, produce artifact signatures or attestations, create an SBOM in a standard machine-readable format, and generate verifiable build provenance.
11. Create a GitHub Release from the signed tag with release notes, compatibility information, migration guidance, and links to security information.
12. Attach only artifacts produced by the release workflow, along with their verification material.
13. Verify every published download against its checksum and perform installation and offline smoke tests on supported platforms.
14. Announce the release only after publication verification succeeds.

Source verification currently uses `npm install`, `npm run build`, `npm run typecheck`, `npm test`,
`npm run lint`, and `npm run format-check`. Release-specific commands and automation entry points
must be documented when they exist. Release documentation MUST describe commands that the
repository implements; it must not rely on guessed or personal tooling.

## Required release artifacts

Once implementation releases begin, each supported platform package must have:

- the distributable artifact,
- `THIRD_PARTY_NOTICES.md` or an equivalent notice bundle carried with the artifact,
- a SHA-256 checksum in the release checksum manifest,
- the signed checksum manifest and a signature or verifiable artifact attestation,
- an SBOM covering bundled dependencies,
- provenance that identifies the source repository, commit, build workflow, and build environment.

Source archives automatically generated by GitHub are supplemental and do not replace verified project artifacts.

## Immutability and corrections

Published tags and artifacts are immutable. Do not force-push a release tag or silently replace an artifact.

If a release is defective:

- stop or mark the release as affected,
- document the issue publicly unless responsible disclosure requires delay,
- publish a new patch or pre-release version,
- provide mitigation or rollback instructions,
- follow the security policy for vulnerabilities.

If an artifact is removed because it is dangerous, retain the release record and explain the removal when it is safe to do so.

## Post-release review

After each release, maintainers should confirm that:

- links and installation instructions work,
- checksums, signatures or attestations, SBOMs, and provenance are downloadable and verifiable,
- the changelog matches the published artifacts,
- new issues are triaged for regressions,
- lessons are recorded for the next release.
