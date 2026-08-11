# Privacy and local data

Researk is pre-alpha. A runnable source build exists, but no published installable release exists.
This document describes current behavior and the privacy requirements for planned features.

## Local-first operation

The current CLI and Harness run on the user's machine. They do not collect telemetry. The TUI
persists versioned non-secret configuration, provider profiles, and bounded session files in the
per-user data directory. A formula raster cache is also stored under the per-user cache directory;
it contains disposable rendered pixels and cache digests, not canonical formula source, and may be
deleted at any time. These files are not written into the active research workspace by default.

Interactive provider credentials are stored through the provider-scoped OS keyring backend supplied
by `@napi-rs/keyring`. The provider profile stores only a reference and an explicit environment
variable name. Credential resolution checks the secure entry first and the environment variable
second. If the native keyring is unavailable, Researk does not create a plaintext credential-file
fallback; the user must use the explicit environment option or repair/enable the OS keyring. Keys
are not stored in sessions, ordinary configuration, prompts, transcripts, logs, or cache entries.
One-shot commands may use an environment variable for that invocation and do not persist it. The
underlying keyring-rs v1 API documents macOS Keychain Services, Windows Credential Manager, and
*nix Secret Service; actual availability depends on the host session.

The adapter redacts credentials and sensitive HTTP headers from errors. Session reads treat files as
untrusted: schema, size, metadata, message-count, message-size, and control-character bounds are
checked, and known provider secrets are redacted before restored titles and messages are displayed.
Malformed or foreign-workspace sessions are not hydrated.

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

The current CLI preserves original Markdown and mathematical LaTeX as canonical source text. The
optional terminal view uses bundled MathJax 4.1.3, validated path-only SVG, and in-memory
`@resvg/resvg-js` 2.6.2 rasterization. It never invokes system TeX, reads workspace files, or makes
network requests. Centralized terminal-capability evidence selects Kitty, Sixel, or iTerm2 only
when positively supported. Windows Terminal and other ordinary terminals receive exact source when
graphics are not proven. Theme-aware pixels and terminal protocol bytes are presentation only and
are not persisted in sessions.

APA 7 and IEEE processors, CSL integration, manuscript export, and persistent manuscript state are
not implemented.

Creating `/new` changes only the session ID, conversation, title, and session metadata. The mounted
shell, layout, theme, provider profile, model, variant, credential resolution, and renderer
selection remain global. Resuming a session uses its saved provider/model/variant identities while
resolving the provider credential globally.

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
