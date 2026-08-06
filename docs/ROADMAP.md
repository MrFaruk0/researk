# Roadmap

## Status

Researk is pre-alpha. A tested source foundation and first in-process vertical slice exist, but no
installable GitHub Release or native package exists. These are gated outcomes, not promised dates
or compatibility versions. Existing code does not close a milestone until all exit criteria pass
in CI and the behavior is documented. Findings may change later milestones; the project does not
use a “finalize architecture first” waterfall.

## Gate 0 — Public foundation and decisions

**Outcome:** a buildable Apache-2.0 open-source foundation.

Deliverables include the root project documentation and community/security policies; tracked docs; architecture decisions for language/toolchain, package and state layout, supported OS/runtime matrix, credential behavior, isolation technology, and GitHub distribution; dependency policy; test structure; CI; and a fake provider/tool adapter.

Exit criteria:

- a clean checkout builds, lints, tests, and packages on the declared Windows, macOS, and Linux matrix;
- docs contain no implemented-feature claims and pass link/terminology checks;
- secret scanning and dependency/license checks run in CI; and
- a minimal package artifact can be installed and removed in a clean environment.

## Gate 1 — Harness and CLI vertical slice

**Outcome:** one end-to-end local run through the public Harness and CLI.

Deliverables include versioned request/event contracts, cancellation, interactive and one-shot CLI modes, raw/no-history/JSON output, terminal-safe streaming, the fake adapter, and one documented real provider adapter.

Exit criteria:

- the same Harness events drive interactive, raw, and JSON modes;
- non-TTY stdout is escape-free and diagnostics stay on stderr;
- randomized chunk tests preserve exact Markdown/LaTeX source and delimiters;
- ANSI/OSC injection, cancellation, timeout, retry, and secret-redaction tests pass;
- installer/package smoke tests pass on every supported OS; and
- no command, provider, or installation method is advertised before this gate passes.

## Gate 2 — Provider and model registry

**Outcome:** broad, capability-aware model selection without silent substitution.

Deliverables include the provider registry, canonical `provider:model` IDs, live discovery plus cached/offline catalogs, custom OpenAI-compatible endpoints, local-runtime support, capability filtering, and portable reasoning intent. Planned adapters may be added incrementally for OpenAI, Anthropic/Claude, Gemini, DeepSeek, Qwen, Kimi, OpenRouter, and Ollama/local; Gemma is selected through an actual serving adapter.

Exit criteria:

- adapter contract suites with mocks cover discovery, streaming, tools, structured output, vision/files, limits, errors, and reasoning mapping;
- a dynamic unknown-model fixture works without a source-code allowlist;
- untrusted catalog strings are sanitized;
- offline cache freshness/status is visible;
- unsupported workflow requirements fail or downgrade only with approval; and
- run provenance records exact model/revision and resolved reasoning settings with no secrets.

## Gate 3 — Local persistence and workspaces

**Outcome:** safe, resumable local research state.

Deliverables include versioned configuration/session schemas, explicit workspace boundaries, source registry, no-history operation, transactional migrations, atomic writes/backups, credential handles, and a diagnostic/recovery path.

Exit criteria:

- restart/resume and migration fixtures preserve run, source, model, and verification provenance;
- sessions/config/logs contain no credentials;
- symlink, traversal, concurrent-write, corruption, and interrupted-migration tests fail safely; and
- no telemetry occurs and external data movement is disclosed in integration tests.

## Gate 4 — Research and writing pipeline

**Outcome:** a source-backed literature-to-manuscript vertical slice.

Deliverables include bounded research workflows, scholarly/web discovery, staged ingestion of PDF/HTML/text/Markdown/LaTeX and BibTeX/RIS/DOI metadata, evidence/context assembly, semantic manuscript state, planning/writing/analysis/revision, reviewer response, source lists, and claim provenance.

Exit criteria:

- fixture research produces stable source IDs, hashes, DOI/URL/access dates, deduplication aliases, and claim links;
- prompt-injection fixtures cannot grant tools or override workflow policy;
- inaccessible/private/licensed material is reported without bypass;
- unsupported citations and unverified claims are visibly labelled; and
- manuscript overwrites require a diff, approval, atomic write, and recovery copy.

## Gate 5 — Publication profiles and LaTeX authoring

**Outcome:** standards-aware scientific writing with Markdown and LaTeX export.

Deliverables include separation of semantic manuscript, citation/style rendering, and export; a CSL/citeproc-style adapter; initial APA 7 and IEEE profiles; LaTeX authoring and deterministic validation; and terminal visualization conforming to `CLI_RENDERING.md`.

Exit criteria:

- representative APA 7 and IEEE citation, bibliography, heading, and edge-case golden tests pass;
- Markdown and LaTeX round trips retain semantic citations and exact canonical source;
- renderer tests cover supported delimiters, code exclusions, narrow/plain/accessible terminals, graphics fallback, and every stream split;
- terminal rendering never launches TeX; and
- malformed LaTeX yields precise diagnostics without damaging source.

## Gate 6 — Paper reproduction

**Outcome:** a reviewable, provenance-backed reproduction run in disposable isolation.

Deliverables include input/method extraction, plan and approval UI, repository revision pinning, an isolated-runner adapter, resource/network policy, evidence bundles, metric comparison, and reproduction reports.

Exit criteria:

- a public fixture paper/repository/data set reproduces from a pinned commit and locked environment;
- tests prove no host credentials, host execution, unapproved network, writable non-allowlisted mounts, or limit escape;
- records capture hashes, URLs/DOIs, commit, environment, hardware, seeds, commands, stdout/stderr, artifacts, metrics, tolerances, and uncertainty;
- failed, incomplete, missing/private/licensed-data, and out-of-tolerance cases cannot be reported as success; and
- reports distinguish reproduction from independent replication.

## Gate 7 — Verification and tool hardening

**Outcome:** transparent verification and least-privilege extensible tools.

Deliverables include deterministic validators, source-support checks, bounded model critique, verification-state UI/schema, permission manifests, approval scopes, audit records, and failure recovery.

Exit criteria:

- every verification label identifies its check, evidence, and limitation;
- citation existence and claim support are tested separately;
- malicious document/web/tool fixtures cannot exfiltrate secrets or expand permissions;
- retry/idempotence and partial-failure tests preserve correct state; and
- performance budgets are measured without weakening safety or provenance.

## Gate 8 — Release hardening

**Outcome:** a supportable release candidate distributed from GitHub.

Exit criteria:

- the complete functional, migration, security, provider-contract, rendering, reproduction, packaging, and OS matrix passes;
- install, upgrade, downgrade/recovery, and uninstall are tested from release artifacts;
- artifacts are reproducible where practical and published with checksums, provenance, changelog, and migration notes;
- accessibility and terminal capability tests pass on the supported matrix; and
- documentation matches observed behavior from a clean install.

## Gate 9 — 1.0 compatibility commitment

Version 1.0.0 is reached only when the documented Harness API, event schemas, CLI behavior, configuration/session formats, migration policy, security process, and support matrix are stable enough for the compatibility promises in `VERSIONING.md`. It is not a commercial launch and adds no hosted product.
