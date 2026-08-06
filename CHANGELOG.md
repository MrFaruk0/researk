# Changelog

All notable changes to Researk will be documented in this file.

The project intends to follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Researk is pre-alpha; no versioned release or compatibility guarantee exists yet.

## [Unreleased]

### Added

- A Node.js 24 TypeScript npm workspace with project references, Vitest, Biome, and a synchronized
  lockfile.
- Validated public contracts for requests, events, models, reasoning, errors, evidence, approvals,
  and permissions.
- The in-process Researk Harness with exact model selection, capability checks, cancellation,
  typed events, redaction, and a deterministic offline fake provider.
- An experimental generic OpenAI-compatible adapter with model discovery and JSON or SSE chat.
- A Research Domain package with bounded workflow and publication-profile metadata.
- A runnable CLI with diagnostics, model listing, chat, raw and JSON modes, a TTY loop, and safe
  exact-source Markdown and LaTeX handling.
- Product, architecture, engineering, security, CLI-rendering, governance, and architecture
  decision documentation.

### Changed

- Published Researk as an Apache-2.0 local-first scientific research harness and CLI.
- Replaced planning-only status language with the verified pre-alpha source-build status and
  explicit limits.

### Security

- Added schema validation, exact provider/model selection, output sanitization, error redaction,
  bounded adapter responses, and cancellation tests to the initial execution path.
