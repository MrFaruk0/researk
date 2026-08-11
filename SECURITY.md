# Security policy

Researk has a pre-alpha source implementation but no released versions. Security reports are
welcome for the code, dependencies, repository configuration, and unsafe documentation.

## Supported versions

| Version | Support status |
| --- | --- |
| `main` | Best-effort during pre-alpha development |
| Published releases | None exist yet |

## Report a vulnerability privately

Use [GitHub's private vulnerability reporting form](https://github.com/MrFaruk0/researk/security/advisories/new).
Do not open a public issue or discussion for a suspected vulnerability.

Include, when possible:

- the affected file, component, version, or commit;
- impact and realistic attack conditions;
- minimal reproduction steps or a proof of concept;
- suggested mitigation; and
- whether the report contains sensitive information that needs special handling.

Do not include third-party credentials, private manuscripts, restricted datasets, or unnecessary
personal data. Maintainers will acknowledge and assess reports as capacity permits, coordinate
remediation, and credit reporters who request credit. No response or remediation deadline is
guaranteed during pre-alpha development.

## Current security boundaries

The source build is local-first and has no telemetry. The Harness-level offline fake provider makes
no network requests, but it is not exposed as a CLI mode: `RESEARK_FAKE_PROVIDER` and `fake:paper`
are unsupported by the CLI. The experimental generic OpenAI-compatible adapter sends selected
requests only to the user-supplied base URL. It is not verified native support for any named
provider.

Interactive TUI provider profiles are global local configuration. A key entered through
`/provider` is written to the provider-scoped OS keyring entry provided by `@napi-rs/keyring`;
the provider profile stores only the reference and the explicit environment-variable name. The
persisted key is checked before the environment fallback. Keys are not copied into sessions,
ordinary config, prompts, events, logs, or crash output. One-shot commands may still resolve an
explicit environment variable for their lifetime and do not store it.

If the native keyring is unavailable or locked, Researk does not silently fall back to plaintext
files. Provider setup reports that persistence is unavailable, and the user can use the explicit
environment fallback or restore a working OS keyring. A secure-keyring implementation is not a
protection against a compromised host or account. The underlying keyring-rs v1 API documents
macOS Keychain Services, Windows Credential Manager, and *nix Secret Service; backend availability
depends on the host session. The source smoke test covers Windows, with macOS/Linux coverage a
release-matrix requirement.

Persisted session files are untrusted input. Reads enforce file, message, metadata, and control-
character bounds, validate provider/model/variant identities, and redact known provider secrets
before titles or messages enter the TUI. A malformed, oversized, foreign-workspace, or unavailable
session is ignored or requires reconnection; it cannot authorize a provider or tool action.

Model responses are untrusted input. Terminal output removes or escapes unsafe control sequences.
The renderer selects iTerm2, Kitty, or Sixel only from centralized, positive capability evidence.
The local graphics path is bundled MathJax 4.1.3 -> validated path-only SVG ->
`@resvg/resvg-js` 2.6.2 rasterization. It does not invoke a shell, system TeX, external helper,
filesystem, or network request. Exact original LaTeX is the lossless fallback for unsupported,
uncertain, non-TTY, accessible, raw, JSON, clipped, stale, and failed-render paths. Theme-derived
foreground/background values affect graphics and cache keys; rendered pixels are disposable and
never become session content.

The bundled renderer and keyring native packages are lock-pinned and reviewed in
[ADR 0011](docs/decisions/0011-runtime-dependency-review.md) and
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Official artifacts must retain the recorded
license/notice information and their SPDX SBOM must cover the JS packages and all bundled native
optional records.

Scholarly web tools, general tool execution, and the paper-reproduction runner are not implemented.
Future web pages, papers, supplements, repositories, and datasets must remain untrusted. They must
not authorize tools or execution. Reproduction runs must be isolated and opt-in, inherit no host
secrets, deny network access by default, and receive explicit resource, time, mount, and network
permissions.

See [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) for the full controls and assumptions.

General bugs and feature requests belong in public issues only when the report contains no
sensitive or security-relevant details.
