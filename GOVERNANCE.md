# Governance

## Project status

Researk is a pre-alpha, local-first, open-source project. The repository currently defines product and engineering direction; it does not yet provide a supported implementation or release.

This governance model is intentionally lightweight. It is designed to make decisions transparent without creating process that the project cannot yet sustain.

## Principles

Project decisions should:

- advance specialized scientific research and writing workflows,
- preserve a local-first, inspectable harness and CLI,
- protect user data and credentials,
- keep the runtime model- and provider-agnostic,
- favor correctness, maintainability, and testability,
- be documented in public whenever security or privacy does not require confidentiality.

## Roles

### Contributors

Anyone who participates constructively is a contributor. Contributions include code, documentation, design proposals, testing, issue triage, research-domain expertise, and community support.

Contributors must follow the [Code of Conduct](CODE_OF_CONDUCT.md) and certify commits under the [Developer Certificate of Origin](https://developercertificate.org/) using a `Signed-off-by` trailer.

### Maintainers

Maintainers are trusted contributors responsible for the health and direction of the project. They may:

- review and merge changes,
- triage issues and moderate community spaces,
- make release decisions,
- manage repository settings and security reports,
- resolve decisions when consensus cannot be reached,
- appoint or remove maintainers under this document.

Repository ownership and review responsibility are recorded in [`.github/CODEOWNERS`](.github/CODEOWNERS).

Maintainers must act in the project's interests, disclose relevant conflicts of interest, and avoid using private access for personal advantage.

## Decision process

### Routine changes

Bug fixes, documentation corrections, tests, and changes consistent with accepted architecture follow the normal pull-request process. A maintainer may merge them after proportionate review and verification.

The author of a change should not be its only reviewer when another qualified reviewer is reasonably available.

### Significant changes

A significant change requires a public request for comments before implementation. Start a GitHub Discussion or Issue with `[RFC]` in the title and include:

- the problem and affected users,
- goals and explicit non-goals,
- the proposed behavior and architecture,
- security, privacy, compatibility, and maintenance implications,
- alternatives considered,
- migration and testing plans when applicable,
- unresolved questions.

Significant changes include:

- public API, configuration, session-format, or CLI-contract changes,
- new trust boundaries, network behavior, or data collection,
- provider, plugin, tool-permission, or execution-model changes,
- dependency or licensing decisions with broad project impact,
- changes to governance, contribution terms, or release policy.

Maintainers should allow enough time for affected contributors to respond. The appropriate period depends on urgency and impact; no fixed waiting period overrides responsible security handling.

Maintainers seek rough consensus. Consensus does not require unanimity. When consensus is not possible, a maintainer records the decision, material objections, and rationale in the RFC thread. Security-sensitive details may be handled privately and summarized publicly after disclosure is safe.

## Maintainer changes

New maintainers are selected for sustained, constructive contributions, sound judgment, reliability, and alignment with the Code of Conduct. Existing active maintainers approve appointments by consensus.

A maintainer may step down at any time. Maintainer access may also be removed for prolonged inactivity, repeated failure to fulfill the role, a serious Code of Conduct violation, or risk to the project. Except for urgent security or safety cases, the maintainer should receive notice and an opportunity to respond.

Repository access should follow least privilege and be reviewed as the maintainer group changes.

## Releases

Only maintainers may authorize an official release. Release requirements are defined in [`docs/RELEASING.md`](docs/RELEASING.md). Tags and published artifacts are immutable records and must not be silently replaced.

## Licensing and contribution certification

Researk is licensed under Apache License 2.0. Contributions are accepted under the same license unless a file clearly states otherwise.

The project uses the Developer Certificate of Origin rather than a contributor license agreement. Every contributed commit must include a valid `Signed-off-by` trailer. The sign-off certifies that the contributor has the right to submit the work under the project's license; it is not a substitute for authorship or review.

## Changes to governance

Changes to this document use the significant-change process. A governance change is effective only after its pull request is merged by a maintainer and the decision is recorded publicly.

