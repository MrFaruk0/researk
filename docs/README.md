# Researk documentation

Researk is a local-first open-source research harness and command-line interface. A pre-alpha
source build now provides the Harness, validated contracts, a generic OpenAI-compatible adapter,
an offline fake provider, Research Domain metadata, and a runnable CLI. There is no installable
GitHub Release, native package, or verified native provider support yet. The remaining documents
separate current behavior from intended product requirements.

## Document map

- [VISION.md](VISION.md) explains the mission, audience, product boundary, and intended outcomes.
- [PRINCIPLES.md](PRINCIPLES.md) records the constraints used to make product and engineering decisions.
- [SPEC.md](SPEC.md) is the normative contract for user-visible behavior.
- [ARCHITECTURE.md](ARCHITECTURE.md) defines component responsibilities, dependencies, state, and trust boundaries.
- [CLI_RENDERING.md](CLI_RENDERING.md) defines terminal Markdown and mathematical LaTeX visualization in detail.
- [ROADMAP.md](ROADMAP.md) orders implementation through measurable, gated milestones.
- [VERSIONING.md](VERSIONING.md) defines compatibility, migrations, release channels, and tags.
- [decisions/README.md](decisions/README.md) indexes accepted architecture decision records.

When documents appear to disagree, use this order of authority:

1. `SPEC.md` for user-visible behavior and safety requirements.
2. `ARCHITECTURE.md` for component boundaries and dependency direction.
3. `VERSIONING.md` for compatibility and release rules.
4. `PRINCIPLES.md` for trade-offs not resolved above.
5. `VISION.md` for long-term intent.
6. `ROADMAP.md` for sequence; the roadmap is not a compatibility promise.

## Canonical vocabulary

- **Researk** is the project.
- **Researk Harness** is the reusable local library that owns orchestration, contracts, and state coordination.
- **`researk` CLI** is the terminal client built on the Harness.
- **Research Domain** supplies scientific-research and scientific-writing capabilities.
- **Provider adapters** communicate with language-model services.
- **Tool adapters** perform explicit external operations such as scholarly or web research.
- **Publication profiles** describe citation, bibliography, manuscript, and export requirements. APA 7 and IEEE are the first planned profiles.
- **Provider registry** resolves stable `provider:model` identities and normalizes capabilities and reasoning intent across configured remote or local adapters without hiding their differences.

The terms “Core,” “Research Engine,” “Academic Runtime,” and “platform” are not alternate component names.

## Scope boundary

Researk is exclusively a downloadable Apache-2.0 open-source project. Its product surfaces are the Researk Harness and `researk` CLI. It does not include a hosted service, browser dashboard, account system, billing, subscription, organization management, or cloud synchronization.

“Local-first” means configuration, workspaces, sessions, and derived research state remain on the user’s machine by default. Requests sent through configured model, scholarly, or web adapters leave the machine; the CLI must disclose that network activity. Researk plans no telemetry by default.

Broad verified provider support and paper reproduction are planned core workflows, not current
capabilities. The generic OpenAI-compatible adapter is experimental and unverified. Model choice
must be explicit and provenance-recorded. Downloaded research code may run only after approval in
a disposable isolated runner, never directly on the host.
