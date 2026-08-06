# Architecture decision records

This directory contains architecture decision records for Researk.

The records use short sentences and defined terms. The style follows ASD-STE100 principles. The project does not claim certified ASD-STE100 conformance.

## Status values

- **Proposed** means that maintainers are reviewing the decision.
- **Accepted** means that the decision controls current design work.
- **Superseded** means that a later record replaces the decision.
- **Rejected** means that maintainers did not adopt the proposal.

Accepted records remain unchanged. A new record must supersede an accepted decision.

## Decision index

| ADR | Decision | Status | Date |
| --- | --- | --- | --- |
| [0001](0001-open-source-local-first-scope.md) | Open-source local-first scope | Accepted | 2026-08-06 |
| [0002](0002-component-boundaries.md) | Component boundaries | Accepted | 2026-08-06 |
| [0003](0003-local-data-and-external-io.md) | Local data and external I/O | Accepted | 2026-08-06 |
| [0004](0004-provider-model-capability-registry.md) | Provider and model capability registry | Accepted | 2026-08-06 |
| [0005](0005-research-evidence-and-publication-profiles.md) | Research evidence and publication profiles | Accepted | 2026-08-06 |
| [0006](0006-lossless-cli-latex-rendering.md) | Lossless CLI LaTeX rendering | Accepted | 2026-08-06 |
| [0007](0007-isolated-paper-reproduction.md) | Isolated paper reproduction | Accepted | 2026-08-06 |
| [0008](0008-typescript-node-toolchain.md) | TypeScript and Node.js toolchain | Accepted | 2026-08-06 |
| [0009](0009-npm-and-github-release-distribution.md) | npm and GitHub Release distribution | Superseded | 2026-08-06 |
| [0010](0010-self-contained-github-cli-artifact.md) | Self-contained GitHub Release CLI artifact | Accepted | 2026-08-06 |

## Create a record

1. Copy [TEMPLATE.md](TEMPLATE.md).
2. Assign the next four-digit number.
3. Use a lowercase kebab-case filename.
4. Complete every section.
5. Add the record to this index.
6. Link each affected specification or architecture document.

Record facts and trade-offs. Do not use an ADR as a roadmap or implementation log.
