# Threat model

## Status and scope

Researk has a pre-alpha source implementation but no published installable release. The current
build has a Harness, CLI, offline fake provider, experimental generic OpenAI-compatible adapter,
capability-aware terminal math rendering, OS-keyring-backed provider credentials, and bounded local
sessions. This document defines security boundaries for those components and for planned internet
research and paper reproduction.

The planned writing layer initially targets APA 7 and IEEE formats and is extensible to additional academic formats. Format templates and imported citation styles are untrusted inputs subject to the same parsing and provenance controls as other documents.

The primary assets are provider credentials, manuscripts and unpublished findings, reviewer material, references, datasets, local session state, source provenance, reproduction artifacts, and the integrity of user-authorized tool actions.

## Trust boundaries

- The local host and user account are trusted to administer Researk. A fully compromised host is outside this model.
- Model responses, web pages, search results, papers, LaTeX, supplements, repositories, datasets, filenames, metadata, and imported session files are untrusted.
- Provider, research, and tool adapters cross an external-network boundary only after explicit configuration and selection.
- A model or retrieved document may propose an action but cannot authorize it.
- Reproduction environments are separate from the host and receive only explicit capabilities.

## Required controls

### Providers, models, and reasoning settings

The generic OpenAI-compatible adapter and offline fake adapter are implemented. The generic
adapter is experimental and is not verified native support for a named provider. Native adapters
for OpenAI, Anthropic/Claude, Google/Gemini or provider-hosted Gemma, DeepSeek, Alibaba/Qwen,
Moonshot/Kimi, OpenRouter, Ollama, and local runtimes are not implemented or tested.

Model catalogs must not be hardcoded as a security authority. Capability discovery validates what a configured endpoint reports and may require network access. Provider, model, and reasoning choices are stored locally and applied per request. Prompts and selected context go only to the provider chosen for that request. Unknown models are enabled only when adapter protocols and discovered capabilities permit safe operation; there is no universal-model compatibility claim.

The interactive TUI stores provider credentials through the provider-scoped OS keyring backend
provided by `@napi-rs/keyring`. A provider profile stores a stable credential reference and the
explicit environment-variable name, never the key. Resolution order is persisted secure entry,
then the explicitly configured environment variable, then missing. Keys must not enter prompts,
session files, ordinary configuration, logs, crash output, formula caches, or reproduction
environments. Errors and HTTP metadata must be redacted. One-shot commands may use an environment
variable for one invocation and do not store it.

When the native keyring cannot be initialized or is unavailable, the interactive persistence path
fails closed for the secret: Researk does not silently use a plaintext file. The user can use the
explicit environment fallback or repair/enable the OS keyring. The keyring is not a boundary
against a compromised host, account, or OS credential store. The underlying keyring-rs v1 API
documents macOS Keychain Services, Windows Credential Manager, and *nix Secret Service; backend
availability depends on the host session and must be tested on every claimed release target.

Provider profiles are global. `/new` replaces session state only; it must not recreate the TUI shell
or discard the provider registry, profile, model, variant, theme, terminal capability evidence, or
renderer selection. A resumed session uses saved provider/model/variant identities and resolves its
credential through the global profile.

### Internet research and citations

Internet access is explicit and adapter-scoped. Adapters must expose their destination, apply time and size limits, use secure transport, and respect applicable licenses, robots directives, access controls, and service terms. Retrieved content retains source URL, retrieval time, and enough provenance to distinguish evidence from generated text.

Web content is data, not instruction. Prompt-injection text cannot change provider selection, expand tool permissions, retrieve credentials, or trigger follow-up actions. Research output must link claims to captured sources, verify citation metadata where practical, and clearly mark missing, conflicting, unsupported, or possibly fabricated references. Citation verification is not a guarantee of truth.

### Tool and filesystem access

Tools use least privilege, explicit capability grants, canonicalized paths, and workspace containment. Symlinks and path traversal must not escape approved roots. State writes are schema-validated, atomic, and user-private. Destructive or externally visible actions require clear confirmation. Untrusted text is never concatenated into a shell command.

Network-capable tools receive destination-scoped permission. Tool results are untrusted on return and do not inherit the tool's permission. Resource, output, recursion, and time limits prevent runaway tasks.

### LaTeX and terminal rendering

Stored output preserves the original Markdown and LaTeX source; rendering is a disposable view. The
local graphics path is restricted bundled MathJax 4.1.3 -> validated path-only SVG ->
`@resvg/resvg-js` 2.6.2 rasterization. It must not invoke a shell, system TeX distribution,
`latex`/`dvipng`, helper executable, file access, or network request. Malformed or unsupported math
falls back to exact source rather than executing, lossy Unicode substitution, or disappearing.

A central capability layer selects Kitty, Sixel, or iTerm2 only from positive protocol evidence.
Terminal brand/process names are not sufficient. Theme semantic foreground/background values are
validated before rendering; transparent output is used where the protocol permits and Sixel output
is composited with the resolved background. Cache keys include source, style, scale, DPI, and
renderer version. The per-user raster cache is bounded, atomic, private where supported, and
recoverable after corruption; it is not session state.

Provider and document output must have unsafe terminal control sequences removed or escaped. Non-
interactive output must contain stable source text without terminal escape codes. Any future full-
document TeX compilation requires a separately approved isolated environment with shell escape
disabled and strict filesystem, process, network, time, memory, and output limits.

### Paper reproduction

A reproduction begins only after the user supplies or approves a paper, supplements, source repository, and appropriately licensed data. Researk first records sources and hashes and produces a plan; it does not execute downloaded material during ingestion or planning.

Execution is opt-in and isolated. It must never run downloaded code directly on the host, inherit host or provider credentials, mount unrelated paths, or receive network access by default. The user explicitly approves CPU, memory, storage, time, writable mounts, read-only inputs, and any destination-scoped network access. The environment records immutable input hashes, commands, exit status, logs, dependency locks, system/runtime details, seeds when available, outputs, and deviations from the paper.

The comparison report separates reproduced observations from reported claims and records missing artifacts, changed dependencies, failed steps, and uncertainty. Isolation reduces risk but does not establish that downloaded code or data is trustworthy.

### Supply chain and releases

Dependencies are minimized, locked, reviewed for provenance and license compatibility, and scanned
before release. The exact `@resvg/resvg-js@2.6.2` MPL-2.0 binding and
`@napi-rs/keyring@1.3.0` MIT binding, including their lock-pinned native optional packages, are
reviewed in [ADR 0011](decisions/0011-runtime-dependency-review.md) and recorded in
[THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md). Test fixtures must be synthetic, public-domain,
or redistributable under documented terms. Release artifacts must be built from a reviewed tag,
retain the required notices, include checksums and an SPDX SBOM covering the full bundled closure,
and use provenance or signatures once the release process exists. Automation receives minimal
repository permissions and pins third-party actions immutably.

## Out of scope and residual risk

This model cannot protect data already exposed by a compromised host, terminal, operating system credential store, user-authorized malicious provider, or deliberately overbroad permission. External services control their own data handling. Scientific, citation, and reproduction checks reduce error but do not replace expert review.

Security-relevant design or implementation changes must update this document. Report suspected vulnerabilities privately through [the security policy](../SECURITY.md).
