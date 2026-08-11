# Vision

## Mission

Researk exists to make language models more useful for rigorous scientific research and scientific writing without taking ownership of a researcher’s work or data.

It will be an Apache-2.0 open-source project with two surfaces:

- the reusable **Researk Harness**, which applications can configure and embed; and
- the **`researk` CLI**, a local terminal interface built on the same public Harness contracts.

The project will orchestrate existing models, research tools, evidence, manuscript state, publication requirements, and deterministic checks. It will not train or provide a language model.

## Problem

Scientific work is more than conversation. Literature research and manuscript production require persistent project context, traceable sources, structured evidence, citation discipline, revision control, publication formatting, and explicit verification. A model response alone does not provide those guarantees.

Researk aims to provide a transparent harness around supported models so that a researcher can:

- discover and analyze literature through configured scholarly and web tools;
- connect claims to stable source identifiers and visible provenance;
- plan, draft, analyze, and revise scientific manuscripts;
- preserve terminology, evidence, figures, tables, citations, and reviewer context;
- author and validate LaTeX without confusing source generation with terminal math visualization;
- apply extensible publication profiles, beginning with planned APA 7 and IEEE support;
- choose among capability-declared remote and local models without a silent provider/model switch; and
- plan and, only after approval in disposable isolation, run evidence-backed paper reproductions.

Research agents in Researk are bounded workflow policies with declared inputs, tools, budgets, and approval points. They are not unrestricted autonomous processes.

## Product boundary

The canonical execution path is:

```text
`researk` CLI
      |
      v
Researk Harness
      |
      v
Execution pipeline
      |
      v
Research Domain
      |
      v
Provider and tool adapters
```

The Harness owns orchestration, public contracts, and state coordination. The CLI owns terminal interaction and rendering. The Research Domain owns research and writing rules. Adapters isolate all external I/O.

Researk is local-first. User workspaces, sessions, and derived state stay local by default. Configured providers and internet-research tools necessarily transmit selected data to external services; Researk must make those boundaries and network operations visible. No telemetry is planned by default.

## Non-goals

Researk will not provide:

- a hosted product, web dashboard, account system, billing, subscriptions, organizations, or cloud synchronization;
- a proprietary edition or commercial launch milestone;
- unrestricted autonomous agents or silent background research;
- a promise that every model has identical capabilities or quality;
- a substitute for researcher review, peer review, or professional judgment; or
- automatic execution of model-generated LaTeX with a system TeX installation.

## Intended outcomes

Researk succeeds when its released behavior can be demonstrated, not merely claimed. Intended measures include:

- higher task quality than a documented direct-model baseline on published, reproducible research and writing evaluations;
- no fabricated citation presented as verified;
- claim-to-source provenance that survives saving, resuming, revising, and exporting;
- publication-profile output that passes APA 7 and IEEE golden tests for the supported feature set;
- exact preservation of canonical Markdown and LaTeX source across streaming, display, save, and export paths;
- reproduction reports that capture inputs, code revision, environment, commands, artifacts, metrics, uncertainty, and honest failure states; and
- a predictable Harness API and CLI that work safely across supported operating systems.

## Current status

The current source milestone is `0.1.0-alpha.4`. A runnable source build provides the Harness, the
CLI, a Harness-level offline fake provider, an experimental generic OpenAI-compatible adapter,
publication-profile metadata, and an argument-less full-screen TUI with local provider,
configuration, and session persistence. The fake adapter is not exposed through
`RESEARK_FAKE_PROVIDER`, `fake:paper`, or any other CLI fake mode.

The TUI renders assistant inline math (promoted to a row) and display math through a centralized
capability-aware path. Positive Kitty, Sixel, or iTerm2 protocol evidence can select the restricted
local MathJax 4.1.3 -> validated path-only SVG -> `@resvg/resvg-js` 2.6.2 raster backend. Theme
semantic colors affect the graphics and cache key; transparent output is used where practical, and
exact original source remains the lossless fallback. WezTerm is a useful Windows development
terminal, not a requirement. Windows Terminal remains readable without graphics. There is no
system TeX execution, external renderer helper, or hosted rendering service.

Provider profiles persist non-secret endpoint metadata globally, while interactive credentials live
in the provider-scoped OS keyring (keyring-rs documents macOS Keychain Services, Windows Credential
Manager, and *nix Secret Service) and environment variables remain an explicit fallback. `/new`
replaces only session state and preserves the mounted TUI shell, theme, provider, model, variant,
and renderer state. Resumed sessions restore their saved identities and resolve credentials through
the global profile. There is no published GitHub Release or native installer, persistent
model-catalog cache, CSL processor, scholarly web tooling, reproduction runner, or verified native
provider support yet. The remaining product description is a target until each capability exists
and is tested.
