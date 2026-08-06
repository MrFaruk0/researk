# ADR 0003: Local data and external I/O

- **Status:** Accepted
- **Date:** 2026-08-06
- **Decision owner:** Project maintainers
- **Supersedes:** None
- **Superseded by:** None
- **Related docs:** [Specification](../SPEC.md), [Architecture](../ARCHITECTURE.md), [Threat model](../THREAT_MODEL.md), [Privacy](../../PRIVACY.md)

## Context

Research work can contain unpublished results, reviewer material, personal data, and licensed sources. Users need predictable storage and network boundaries.

Model providers and internet-research tools require external requests. Local-first operation cannot make those requests local.

Credentials require stronger protection than ordinary configuration and session files.

## Decision

Researk stores configuration, sessions, source records, manuscript state, and run records locally by default. User workspace files remain authoritative.

Researk sends no telemetry by default. Researk has no account service or remote state service.

Each provider or tool adapter declares its destinations and transmitted data categories. Interactive runs show network activity to the user.

Machine events record external activity without recording secrets. The first adapter use discloses its data boundary.

Researk stores credentials in the operating-system credential store. An explicit environment-variable path can support automation.

Ordinary configuration stores credential references only. Sessions, prompts, traces, logs, and reproduction runners contain no provider credentials.

Workspace access uses an explicit root or documented marker. Path resolution must not silently cross that boundary.

## Reasons

- Local state gives users direct control over retention and backup.
- Visible network activity prevents a false offline expectation.
- Adapter declarations make external data movement testable.
- Credential separation limits exposure through files and diagnostics.
- Default-disabled telemetry removes an unrelated data flow.

## Consequences

### Positive

- Users can inspect and delete local Researk state.
- Provider and tool requests have visible ownership.
- Session sharing does not intentionally share credentials.
- The project does not need a Researk account or remote database.

### Negative

- Users must manage local backups and device access.
- Credential-store behavior differs across operating systems.
- External providers retain data under their own policies.
- Offline use depends on cached catalogs and configured local adapters.

## Rejected alternatives

### Plain-text credential configuration

This option simplifies automation. It creates unacceptable repository, backup, and session exposure risks.

### Hidden provider traffic

This option reduces interface noise. It prevents informed decisions about unpublished data.

### Default telemetry

This option provides usage data. It adds an unrelated external boundary and violates the local-first default.

### Managed cloud state

This option simplifies device synchronization. It requires a hosted product and conflicts with ADR 0001.

## Security and privacy effects

Workspace documents, web content, and adapter responses remain untrusted. Logs must redact tokens, authorization headers, and configured sensitive values.

An environment variable can leak to child processes. Researk must not forward the process environment to tools or reproduction runners.

The credential store can fail or be unavailable. Researk must fail safely and explain the supported fallback.

## Validation criteria

- Default integration tests observe no telemetry endpoint request.
- Session, configuration, log, trace, and crash fixtures contain no secret values.
- Every network adapter emits a destination and data-category event.
- First-use tests show the external data disclosure.
- Path traversal and symlink tests cannot escape the workspace silently.
- Reproduction runner tests receive no host credential or environment secret.

## Follow-up

- Select credential-store libraries in the toolchain ADR.
- Define local state paths for each supported operating system.
- Document provider retention links when each adapter becomes supported.
- Add a state inspection and deletion command before a stable release.
