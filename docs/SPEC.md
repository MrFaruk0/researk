# Product specification

## Status and language

This document specifies intended behavior for a product that has not yet been implemented. It creates no claim that a provider, workflow, command, format, or release currently exists.

The words **MUST**, **MUST NOT**, **SHOULD**, and **MAY** are normative. Requirements apply when the relevant feature is implemented.

## Product definition

Researk MUST be a downloadable, local-first, Apache-2.0 open-source project with exactly two product surfaces:

1. **Researk Harness**: a reusable local library exposing orchestration, request/event contracts, state coordination, Research Domain integration, and adapter interfaces.
2. **`researk` CLI**: an interactive and non-interactive terminal client that uses those public Harness contracts.

The canonical dependency and execution flow is:

```text
CLI -> Harness -> execution pipeline -> Research Domain -> provider/tool adapters
```

Researk MUST NOT require or promise a hosted service, dashboard, Researk account, product authentication, billing, subscription, organization, cloud synchronization, proprietary edition, or separate SDK surface.

## Terms

- A **workspace** is the explicit local root containing user-owned research material.
- A **session** is a versioned local record of requests, events, selections, and references to derived state. It MUST NOT contain provider credentials.
- A **run** is one cancellable Harness execution within or without a persisted session.
- A **research agent** is a bounded policy/workflow, not an unrestricted autonomous process.
- A **publication profile** maps semantic manuscript and citation data to a publication standard.
- **Verification state** records which checks ran, their evidence, results, and limitations.
- **Reproduction** reruns a reported computational procedure under captured conditions. **Replication** is an independent study and MUST NOT be represented as reproduction.

## Scientific research and writing

The planned Research Domain MUST provide composable capabilities for:

- literature discovery and source ingestion;
- evidence, citation, and claim-to-source provenance;
- semantic manuscript state;
- scientific planning, drafting, analysis, and revision;
- reviewer-response workflows;
- publication-profile formatting;
- LaTeX authoring, validation, and export;
- scoped verification; and
- paper reproduction.

Research agents MUST declare their available tools, budgets, stopping conditions, expected outputs, and approval points. Users MUST be able to select a workflow explicitly. If automatic selection is later offered, the chosen workflow MUST be shown and overridable.

## Internet research and sources

Internet research MUST occur only through configured scholarly or web tool adapters. Every network operation MUST be visible while interactive and represented in machine-readable events. Adapters MUST respect applicable access controls, licenses, robots policies where applicable, and service terms; Researk MUST NOT bypass private, paywalled, or licensed access restrictions.

As milestones permit, planned ingestion formats are PDF, HTML, plain text, Markdown, LaTeX, BibTeX, RIS, and DOI metadata. Ingested sources MUST receive stable local IDs and retain available DOI, URL, access date, title, authorship, publication metadata, content hash, and acquisition adapter. Deduplication MUST preserve aliases and provenance rather than erase source identity.

Retrieved content is untrusted. Research tooling MUST distinguish source text from instructions, constrain retrieved content in prompts, and defend against prompt injection. A response that uses sources MUST expose a source list and claim-level or passage-level provenance where the workflow supports claims. A citation MUST NOT be invented. Unsupported or unchecked claims MUST be labelled unverified.

## Manuscripts, citations, and publication profiles

The semantic manuscript model MUST be independent of citation formatting, document style, and export rendering. User files remain authoritative; indexes and structured state are derived, versioned, and rebuildable.

Before replacing an existing manuscript file, the CLI MUST present a diff or equivalent review and require approval. Atomic writes and recoverable backups MUST be used for accepted changes.

Markdown and LaTeX are the initial planned export targets. PDF MAY be added only through a later isolated compiler/export path. Publication formatting SHOULD use a standards-based CSL/citeproc-style adapter. APA 7 and IEEE are the first planned publication profiles and MUST have representative golden tests before either is described as supported. Journal-specific profiles are extensions, not a current promise.

## Paper reproduction

A reproduction workflow MUST be able to ingest a paper, supplements, a referenced code repository, and permitted data as inputs become available. It MUST extract reported claims, methods, experimental conditions, expected metrics, and missing prerequisites into a reviewable plan.

Planning MUST NOT authorize execution. Before running downloaded code, the CLI MUST show the exact repository revision, commands, inputs, mounts, network policy, limits, and expected outputs and obtain explicit user approval.

Downloaded code MUST NOT execute on the host. It MUST run in a disposable isolated runner with:

- no host credentials or inherited secrets;
- allowlisted mounts, read-only by default;
- network denied by default and separately approved when required;
- explicit CPU, memory, wall-time, disk, and process limits; and
- teardown after artifact collection.

The run record MUST capture content hashes, source URLs or DOIs, repository URL and commit, dependency lock or resolved environment, relevant hardware, random seeds, commands, exit status, stdout and stderr, produced artifacts, and observed metrics. Comparisons MUST state reported and observed values, tolerances, uncertainty, and deviations. A reproduction report MUST link conclusions to captured evidence and MUST NOT claim success when execution failed, evidence is missing, or results fall outside the stated comparison. Missing, private, or licensed data MUST be reported transparently.

## Harness request and event behavior

The Harness MUST accept an explicit request and configuration and return a cancellable typed event stream. Events MUST distinguish at least content, progress, source activity, approval requests, warnings, errors, usage when known, and final results. Presentation-specific ANSI sequences MUST NOT appear in Harness content.

Pipeline stages MAY include planning, retrieval, evidence/context assembly, prompt compilation, generation, tool calls, verification, and state update. A run need not execute every stage or follow a rigid single pass. Tool loops and retries MUST have bounded budgets and observable events.

