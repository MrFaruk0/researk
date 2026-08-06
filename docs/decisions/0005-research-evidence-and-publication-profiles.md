# ADR 0005: Research evidence and publication profiles

- **Status:** Accepted
- **Date:** 2026-08-06
- **Decision owner:** Project maintainers
- **Supersedes:** None
- **Superseded by:** None
- **Related docs:** [Vision](../VISION.md), [Specification](../SPEC.md), [Architecture](../ARCHITECTURE.md), [Principles](../PRINCIPLES.md)

## Context

Scientific writing requires traceable evidence and correct publication formatting. Fluent text does not prove that a claim has support.

Source discovery uses external scholarly and web systems. Retrieved content can contain errors, restrictions, or malicious instructions.

Citation styles change presentation. They must not change the semantic identity of a source or manuscript claim.

## Decision

Internet research uses explicit scholarly and web tool adapters. Each network operation remains visible to the user.

The source registry assigns a stable local identifier. It retains available DOI, URL, access date, metadata, content hash, and adapter origin.

Deduplication preserves aliases and acquisition provenance. It does not erase a source identity without a reviewable record.

Evidence records connect claims or passages to source locations. Output shows sources and verification state when a workflow uses evidence.

Researk never invents a citation. Researk labels unsupported or unchecked claims as unverified.

Retrieved content is untrusted data. Prompt construction separates source content from Harness and Research Domain instructions.

The semantic manuscript model is independent from citation formatting, publication style, and export rendering. User files remain authoritative.

Publication profiles use a standards-based CSL/citeproc-style adapter direction. APA 7 and IEEE are the first planned profiles.

Markdown and LaTeX are the initial planned export targets. Existing manuscript changes require a diff and explicit approval.

## Reasons

- Stable source identity supports revisions and later verification.
- Claim links make evidence use inspectable.
- Trust separation reduces prompt-injection authority.
- Semantic separation permits multiple publication outputs from one manuscript.
- CSL-style processing avoids hand-built citation strings.
- Golden profiles make APA 7 and IEEE behavior testable.

## Consequences

### Positive

- A researcher can inspect each source and verification limit.
- Citation formatting can change without rewriting source identity.
- Manuscript exports can share one semantic state.
- Publication profiles can add journal rules through defined data.
- Unverified claims remain visible during revision.

### Negative

- Source normalization and deduplication require complex metadata handling.
- Claim-level provenance adds storage and interface work.
- CSL coverage may not represent every journal requirement.
- PDF and HTML extraction can lose layout information.
- Human review remains necessary for scientific support.

## Rejected alternatives

### Model-generated citation strings

This option is flexible. It permits fabricated sources and inconsistent style output.

### Citation style inside manuscript state

This option simplifies one export. It couples scientific meaning to one presentation format.

### Hidden internet research

This option reduces progress output. It conceals external data movement and source acquisition.

### Citation existence as claim verification

This option is easy to automate. An existing paper does not necessarily support a specific claim.

### Silent manuscript overwrite

This option is fast. It can destroy researcher edits and obscure model changes.

## Security and privacy effects

Web pages, papers, metadata, and citations are untrusted. They cannot grant tool permissions or change system instructions.

Adapters respect access controls, licenses, and service terms. Researk does not bypass private, paywalled, or licensed access.

Source records can reveal research interests. They remain local unless a configured workflow transmits them.

File changes use atomic writes and recovery copies. The user approves the displayed change before overwrite.

## Validation criteria

- Fixture research preserves stable IDs, hashes, DOI/URL, access dates, and aliases.
- Claim fixtures retain source locations through save, resume, revision, and export.
- Fabricated and missing citation fixtures never receive a verified label.
- Prompt-injection sources cannot change permissions or Research Domain policy.
- APA 7 and IEEE golden tests cover citations, bibliographies, headings, and edge cases.
- Markdown and LaTeX exports retain semantic citation identity.
- Overwrite tests require a diff, approval, atomic write, and recovery copy.

## Follow-up

- Define the source, evidence, and verification schemas.
- Select a CSL processor after the toolchain decision.
- Publish the supported subset for APA 7 and IEEE.
- Add journal profiles only with fixtures and documented limitations.
