# ADR 0001: Open-source local-first scope

- **Status:** Accepted
- **Date:** 2026-08-06
- **Decision owner:** Project maintainers
- **Supersedes:** None
- **Superseded by:** None
- **Related docs:** [Vision](../VISION.md), [Specification](../SPEC.md), [Roadmap](../ROADMAP.md), [Versioning](../VERSIONING.md)

## Context

Researk began with a closed-source product direction. The current project needs public inspection and local control.

Researchers also need reusable orchestration. A terminal client alone cannot provide an embeddable contract.

Hosted services require accounts, remote state, billing, and operational infrastructure. Those functions do not serve the approved project scope.

## Decision

Researk is an Apache-2.0 open-source project. Users download Researk from the public GitHub repository and its releases.

Researk is local-first. The project stores workspaces, sessions, configuration, and derived state on the user machine by default.

Researk has two product surfaces. The surfaces are the reusable Researk Harness and the `researk` CLI.

Researk does not include a hosted service. It has no dashboard, product account, billing, subscription, organization, or cloud synchronization.

The repository must describe planned and implemented behavior separately. Pre-alpha documents must not imply that an implementation or release exists.

## Reasons

- Apache-2.0 provides clear reuse terms and an explicit patent grant.
- Public source permits security review and research reproducibility.
- Local state keeps the researcher in control of unpublished work.
- A reusable Harness supports the CLI and other local host applications.
- A narrow scope reduces operational and privacy obligations.

## Consequences

### Positive

- Contributors can inspect, test, modify, and redistribute the complete project.
- Researchers can keep project state under local backup and access policies.
- The CLI and Harness can share one public behavior contract.
- Maintainers can focus on research orchestration instead of service operations.

### Negative

- Users must configure external providers or local model runtimes.
- The project cannot rely on a hosted control plane for migrations or recovery.
- Maintainers must support local environments and release artifacts.
- Apache-2.0 notices and dependency licenses require continuous review.

## Rejected alternatives

### Closed-source product

This option prevents public inspection and redistribution. It conflicts with the approved project goal.

### Open-core product

This option separates essential features by license. It creates unclear product and contribution boundaries.

### Hosted-first service

This option requires remote state and product accounts. It conflicts with local-first ownership.

### CLI-only project

This option embeds orchestration in terminal code. It prevents clean reuse and independent Harness tests.

## Security and privacy effects

Local-first storage reduces mandatory disclosure to Researk infrastructure. External adapters can still transmit selected content.

The CLI must identify external data movement. The project must not collect telemetry by default.

Apache-2.0 publication exposes security-sensitive code. The project therefore needs a private vulnerability-reporting process.

## Validation criteria

- The repository contains an Apache-2.0 license.
- Public documents describe only the Harness and CLI as product surfaces.
- Scope searches find hosted-product terms only in explicit exclusions.
- A clean installation requires no Researk account or Researk service.
- Runtime tests detect no default telemetry request.

## Follow-up

- Publish installation instructions only after release artifacts pass tests.
- Maintain contribution, security, privacy, and licensing documents.
- Record any proposed scope change in a superseding ADR.
