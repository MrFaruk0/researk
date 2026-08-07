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

Researk is pre-alpha. A runnable source build provides the Harness, a CLI, a Harness-level offline
fake provider, an experimental generic OpenAI-compatible adapter, and publication-profile metadata.
The fake adapter is not exposed through `RESEARK_FAKE_PROVIDER`, `fake:paper`, or any other CLI fake
mode. Interactive display math can use a bounded local MathJax SVG backend, in-memory resvg
rasterization, and the iTerm2 inline-image protocol only when iTerm2 support is positively detected;
exact source is used everywhere else, and Kitty and Sixel are unsupported. There is no installable
GitHub Release, native packaging, persistent state, CSL processor, scholarly web tooling,
reproduction runner, or verified native provider support yet. The remaining product description is
a target until each capability exists and is tested.
