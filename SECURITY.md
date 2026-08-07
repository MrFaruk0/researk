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

The current CLI reads a credential from an explicitly named environment variable. It does not
persist the value. Errors and HTTP metadata are redacted. Operating-system credential storage and
persistent configuration or sessions are not implemented.

Model responses are untrusted input. Terminal output removes or escapes unsafe control sequences.
In a positively detected iTerm2 TTY, display math can pass through the bounded local MathJax SVG
backend, in-memory resvg rasterization, and the trusted iTerm2 inline-image emitter. Exact LaTeX
source is used for inline math and for unsupported, non-TTY, accessible, raw, JSON, or failed-render
paths. Kitty and Sixel are unsupported, and no system TeX execution exists.

Scholarly web tools, general tool execution, and the paper-reproduction runner are not implemented.
Future web pages, papers, supplements, repositories, and datasets must remain untrusted. They must
not authorize tools or execution. Reproduction runs must be isolated and opt-in, inherit no host
secrets, deny network access by default, and receive explicit resource, time, mount, and network
permissions.

See [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) for the full controls and assumptions.

General bugs and feature requests belong in public issues only when the report contains no
sensitive or security-relevant details.
