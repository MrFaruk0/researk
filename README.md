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
detected iTerm2 TTY; iTerm2 is not used for retained TUI overlays. The full-screen TUI probes before
Ink mounts, then renders assistant inline math (promoted to its own row) and display math through
Kitty only after an explicit bounded query succeeds, or through Sixel only when the `WT_SESSION`
Windows Terminal hint, DA1 parameter 4, and a valid cell-pixel response all prove support. The common local backend is
restricted MathJax 4 → SVG → resvg at fixed 2× scale, producing opaque-white PNG/RGBA data; it does
not execute system TeX, network requests, or files. Unsupported, inaccessible, raw, JSON, non-TTY,
clipped, stale, or failed-render paths preserve exact LaTeX source.

For Kitty images in VS Code, use a recent integrated terminal with
[`terminal.integrated.enableImages`](https://code.visualstudio.com/docs/terminal/advanced#_image-support)
enabled and GPU support (`terminal.integrated.gpuAcceleration` set to `on` or `auto`); the current
[Kitty graphics guidance](https://code.visualstudio.com/updates/v1_110#_kitty-graphics-protocol)
notes that Windows may also need `terminal.integrated.windowsUseConptyDll`. The documented setting
may be required on a given Windows installation; Researk does not promise every VS Code version or
terminal profile. Windows Terminal Sixel is used only when the terminal actually advertises it.

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

Keep the credential in an environment variable. Pass only the variable name to the CLI.

```powershell
$env:PROVIDER_API_KEY = "replace-with-a-real-key"
node packages/cli/dist/bin.js models --provider-id custom --base-url https://example.invalid/v1 --api-key-env PROVIDER_API_KEY
node packages/cli/dist/bin.js chat --provider-id custom --base-url https://example.invalid/v1 --api-key-env PROVIDER_API_KEY --model custom:model-id "Test prompt"
```

The normal TUI persists provider profiles, non-secret configuration, and sessions locally. API keys
remain memory-only and must be supplied through supported environment-variable references; an
operating-system credential backend is not implemented. One-shot commands never store credentials.

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

- an installable GitHub Release or native packaging;
- a persistent model-catalog cache, schema migrations, or operating-system keychain access;
- unrestricted terminal graphics: iTerm2 is one-shot display-math support, while retained TUI
  graphics require the bounded Kitty or Windows Terminal Sixel capability evidence described above;
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

If documentation and executable behavior disagree, treat the discrepancy as a bug.

## Contributing and security

Contributions are welcome under [CONTRIBUTING.md](CONTRIBUTING.md). The project uses Developer
Certificate of Origin sign-offs and does not require a contributor license agreement.

Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md). Do not put private
research data, credentials, unpublished manuscripts, or restricted datasets in an issue.

## License

Licensed under the [Apache License 2.0](LICENSE).
