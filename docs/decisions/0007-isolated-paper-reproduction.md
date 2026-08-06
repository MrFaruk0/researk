# ADR 0007: Isolated paper reproduction

- **Status:** Accepted
- **Date:** 2026-08-06
- **Decision owner:** Project maintainers
- **Supersedes:** None
- **Superseded by:** None
- **Related docs:** [Specification](../SPEC.md), [Architecture](../ARCHITECTURE.md), [Roadmap](../ROADMAP.md), [Threat model](../THREAT_MODEL.md)

## Context

Paper reproduction can require untrusted repositories, dependencies, scripts, and datasets. Direct host execution can expose credentials and user files.

A reproduction result needs more than a successful exit code. The result requires captured conditions, artifacts, metrics, and a comparison.

Some papers depend on missing, private, or licensed data. Researk cannot bypass those restrictions or guarantee reproduction.

Independent replication uses a new study design or data. It is not the same process as reproduction.

## Decision

Paper reproduction is a first-class Research Domain workflow. The workflow separates planning, approval, execution, comparison, and reporting.

The planning phase ingests the paper, supplements, referenced repository, and permitted data. Planning executes no downloaded code.

The plan extracts claims, methods, experimental conditions, dependencies, expected metrics, tolerances, and missing prerequisites.

The CLI shows the repository revision, commands, inputs, mounts, network policy, limits, and expected outputs. Execution requires explicit approval.

Downloaded code runs only in a disposable isolated runner. Downloaded code never runs directly on the host.

The runner receives no host credentials. Mounts use an allowlist and remain read-only by default.

Runner network access is denied by default. Each network exception requires separate approval and a declared destination.

The runner enforces CPU, memory, wall-time, disk, and process limits. The runner is destroyed after artifact collection.

The evidence record captures source hashes, URLs or DOIs, repository commit, dependency lock, environment, hardware, seeds, and commands.

The evidence record also captures exit status, stdout, stderr, artifacts, and observed metrics.

The comparison states reported and observed values, tolerances, uncertainty, and deviations. The report links each conclusion to captured evidence.

Researk never claims successful reproduction without supporting evidence. Reports distinguish reproduction from independent replication.

## Reasons

- Planning gives the user a review point before code execution.
- Disposable isolation limits damage from untrusted code.
- Default-denied networking limits exfiltration and undeclared downloads.
- Resource limits protect host availability.
- Evidence records make the result reviewable and repeatable.
- Explicit terminology prevents a false replication claim.

## Consequences

### Positive

- Users can inspect exact execution conditions and outputs.
- Untrusted code receives no direct host authority.
- Failed and incomplete runs retain useful diagnostic evidence.
- Reports can compare reported and observed metrics transparently.
- Missing or licensed inputs remain visible constraints.

### Negative

- Isolation support differs across operating systems.
- Hardware-specific experiments can remain unavailable.
- Default-denied networking complicates dependency acquisition.
- Evidence bundles can consume substantial disk space.
- Reproduction can still fail because the original paper lacks details.

## Rejected alternatives

### Direct host execution

This option is simple and compatible. It exposes host files, processes, credentials, and network access.

### Automatic execution after ingestion

This option reduces user steps. It removes the required review and approval boundary.

### Network access by default

This option simplifies dependency installation. It permits undeclared downloads and data exfiltration.

### Exit code as success evidence

This option is easy to evaluate. A zero exit code does not prove the reported result.

### Reproduction and replication as synonyms

This option simplifies language. It makes an unsupported scientific claim about study independence.

## Security and privacy effects

Repositories, dependencies, papers, supplements, and datasets are untrusted. The runner must fail closed when isolation controls are unavailable.

The Harness sends only approved inputs into the runner. The runner receives no ambient host environment or credential-store access.

Approved network access remains destination-scoped and recorded. Data licenses and access restrictions remain in the run record.

Artifacts and logs can contain sensitive data. Storage follows workspace permissions and the local retention policy.

## Validation criteria

- A public fixture reproduces from a pinned commit and locked environment.
- Tests prove that downloaded code does not execute on the host.
- Tests prove that host credentials and unapproved paths are unavailable.
- Network tests deny traffic until a destination receives separate approval.
- Limit tests enforce CPU, memory, time, disk, and process constraints.
- Evidence fixtures contain every required input, environment, command, artifact, and metric field.
- Failed and out-of-tolerance fixtures cannot produce a success claim.
- Reports label missing, private, and licensed data accurately.
- Reports use reproduction and replication as separate terms.

## Follow-up

- Select the cross-platform isolation technology in a dedicated implementation ADR.
- Define evidence-bundle and comparison schemas.
- Define artifact retention and deletion controls.
- Publish a fixture corpus with permitted paper, code, and data licenses.
