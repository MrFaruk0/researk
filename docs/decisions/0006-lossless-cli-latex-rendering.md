# ADR 0006: Lossless CLI LaTeX rendering

- **Status:** Accepted
- **Date:** 2026-08-06
- **Decision owner:** Project maintainers
- **Supersedes:** None
- **Superseded by:** None
- **Related docs:** [CLI rendering contract](../CLI_RENDERING.md), [Specification](../SPEC.md), [Architecture](../ARCHITECTURE.md), [Threat model](../THREAT_MODEL.md)

## Context

Scientific responses contain Markdown and LaTeX mathematics. Terminals do not provide one portable mathematical graphics protocol.

Streaming can split a delimiter or command across arbitrary chunks. Early rendering can corrupt source or show unstable output.

A full TeX engine can read files, write files, start processes, and load packages. Terminal visualization does not need that authority.

## Decision

Canonical assistant output is exact UTF-8 Markdown and LaTeX source. Rendering creates a disposable CLI view of that source.

The CLI recognizes `$...$`, `\(...\)`, `$$...$$`, and `\[...\]` outside code spans and fenced blocks.

The streaming parser retains incomplete constructs until completion. Saved, copied, piped, raw, and JSON output preserve canonical source.

The graphics path uses MathJax 4 with a restricted TeX input configuration. MathJax produces an SVG representation.

The graphics path uses resvg to rasterize SVG when a terminal protocol requires raster data. Rendering never invokes system TeX.

The CLI can display graphics through the Kitty graphics protocol or iTerm inline images. The CLI uses conservative capability detection.

An unsupported terminal receives exact-source output. A parse, MathJax, resvg, or protocol failure also receives exact-source output.

Non-TTY output contains no ANSI, OSC, APC, image protocol, cursor, or progress control sequence. Raw and JSON modes remain available.

Accessible output does not depend on color or graphics. Canonical source remains available next to any optional visual representation.

LaTeX manuscript authoring, validation, and export remain Research Domain functions. Terminal visualization performs no document compilation.

## Reasons

- Exact source is portable, copyable, and suitable for scientific records.
- MathJax supports mathematical TeX without a system TeX installation.
- resvg provides a controlled SVG rasterization path.
- Kitty and iTerm cover common explicit graphics protocols.
- Source fallback supports every terminal and failure case.
- CLI ownership preserves the Harness presentation boundary.

## Consequences

### Positive

- Graphical math can appear on supported terminals.
- Unsupported terminals still show complete mathematical source.
- Canonical source survives every display path.
- The renderer does not need shell or full TeX authority.
- Streaming and non-streaming output can share one parser contract.

### Negative

- MathJax and resvg add dependencies and package size.
- Graphics support differs across terminals and remote sessions.
- Complex unsupported macros fall back to source.
- Buffering can delay display of incomplete mathematics.
- Image output requires strict resource and dimension limits.

## Rejected alternatives

### System TeX execution

This option gives complete TeX behavior. It creates unnecessary file, process, package, and network risks.

### Unicode formula substitution

This option works without graphics. It can change fractions, indices, matrices, accents, and operator meaning.

### Graphics-only output

This option gives a visual result. It fails on unsupported terminals and is not accessible or copyable.

### Source-only interactive output

This option is portable and safe. It does not satisfy the approved graphical rendering goal on capable terminals.

### Rendering inside the Harness

This option centralizes output work. It adds terminal assumptions to the reusable Harness.

## Security and privacy effects

LaTeX and terminal metadata are untrusted input. The renderer disables unsafe MathJax extensions and external resource loading.

The renderer applies input, output, time, memory, image dimension, and cache limits. A limit failure returns exact source.

Terminal capability data does not authorize command execution. Output sanitization blocks control-sequence injection outside the selected graphics protocol.

Rendering performs no network request. It cannot read workspace files through LaTeX commands.

## Validation criteria

- Golden tests cover all supported delimiters and code exclusions.
- Property tests split every fixture at arbitrary streaming boundaries.
- Canonical bytes match across save, raw, JSON, fallback, and graphical paths.
- Kitty and iTerm protocol tests emit only approved control sequences.
- Unsupported-terminal tests emit exact source without graphics.
- Malformed, oversized, and timed-out input falls back without run failure.
- Process monitors prove that rendering does not start system TeX or a shell.
- Non-TTY fixtures contain no terminal control bytes.

## Follow-up

- Pin compatible MathJax 4 and resvg versions after the toolchain ADR.
- Define the restricted MathJax package and macro allowlist.
- Maintain protocol fixtures for supported terminal versions.
- Keep detailed behavior synchronized with `CLI_RENDERING.md`.
