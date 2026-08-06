# ADR 0002: Component boundaries

- **Status:** Accepted
- **Date:** 2026-08-06
- **Decision owner:** Project maintainers
- **Supersedes:** None
- **Superseded by:** None
- **Related docs:** [Architecture](../ARCHITECTURE.md), [Specification](../SPEC.md), [Principles](../PRINCIPLES.md)

## Context

Researk needs reusable orchestration and a terminal client. Research rules must not depend on terminal behavior or provider libraries.

External systems change independently. Direct vendor dependencies would spread network and authentication behavior across the project.

Research workflows can require optional stages and bounded tool loops. A fixed linear function cannot represent all workflows safely.

## Decision

Researk uses this dependency and execution direction:

```text
CLI -> Harness -> execution pipeline -> Research Domain -> provider and tool adapters
```

The CLI owns terminal input, interaction, approval presentation, and output rendering. The CLI contains no research policy.

The Researk Harness owns public contracts, orchestration, cancellation, budgets, approvals, and state coordination. The Harness contains no terminal assumptions.

The execution pipeline is a bounded state machine. A run can omit or repeat stages within declared limits.

The Research Domain owns scientific research, evidence, manuscript, writing, publication, LaTeX, verification, and reproduction rules.

Provider and tool adapters isolate external I/O. Adapters declare capabilities, permissions, and failure behavior.

Components communicate through typed requests, events, results, and errors. Presentation codes never enter Harness content.

## Reasons

- A thin CLI permits direct Harness tests and reuse.
- Typed contracts make streaming, cancellation, and failures observable.
- A bounded pipeline supports tools without unrestricted autonomy.
- Domain isolation keeps scientific rules independent of providers.
- Adapter isolation contains vendor and external-I/O changes.

## Consequences

### Positive

- Tests can replace every external adapter with a deterministic fake.
- Terminal changes cannot alter scientific policy.
- Provider changes remain inside adapter packages.
- Research agents remain bounded workflow configurations.
- Public events can support interactive and machine clients consistently.

### Negative

- The project must maintain more interfaces and data types.
- Cross-component changes can require coordinated schema updates.
- Small features can require code in more than one component.
- Architecture tests add build and maintenance work.

## Rejected alternatives

### Monolithic CLI

This option combines rendering, orchestration, and research policy. It prevents clean reuse and isolated testing.

### Research logic in the Harness

This option makes generic orchestration depend on one domain policy. It weakens the stated component boundary.

### Direct provider calls from workflows

This option bypasses capability negotiation and shared security controls. It also spreads credentials and retries across the Domain.

### Mandatory linear pipeline

This option cannot represent bounded tool loops or conditional verification. It also encourages hidden retry effects.

## Security and privacy effects

Adapters form the external trust boundary. The Harness checks declared permissions before adapter execution.

The CLI neutralizes terminal controls for display. Canonical Harness content remains unchanged.

The pipeline records approvals and external activity. Retries cannot repeat non-idempotent effects without authorization.

## Validation criteria

- Architecture tests enforce the documented dependency direction.
- The Research Domain imports no terminal or vendor client package.
- The CLI imports no Research Domain implementation package directly.
- Fake adapters drive complete runs without network access.
- Harness event fixtures contain no ANSI or OSC sequences added by presentation code.
- Tool-loop tests enforce time, step, and permission budgets.

## Follow-up

- Record the language-specific package map after the toolchain decision.
- Define versioned request and event schemas.
- Add contract tests for each component boundary.