Provider and tool adapters MUST declare capabilities. Model listing or streaming MUST NOT be assumed. A requested unsupported capability MUST produce an actionable error or a documented fallback that does not change the scientific meaning silently.

### Provider, model, and reasoning selection

The Harness MUST maintain a provider registry and stable canonical `provider:model` identities. A run and persisted session MUST record the selected identity, the provider-exposed model revision when available, and effective capability/reasoning settings. The system MUST NOT silently switch models.

Adapters SHOULD discover live model catalogs where supported and cache a sanitized last-known catalog for explicit offline use. Dynamic unknown model IDs MUST remain representable. Catalog data is untrusted and MUST NOT inject terminal controls or executable configuration. Users MUST be able to configure custom OpenAI-compatible endpoints and local runtimes without those endpoints being mistaken for OpenAI itself.

The normalized capability vocabulary MUST cover streaming, tool calls, structured output, vision/file input, context and output limits, and reasoning controls. CLI selection SHOULD support search/filter and show availability plus relevant capabilities. A workflow whose requirements are not met MUST be rejected or clearly downgraded with user approval.

The initial planned adapter set is OpenAI, Anthropic/Claude, Google Gemini, DeepSeek, Alibaba/Qwen, Moonshot/Kimi, OpenRouter, Ollama/local runtimes, and compatible custom endpoints. Gemma is a model family and is available only through a real configured serving provider or local runtime. This list is a plan, not current support or a claim of identical behavior.

Portable reasoning intent is `auto`, `off`, `minimal`, `low`, `medium`, `high`, or `xhigh`. Each adapter advertises accepted intents and maps them to a native effort, budget, toggle, or model choice. Adapters MUST NOT send unsupported fields or imply that levels are equivalent across providers. A validated provider-native override MAY be allowed with diagnostics; requested intent, native override, and effective resolved settings MUST be recorded.

## CLI modes and output

The CLI MUST support:

- an interactive TTY mode;
- a non-interactive one-shot mode suitable for pipes and scripts;
- a no-history mode that performs no session persistence;
- plain/raw output without decoration;
- a machine-readable JSON or JSON Lines mode with a versioned schema; and
- accessible behavior that does not rely on color, animation, or graphics alone.

Exact command names beyond the `researk` executable are intentionally deferred until the CLI contract is implemented and tested.

For non-TTY output, response content MUST go to standard output, diagnostics and progress MUST go to standard error, and neither stream may contain ANSI or terminal control escapes unless the user explicitly requests them. Exit codes MUST be documented and stable within the versioning policy. Cancellation MUST stop further provider/tool activity promptly and leave persisted state valid.

## Markdown and LaTeX presentation

Canonical assistant output is exact UTF-8 source. CLI rendering is a presentation derived from that source and MUST NOT alter saved, copied, piped, raw, or JSON content. Detailed requirements are defined in [CLI_RENDERING.md](CLI_RENDERING.md).

At minimum, the CLI renderer MUST recognize inline `$...$` and `\(...\)` and display `$$...$$` and `\[...\]` outside code spans and fenced blocks. It MUST preserve delimiters and source exactly, including across arbitrary streaming chunk boundaries. It SHOULD use safe terminal capability detection to show mathematical graphics only where supported and MUST fall back to exact source without failure or data loss.

Rendering MUST NOT invoke a system or full TeX engine. Model-generated LaTeX is untrusted. Accessible, raw, and JSON modes MUST remain available. A rendering failure MUST degrade to exact-source display while the run continues; it MUST NOT corrupt output or the session.

LaTeX manuscript authoring/export/verification is a separate Research Domain capability. A future PDF compiler path requires an explicit command, approval, and isolation; it is not terminal visualization.

## State, configuration, credentials, and privacy

Workspace selection MUST be explicit or based on a documented marker and MUST NOT silently expand filesystem access beyond that boundary. Symlinks and external paths require deliberate handling. Writes MUST be disclosed and scoped.

Configuration and session schemas MUST be versioned. Credentials MUST be supplied through environment variables, an operating-system credential store, or another explicitly approved secure backend. They MUST NOT be written to ordinary configuration, sessions, prompts, traces, or logs. Logs MUST redact known secret shapes and sensitive headers.

Local-first does not mean offline: configured provider and research adapters transmit selected content externally. Before first use of an adapter, the CLI MUST disclose its destination and data category. Researk MUST perform no telemetry by default.

## Tool permissions and trust boundaries

Model output, workspace documents, web content, provider responses, downloaded repositories, and tool output MUST be treated as untrusted. Tools MUST declare network, filesystem, process, and credential needs. Default permissions MUST be least privilege, consequential actions MUST require a visible approval, and approvals MUST be scoped to a specific action or clearly bounded run.

Terminal output MUST neutralize unsafe control sequences, including ANSI/OSC injection, without changing canonical stored source. Researk MUST NOT silently execute commands, install dependencies, contact new hosts, or overwrite user files.

## Failure and verification behavior

Failures MUST identify the stage and provide an actionable recovery when possible. Partial output and partial state MUST be marked as such. Verification MUST state which deterministic validators, source checks, model critiques, or human approvals occurred. “Verified” without a named check and evidence is prohibited.

## Pre-alpha acceptance baseline

No feature may be advertised as supported until its roadmap exit criteria pass. The first usable vertical slice MUST demonstrate, with a fake adapter and one documented real provider adapter:

- the same typed Harness events driving interactive, raw, and machine CLI modes;
- safe cancellation, secret redaction, and control-sequence neutralization;
- exact-source Markdown/LaTeX preservation under randomized streaming chunks;
- escape-free non-TTY output and deterministic exit behavior; and
- clean installation and tests on the declared Windows, macOS, and Linux support matrix.
