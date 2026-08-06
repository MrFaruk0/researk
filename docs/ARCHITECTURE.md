# Architecture

## Status

This is the intended architecture for a pre-alpha project. It defines boundaries before implementation; it does not describe existing packages, directories, adapters, or commands. The language, toolchain, package layout, and distribution format require a recorded architecture decision before code is scaffolded.

## System boundary

Researk has two product surfaces and one dependency direction:

```text
User / script
     |
     v
`researk` CLI                 terminal input, approvals, rendering
     |
     v
Researk Harness              public requests/events, orchestration, state
     |
     v
Execution pipeline           bounded stage and tool execution
     |
     v
Research Domain              scientific-research and writing policy
     |
     v
Provider and tool adapters   external model, web, scholarly, storage,
                             export, and isolated-runner I/O
```

There is no hosted control plane. All orchestration occurs in the local process. Adapters may use external services only when configured and disclosed.

## Dependency rules

1. The CLI depends only on the public Harness API and renderer interfaces. It MUST NOT implement research policy.
2. The Harness owns orchestration, request/event contracts, cancellation, budgets, approvals, and state coordination. It MUST NOT depend on terminal behavior.
3. The execution pipeline invokes Research Domain capabilities and adapters through explicit ports. It is a bounded state machine, not a mandatory single-pass chain.
4. The Research Domain owns literature, evidence/citation, manuscript, writing, analysis/revision, verification, publication-profile, LaTeX, and reproduction policy.
5. Adapters isolate external I/O and declare capabilities and permissions. Domain logic MUST NOT import a vendor client directly.
6. Presentation, citation formatting, manuscript semantics, and export are separate concerns.

These rules should be enforced with package boundaries and architecture tests once the toolchain is chosen.

## Harness contracts

The principal Harness operation is a cancellable run:

```text
RunRequest + RunConfiguration
              |
              v
       asynchronous events
              |
              v
RunResult or typed failure
```

The public event envelope has a schema version, run ID, sequence number, event type, timestamp policy, and typed payload. Initial event categories are content deltas, progress, source/network activity, approval requests, warnings, errors, usage when known, and final result. Harness content is canonical UTF-8 and contains no ANSI presentation codes.

Cancellation, timeouts, retry budgets, tool budgets, and approval decisions travel through contracts rather than process-global state. Test adapters and deterministic clocks/random sources must be injectable.

## Execution pipeline

A run may use these stages:

```text
request
  -> plan
  -> retrieve / ingest
  -> assemble evidence and context
  -> compile model input
  -> generate <-> bounded tools
  -> verify
  -> propose state or file changes
  -> emit result
```

Stages are optional and may repeat within explicit limits. A stage records inputs, outputs, provenance, warnings, and verification state. Retries cannot repeat non-idempotent effects without a new approval. Progress is observable, but internal chain-of-thought is never required or stored.

## Research Domain

The Research Domain is a set of capabilities built on Harness contracts.

### Literature and evidence

Scholarly and web adapters will discover or acquire sources. Ingestion will normalize only formats that have reached documented support, planned across PDF, HTML, text, Markdown, LaTeX, BibTeX, RIS, and DOI metadata. A source registry will preserve stable local IDs, content hashes, DOI/URL/access date, bibliographic metadata, adapter origin, aliases, and license/access notes.

Evidence records connect claims or passages to source locations. Deduplication merges identity without deleting provenance. Retrieved text remains untrusted data; prompt construction uses clear trust delimiters and does not treat source instructions as authority. Network events remain user-visible.

### Manuscripts and publication profiles

The semantic manuscript model represents sections, claims, terminology, citations, figures, tables, equations, reviewer comments, and revision relationships independently of a file format. It is derived state; user-owned files are authoritative and changes require review.

Citation/style rendering consumes the semantic model through a standards-based CSL/citeproc-style adapter direction. APA 7 and IEEE are the initial planned profiles. Export adapters initially target Markdown and LaTeX. A future PDF adapter may call only an explicitly approved isolated compiler path.

### Research agents

An agent is configuration for a bounded workflow: policy, allowed Domain capabilities, tool allowlist, budgets, stopping conditions, and approval points. Agents cannot expand their own permissions or access adapters absent from the run configuration.

### Verification

Verification records distinguish deterministic validators, source-backed comparisons, model critique, and human approval. Each result names the check, evidence, and limitation. Citation existence does not establish claim support; style validity does not establish scientific validity.

## Paper reproduction subsystem

Paper reproduction has a planning path and a separately approved execution path:

```text
paper + supplements + repository + permitted data
                       |
                       v
               extraction and plan
                       |
                       v
                  user approval
                       |
                       v
              isolated runner adapter
                       |
                       v
       evidence bundle -> comparison -> report
```

The planner extracts reported claims, methods, experimental conditions, dependencies, expected metrics, tolerances, and unresolved prerequisites. It identifies the exact repository commit and content hashes. A plan is reviewable and cannot trigger execution.

