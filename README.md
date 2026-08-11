# Researk

Researk is an open-source, local-first harness and command-line interface for scientific
research and scientific writing.

> **0.1.0-alpha.4 source milestone:** a runnable source build exists. There is no published
> GitHub Release or native package yet. Interfaces and behavior can change without a compatibility
> guarantee.

## Available from source

The current vertical slice provides:

- a TypeScript Researk Harness with validated contracts, exact provider/model selection,
  capability checks, cancellation, typed events, and redaction;
- a deterministic offline fake provider for Harness-level tests;
- an experimental generic OpenAI-compatible adapter with model discovery and JSON or SSE chat;
- a bounded Research Domain with workflow and publication-profile metadata; and
- a `researk` CLI with `help`, `version`, `doctor`, `models`, and `chat`, including raw and JSON
  output, a one-shot TTY chat loop, and an argument-less full-screen TUI with local provider,
  configuration, and session persistence.

The CLI has two graphical math paths. One-shot `chat` can render display math in a positively
detected iTerm2 TTY; iTerm2 is not used for retained TUI overlays. The full-screen TUI selects a
renderer from centralized, bounded terminal-capability evidence before Ink mounts. Kitty is used
for any terminal that answers the Kitty Graphics Protocol probe; the selection does not inspect a
terminal brand or process name. Sixel is selected only when the advertised capability and measured
cell pixels prove support. Unsupported, inaccessible, raw, JSON, non-TTY, clipped, stale, or
failed-render paths preserve the exact original LaTeX source.

The local graphics backend is the restricted bundled MathJax 4.1.3 → validated path-only SVG →
`@resvg/resvg-js` 2.6.2 raster pipeline. It produces theme-aware, transparent graphics where the
protocol permits and does not execute system TeX, network requests, or files. This is TeX-quality
math through supported terminal graphics protocols, not native vector or system-TeX rendering.
Windows Terminal remains fully usable with exact-source fallback. WezTerm is a useful Windows
development terminal because it supports Kitty graphics, but it is not required.

For Kitty images in VS Code, use a recent integrated terminal with
[`terminal.integrated.enableImages`](https://code.visualstudio.com/docs/terminal/advanced#_image-support)
enabled and GPU support (`terminal.integrated.gpuAcceleration` set to `on` or `auto`); the current
[Kitty graphics guidance](https://code.visualstudio.com/updates/v1_110#_kitty-graphics-protocol)
notes that Windows may also need `terminal.integrated.windowsUseConptyDll`. The documented setting
may be required on a given Windows installation; Researk does not promise every VS Code version or
terminal profile. Windows Terminal Sixel is used only when the terminal actually advertises it;
an unverified Windows Terminal receives source text instead of a probe or an image.

The TUI `/formula` overlay supports keyboard navigation, exact canonical-source copy through bounded
OSC 52, local draft edit and rerender, source toggling, and insertion of either the edited or original
formula. Assistant and persisted session source remain immutable; no simplify or differentiate (CAS)
operations are claimed. The Research Domain can describe LaTeX authoring and export workflows, but
it does not yet provide manuscript export or APA 7 and IEEE citation processors.

## Build and test

Use Node.js 24 and npm 11. From a source checkout, run:

```bash
npm install
npm run build
npm test
```

The full local verification set is:

```bash
npm run typecheck
npm run lint
npm run format-check
```

Smoke-test CLI commands that do not require a configured provider.

PowerShell:

```powershell
node packages/cli/dist/bin.js help
node packages/cli/dist/bin.js version
node packages/cli/dist/bin.js doctor --json
```

POSIX shells:

```bash
node packages/cli/dist/bin.js help
node packages/cli/dist/bin.js version
node packages/cli/dist/bin.js doctor --json
```

The fake adapter is not a CLI mode: `RESEARK_FAKE_PROVIDER` and `fake:paper` are unsupported.
The `models` and `chat` commands require a configured, reachable OpenAI-compatible provider.

## Experimental OpenAI-compatible endpoint

The generic adapter can connect to a user-selected endpoint that implements a compatible
`/models` and chat-completions protocol. This path is experimental. It is not verified native
support for OpenAI or any other named provider. Protocol differences can cause it to fail.

For one-shot commands, keep the credential in an environment variable and pass only the variable
name to the CLI. The interactive TUI has a separate provider setup flow: a key entered through
`/provider` is stored in the OS keyring under a provider-scoped reference and is not written to a
session or ordinary config file. An explicit environment variable remains an optional fallback.

```powershell
$env:PROVIDER_API_KEY = "replace-with-a-real-key"
node packages/cli/dist/bin.js models --provider-id custom --base-url https://example.invalid/v1 --api-key-env PROVIDER_API_KEY
node packages/cli/dist/bin.js chat --provider-id custom --base-url https://example.invalid/v1 --api-key-env PROVIDER_API_KEY --model custom:model-id "Test prompt"
```

The normal TUI persists provider profiles, non-secret configuration, bounded sessions, and the
disposable formula raster cache in per-user data directories. Provider profiles hold a credential
reference, not a secret. The secure credential backend is provided by `@napi-rs/keyring`; if the
native keyring is unavailable, Researk does not silently create a plaintext credential file and
the user must use the explicit environment fallback or enable a working OS keyring. One-shot
commands never store credentials. Its underlying keyring-rs v1 API documents macOS Keychain
Services, Windows Credential Manager, and *nix Secret Service backends; availability depends on
the host session, and the current source smoke test covers Windows while macOS/Linux remain release
matrix checks.

`/new` replaces only session state: the conversation, session ID, title, and saved session
metadata change, while the mounted shell, layout, theme, provider profile, credential resolution,
model, variant, and renderer selection remain alive. A resumed session uses its saved provider,
model, and variant identities and resolves the credential through the global provider profile.

## Architecture

```text
researk CLI
    |
Researk Harness
    |
execution pipeline
    |
Research Domain
    |
provider and tool adapters
```

The CLI owns terminal input and terminal rendering. The Research Domain owns scientific-research
and writing rules, including future LaTeX authoring and export. Terminal math rendering is a
separate presentation concern and never changes stored source.

## Current limits

The source build does not yet provide:

- an installable GitHub Release or native installer;
- a published release workflow with cross-platform keyring/renderer smoke coverage;
- unrestricted terminal graphics: retained TUI graphics still require the bounded protocol evidence
  described above, and exact source remains the universal fallback;
- CSL-backed APA 7 or IEEE processing and manuscript export;
- scholarly or general web-research tools;
- a paper-reproduction runner; or
- verified native provider support.

No telemetry is implemented. Network traffic occurs only when a user selects and configures the
experimental generic adapter. The Harness-level fake provider stays offline.

## Documentation

- [Vision](docs/VISION.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Specification](docs/SPEC.md)
- [Engineering principles](docs/PRINCIPLES.md)
- [Roadmap](docs/ROADMAP.md)
- [CLI and LaTeX rendering](docs/CLI_RENDERING.md)
- [Threat model](docs/THREAT_MODEL.md)
- [Architecture decisions](docs/decisions/README.md)
- [Third-party notices](THIRD_PARTY_NOTICES.md)

If documentation and executable behavior disagree, treat the discrepancy as a bug.

## Contributing and security

Contributions are welcome under [CONTRIBUTING.md](CONTRIBUTING.md). The project uses Developer
Certificate of Origin sign-offs and does not require a contributor license agreement.

Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md). Do not put private
research data, credentials, unpublished manuscripts, or restricted datasets in an issue.

## License

Licensed under the [Apache License 2.0](LICENSE).
