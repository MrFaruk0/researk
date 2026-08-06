# Privacy and local data

Researk is pre-alpha. A runnable source build exists, but no installable release exists. This
document describes current behavior and the privacy requirements for planned features.

## Local-first operation

The current CLI and Harness run on the user's machine. They do not collect telemetry. The source
build does not persist configuration, sessions, prompts, model catalogs, or research state.

The CLI currently resolves a provider credential from an environment variable named by the user.
It does not persist or print the credential. The adapter redacts credentials and sensitive HTTP
headers from errors. Operating-system credential storage, persistent sessions, cache, no-history
controls, and local deletion controls are not implemented yet.

Future persistent state must remain local unless the user explicitly sends selected information
through a configured adapter. Credentials must not enter ordinary configuration, session history,
logs, crash output, or `.researk/` project state.

## External providers and research tools

The offline fake provider does not make network requests. The experimental generic
OpenAI-compatible adapter contacts only the base URL that the user supplies. Model discovery can
send a request to that endpoint. Chat sends the prompt and selected request data directly to that
endpoint. Researk does not relay this traffic through a Researk-operated service.

The generic protocol path is not verified native support for any named provider. Each configured
service controls its own retention, training, logging, and privacy terms. Users must evaluate
those terms before sending sensitive work.

Scholarly and general web-research tools are not implemented. When implemented, they must disclose
their destinations, preserve source URLs and retrieval metadata, respect applicable licenses,
access rules, robots directives, and service terms, and avoid collecting more content than the
task requires. Web content is untrusted and must not grant permissions or change provider or tool
choices.

## Scientific writing

The current CLI preserves mathematical LaTeX as source text. It does not use a graphical renderer
or full TeX engine. APA 7 and IEEE processors, CSL integration, manuscript export, and persistent
manuscript state are not implemented.

Future writing workflows may process manuscripts, citations, figures, tables, and review material
locally. Selected content leaves the machine only after the user chooses a network-capable adapter.

## Paper reproduction

The paper-reproduction runner is not implemented. Future reproduction workflows may ingest a
paper, supplements, a source repository, and user-authorized licensed data. These inputs must
remain local unless the user explicitly permits an adapter or isolated run to transmit them.

Downloaded code and data are untrusted. They must never run automatically or directly on the host.
Execution must be an explicit opt-in inside an isolated environment that inherits no provider
keys, host credentials, or unrelated files. Network access must be denied by default. Resource
limits, time limits, mounted paths, and network destinations require explicit permission.

## Public collaboration

GitHub issues, pull requests, commits, and DCO sign-offs are public and retained by GitHub. Do not
submit credentials, unpublished manuscripts, confidential reviews, private research data,
restricted datasets, or unnecessary personal information. Use [SECURITY.md](SECURITY.md) for
suspected vulnerabilities.

Material changes to these requirements must be documented before release.