The runner adapter creates a disposable isolation boundary. It receives only allowlisted mounts, read-only by default; no host credentials; a default-denied network policy; and explicit CPU, memory, wall-time, disk, and process limits. Any network exception is separately shown and approved. Downloaded code never executes directly on the host.

The evidence bundle captures source identifiers, repository revision, dependency lock or resolved environment, hardware, seeds, commands, exit status, stdout/stderr, artifacts, and metrics. The comparison layer records reported versus observed results, tolerances, uncertainty, and deviations. The report labels incomplete, blocked, failed, or unsupported cases honestly. Reproduction and independent replication remain distinct concepts.

## State model

State has four categories:

- **configuration**: versioned, non-secret preferences and adapter references;
- **credentials**: handles stored in environment or an approved operating-system credential backend, never session data;
- **workspace content**: authoritative user files inside an explicit boundary; and
- **derived state**: versioned sessions, source registry, evidence graph, manuscript index, run records, and caches that can be rebuilt where possible.

Sessions refer to adapter and model identifiers but not credentials. State writes are atomic. Migrations are transactional, preserve a backup when destructive, and follow `VERSIONING.md`. Symlink and path resolution must not silently escape the workspace.

No component emits telemetry by default. Logs and traces redact authorization headers, tokens, secrets, and configured sensitive fields.

## CLI and rendering

The CLI translates user input into Harness requests and typed events into interactive, plain/raw, accessible, or machine-readable output. Standard output remains data-only in non-TTY mode; diagnostics go to standard error.

Canonical Markdown and LaTeX source belongs to Harness content. The renderer maintains a streaming parse state so delimiters split across chunks are not corrupted. It recognizes math only outside code spans/fences, neutralizes unsafe control sequences for display, detects terminal capabilities conservatively, and uses exact-source fallback. Mathematical graphics are optional presentation and never replace canonical source. A display failure does not fail the research run.

Full terminal requirements live in [CLI_RENDERING.md](CLI_RENDERING.md). Terminal visualization never invokes system TeX. Manuscript LaTeX validation/export is a separate Domain/export path.

## Adapter boundaries

Provider adapters declare authentication method, model discovery, streaming, structured-output, tool-use, usage, cancellation, and retry capabilities. Unsupported behavior is negotiated explicitly.

A provider registry owns adapter discovery and canonical `provider:model` identities. Live model catalogs are normalized, sanitized as untrusted data, and cached with provenance and freshness for offline inspection. The registry preserves dynamic unknown models instead of requiring a hard-coded allowlist. Custom OpenAI-compatible endpoints and local runtimes receive distinct provider identities.

Normalized model capabilities cover streaming, tool calls, structured output, vision/files, context and output limits, and reasoning controls. Selection filters against workflow requirements. Session and run records capture the exact provider/model identity, exposed revision, and effective settings; an adapter cannot silently substitute a model.

Reasoning uses portable intent (`auto`, `off`, `minimal`, `low`, `medium`, `high`, `xhigh`) at the Harness boundary. Each adapter maps only accepted intents to native effort, budget, toggle, or model selection and records the resolution. Unsupported fields are omitted. Validated native overrides remain explicit and diagnostic. Values across providers are not treated as quantitatively equivalent.

Initial planned adapters are OpenAI, Anthropic/Claude, Google Gemini, DeepSeek, Alibaba/Qwen, Moonshot/Kimi, OpenRouter, Ollama/local runtimes, and custom OpenAI-compatible endpoints. Gemma is resolved through a configured serving adapter, not modeled as a provider. No adapter exists merely because it is listed here.

Tool adapters declare network destinations, filesystem access, process execution, credential needs, idempotence, and output schema. The Harness evaluates those declarations against run permissions before invocation. Research adapters also preserve source provenance, access conditions, and acquisition dates.

External output is untrusted. Adapter errors are normalized without discarding vendor details needed for diagnosis, and secrets are removed before events or logs are produced.

## Security boundaries

The principal untrusted inputs are model output, documents, web pages, repositories, datasets, provider/tool responses, and terminal escape sequences. Controls include:

- least-privilege adapter permissions and action-scoped approvals;
- explicit workspace boundaries and review before manuscript overwrite;
- prompt-injection separation for retrieved material;
- no secret persistence in ordinary files or events;
- control-sequence neutralization at the CLI boundary;
- network disclosure and default-denied reproduction networking; and
- disposable isolation and resource limits for downloaded code.

The architecture must fail closed when a required permission or isolation control is unavailable.

## Deferred decisions

The first roadmap gate must record decisions for the implementation language and supported versions, dependency/build tooling, package layout, operating-system matrix, local state locations, credential backend behavior, isolation technology, GitHub release artifact format, and provider conformance strategy. This document must then be updated to describe real packages rather than anticipated directories.
