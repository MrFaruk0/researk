# Researk

Researk is an open-source, local-first harness and command-line interface for scientific
research and scientific writing.

> **Pre-alpha:** a runnable source build exists. There is no installable GitHub Release or
> native package yet. Interfaces and behavior can change without a compatibility guarantee.

## Available from source

The current vertical slice provides:

- a TypeScript Researk Harness with validated contracts, exact provider/model selection,
  capability checks, cancellation, typed events, and redaction;
- a deterministic offline fake provider;
- an experimental generic OpenAI-compatible adapter with model discovery and JSON or SSE chat;
- a bounded Research Domain with workflow and publication-profile metadata; and
- a `researk` CLI with `help`, `version`, `doctor`, `models`, and `chat`, including raw and JSON
  output and a TTY chat loop.

The CLI preserves mathematical LaTeX as exact source text. It does not yet have a graphical
math backend. The Research Domain can describe LaTeX authoring and export workflows, but it does
not yet provide manuscript export or APA 7 and IEEE citation processors.

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

Smoke-test the built CLI with the offline fake provider.

PowerShell:

```powershell
node packages/cli/dist/bin.js help
$env:RESEARK_FAKE_PROVIDER = "1"
node packages/cli/dist/bin.js models
node packages/cli/dist/bin.js chat --model fake:paper --raw "Summarize the test prompt."
```

POSIX shells:

```bash
node packages/cli/dist/bin.js help
RESEARK_FAKE_PROVIDER=1 node packages/cli/dist/bin.js models
RESEARK_FAKE_PROVIDER=1 node packages/cli/dist/bin.js chat --model fake:paper --raw \
  "Summarize the test prompt."
```

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

The current CLI does not persist credentials. Operating-system credential storage is not
implemented.

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
- persistent configuration, sessions, cache, migrations, or operating-system keychain access;
- a graphical math renderer;
- CSL-backed APA 7 or IEEE processing and manuscript export;
- scholarly or general web-research tools;
- a paper-reproduction runner; or
- verified native provider support.

No telemetry is implemented. Network traffic occurs only when a user selects and configures the
experimental generic adapter. The fake provider stays offline.

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
