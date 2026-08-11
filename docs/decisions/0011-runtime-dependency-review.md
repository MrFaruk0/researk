# ADR 0011: Review of bundled rendering and secure-credential dependencies

- **Status:** Accepted
- **Date:** 2026-08-11
- **Decision owner:** Project maintainers
- **Supersedes:** Only the `@resvg/resvg-js` pending-review exclusion in ADR 0008 and the corresponding exclusion in ADR 0009
- **Superseded by:** None
- **Related docs:** [CLI rendering contract](../CLI_RENDERING.md), [Architecture](../ARCHITECTURE.md),
  [Threat model](../THREAT_MODEL.md), [Releasing](../RELEASING.md), [Third-party notices](../../THIRD_PARTY_NOTICES.md),
  [ADR 0008](0008-typescript-node-toolchain.md), [ADR 0009](0009-npm-and-github-release-distribution.md),
  [ADR 0010](0010-self-contained-github-cli-artifact.md)

## Context

ADR 0008 recorded a license spike for the Node.js `resvg` binding. ADR 0009 kept that binding
excluded pending a separate review. The current CLI uses the binding for local formula rasterization.
The current TUI also persists provider credentials through a native keyring binding. These native
packages and their platform-specific optional packages must be reviewed before an official artifact
claims to distribute them.

The facts in this record come from the package metadata, package `LICENSE` files, and the committed
lockfile in this repository. The review records distribution controls; it is not legal advice.

## Decision

### `@resvg/resvg-js`

Approve exactly `@resvg/resvg-js@2.6.2` for the bundled local renderer. The package metadata records
license `MPL-2.0` and repository `git@github.com:yisibl/resvg-js.git` (browser-friendly upstream
location: <https://github.com/yisibl/resvg-js>). The package contains the JavaScript wrapper and
declaration files listed by its `files` metadata, including `index.js`, `js-binding.js`,
`index.d.ts`, and `js-binding.d.ts`. Its optional platform packages are lock-pinned at `2.6.2`.
The current lockfile contains 12 resvg platform records: 11 contain a `.node` binary, while
`@resvg/resvg-js-android-arm-eabi@2.6.2` is an upstream metadata-only marker containing only
`README.md` and `package.json`. The marker is staged and represented in the SBOM but is not treated
as a loadable native binary. All records retain their package metadata, resolved URLs, and integrity
values.

The renderer path remains bundled MathJax 4.1.3 -> validated path-only SVG -> resvg raster output.
This decision does not approve system TeX, browser execution, external renderer helpers, or network
access.

The standalone build must preserve the package's MPL-2.0 license and notice information, record the
package and every distributed native companion in the SPDX SBOM, and provide a source location or
other source-availability material appropriate to the executable-form distribution. The release
owner must verify the exact notice and source handling for each artifact before publication.

### `@napi-rs/keyring`

Approve exactly `@napi-rs/keyring@1.3.0` for interactive provider credential storage. The package
metadata records license `MIT` and repository <https://github.com/Brooooooklyn/keyring-node>. The
package supplies the JavaScript keyring API and 12 lock-pinned optional platform packages at
`1.3.0`; those packages supply the platform `.node` bindings. The binding delegates to a
platform-native credential backend. The underlying keyring-rs v1 API documents macOS Keychain
Services, Windows Credential Manager, and *nix Secret Service ([API documentation](https://docs.rs/keyring/latest/keyring/v1/index.html)).
The current Windows build has a synthetic write/read/delete smoke test. macOS and Linux backend
availability remains a release-matrix test requirement.

The standalone build must preserve the MIT copyright and license notice for the main package and
every distributed native companion, and must include those records in the SPDX SBOM. If the native
backend cannot initialize, Researk must fail closed for persistent secrets and may offer only an
explicit environment-variable fallback; this decision does not approve a plaintext credential-file
fallback.

This record does not change the local-first boundary, add telemetry, or put credentials in provider
profiles, session files, prompts, logs, or formula cache entries.

## Reasons

- The selected renderer is required for TeX-quality local raster output without system TeX.
- The selected keyring binding gives interactive provider setup a provider-scoped OS storage seam.
- Exact versions and lockfile integrity make the native dependency closure reviewable.
- A single self-contained artifact remains compatible with ADR 0010 while carrying native optional
  records for supported platforms.

## Consequences

### Positive

- The current formula and credential implementations have an explicit dependency review record.
- Release automation can fail if a native package, binary, license, notice, or SBOM entry is missing.
- Users receive exact-source math and a secure-storage failure path rather than a hidden plaintext
  credential fallback.

### Negative

- Native packages increase artifact size and require platform-specific smoke tests.
- MPL-2.0 source and notice handling must be verified for each executable-form distribution.
- A missing or unavailable OS keyring can prevent persistent interactive credentials.

## Rejected alternatives

### Keep the resvg binding excluded

This would make the approved enhanced renderer unavailable. The exclusion is superseded only after
the dependency facts and distribution controls are recorded here.

### Store interactive credentials in a plaintext file

This would expose provider keys to ordinary file readers and backups. The normal TUI uses the native
keyring and an explicit environment fallback instead.

### Build only a host-specific native artifact

This would conflict with ADR 0010's single self-contained GitHub Release artifact. The packer must
retain the lock-pinned optional matrix and release validation must prove the claimed platform set.

## Security and privacy effects

The renderer receives untrusted formula source but has no shell, filesystem, or network authority.
Rendered pixels and protocol bytes are disposable presentation. The keyring receives only the
provider-scoped account and secret through its narrow API; the secret is not placed in config,
sessions, events, logs, or cache records. Native loader errors are normalized before presentation.

Package metadata, native binaries, license text, and source locations are supply-chain inputs. The
standalone packer must use lockfile URLs and integrity values, disable lifecycle scripts while
staging, validate archive paths and `.node` contents, and require native entries in the SPDX SBOM.

## Validation criteria

- The repository records the exact package metadata, license files, repositories, lockfile
  integrity values, and native optional package matrix.
- Renderer tests pass without system TeX, a browser, helper executables, or network access.
- Windows keyring write/read/delete smoke coverage passes with a synthetic value and removes it.
- Standalone packaging succeeds from an empty output directory, stages native records, and the SPDX
  SBOM contains every bundled native package.
- An offline standalone smoke test installs the single artifact from an unrelated directory.
- Release checks verify the notice bundle, source-availability material, and supported-platform
  native smoke matrix before publication.

## Follow-up

- Run keyring and renderer native smoke tests on every claimed macOS and Linux target.
- Keep [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md) synchronized with lockfile changes.
- Record any future dependency upgrade as a new review with updated package metadata and notices.
