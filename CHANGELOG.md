# Changelog

All notable changes to Researk will be documented in this file.

The project intends to follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Researk is pre-release; no published release or compatibility guarantee exists yet.

## [0.1.0-alpha.4] - 2026-08-10

### Added

- A full-screen TUI formula browser with keyboard navigation, exact-source reveal, bounded OSC 52
  copy, local draft editing/rerendering, and canonical or edited insertion without mutating
  assistant/session source.
- Retained TUI formula graphics for inline (promoted to a row) and display math through bounded
  Kitty or Windows Terminal Sixel capability detection, plus local provider/configuration/session
  persistence that keeps credentials ephemeral.

### Changed

- Formula images use restricted local MathJax 4 → SVG → resvg at fixed 2× scale with opaque-white
  PNG/RGBA output. Graphics are emitted outside Ink after frame flush; unsupported, inaccessible,
  raw, JSON, non-TTY, clipped, stale, or failed paths show exact source. One-shot iTerm2 display-math
  support remains separate from retained TUI overlays.

### Security

- Rendering remains offline and file/process-free: no system TeX, network, or file execution. No CAS
  simplify/differentiate operations are exposed by the formula overlay.

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
- Replaced planning-only status language with the verified alpha source-build status and
  explicit limits.

### Security

- Added schema validation, exact provider/model selection, output sanitization, error redaction,
  bounded adapter responses, and cancellation tests to the initial execution path.
