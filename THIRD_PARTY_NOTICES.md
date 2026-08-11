# Third-party notices

This file records third-party runtime components that need license and source information when
Researk is distributed as an executable-form bundle. Researk itself is Apache-2.0. This notice is a
project record, not legal advice. The exact dependency graph is the committed `package-lock.json`
and the release SBOM.

## `@resvg/resvg-js` 2.6.2

- License recorded in the package metadata and `LICENSE`: Mozilla Public License 2.0 (MPL-2.0).
- Repository recorded in package metadata: `git@github.com:yisibl/resvg-js.git`; browser-friendly
  upstream location: <https://github.com/yisibl/resvg-js>.
- The package supplies JavaScript wrappers (`index.js`, `js-binding.js`, and declarations) for the
  Rust-based native renderer. The current lockfile contains 12 lock-pinned optional resvg platform
  records at version `2.6.2`: 11 contain a `.node` native binary. The exception is
  `@resvg/resvg-js-android-arm-eabi@2.6.2`, which is an upstream metadata-only marker containing
  `README.md` and `package.json`; it is staged and represented in the SBOM but is not treated as a
  loadable native binary. The companion package metadata records MPL-2.0.
- Release artifacts must retain the package license and notice information and provide the source
  location or other source-availability material required for the selected distribution. The
  release owner must verify this for the exact artifact; this file does not make a legal conclusion.

## `@napi-rs/keyring` 1.3.0

- License recorded in the package metadata and `LICENSE`: MIT License.
- Repository recorded in package metadata: <https://github.com/Brooooooklyn/keyring-node>.
- The package supplies the JavaScript keyring API. Its 12 lock-pinned optional platform packages
  supply the corresponding `.node` native bindings, all at version `1.3.0` with MIT metadata.
- The underlying keyring-rs v1 API documents macOS Keychain Services, Windows Credential Manager,
  and *nix Secret Service backends; availability depends on the host session.
- Release artifacts must retain the MIT copyright and license notice for the package and its
  distributed native companions.

## Release handling

The standalone packer verifies lock-pinned native package URLs and integrity values, checks staged
native package identities and binaries (including the documented metadata-only marker), and
requires the native records to appear in the generated SPDX SBOM. A release is blocked until the
artifact contains the notices (or an accompanying notice bundle) and platform smoke tests cover
the native bindings it claims to support. See [ADR 0011](docs/decisions/0011-runtime-dependency-review.md),
[Releasing](docs/RELEASING.md), and [ADR 0010](docs/decisions/0010-self-contained-github-cli-artifact.md).
