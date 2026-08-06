# ADR 0004: Provider and model capability registry

- **Status:** Accepted
- **Date:** 2026-08-06
- **Decision owner:** Project maintainers
- **Supersedes:** None
- **Superseded by:** None
- **Related docs:** [Specification](../SPEC.md), [Architecture](../ARCHITECTURE.md), [Roadmap](../ROADMAP.md), [Versioning](../VERSIONING.md)

## Context

Model providers expose different catalogs, features, limits, and reasoning controls. Catalogs can change without a Researk release.

Custom OpenAI-compatible endpoints and local runtimes can expose unknown model identifiers. A static list cannot represent those systems.

Scientific provenance requires the exact provider and model selection. Silent substitution would invalidate that provenance.

## Decision

The Harness contains a provider registry. Each provider adapter registers stable identities, discovery behavior, and normalized capabilities.

A model uses a canonical `provider:model` identity. Custom endpoints and local runtimes keep distinct provider identities.

Adapters use live model discovery when the provider supports discovery. The registry caches a sanitized last-known catalog with freshness metadata.

Offline selection can use the cache with a visible stale or unavailable status. Dynamic unknown models remain representable.

The registry normalizes streaming, tool calls, structured output, vision/files, context limits, output limits, and reasoning controls.

Workflow selection checks required capabilities. Researk rejects an unsupported workflow or requests approval for a clear downgrade.

Researk never switches a provider or model silently. Each session and run records the canonical identity and exposed revision.

Portable reasoning intent is `auto`, `off`, `minimal`, `low`, `medium`, `high`, or `xhigh`. An adapter advertises accepted values.

The adapter maps intent to a provider-native effort, budget, toggle, or model choice. Unsupported fields are not sent.

A validated provider-native override is permitted. Researk displays diagnostics and records requested, native, and effective settings.

## Reasons

- Dynamic discovery follows current provider catalogs.
- Canonical identities make sessions and reports reproducible.
- Capability normalization supports portable workflow requirements.
- Explicit downgrades prevent hidden quality or safety changes.
- Native overrides preserve advanced provider functions without weakening diagnostics.

## Consequences

### Positive

- Users can search and filter models by required capabilities.
- Local and custom endpoints work without a source-code allowlist.
- Offline users can inspect a last-known catalog.
- Run records preserve the effective model and reasoning configuration.
- Adapter differences remain visible instead of receiving false equivalence.

### Negative

- Capability vocabularies require maintenance as providers change.
- Discovery results can be incomplete or incorrect.
- Cached catalogs can become stale.
- Reasoning levels do not provide equal computation across providers.
- Provider conformance tests require many mocks and fixtures.

## Rejected alternatives

### Static model list

This option is simple. It becomes stale and blocks unknown or local models.

### Model identity without provider identity

This option creates collisions and ambiguous provenance. It also hides custom endpoints.

### Silent fallback model

This option can keep a run active. It changes cost, capability, and scientific provenance without consent.

### Provider fields in shared workflow code

This option exposes native features directly. It couples Research Domain policy to provider request formats.

### Equal numerical reasoning levels

This option suggests comparable computation across providers. Providers define effort and budgets differently.

## Security and privacy effects

Model catalog names and metadata are untrusted input. The registry sanitizes catalog data before terminal or log use.

Custom endpoints can receive sensitive prompts. The CLI shows endpoint identity and transmitted data before first use.

Credentials remain in the credential backend. Catalog caches, sessions, diagnostics, and run records contain no credentials.

A native override must pass adapter validation. Unknown request fields must not reach a provider.

## Validation criteria

- Adapter contract tests cover discovery, capabilities, errors, and reasoning maps.
- A dynamic unknown-model fixture completes selection without code changes.
- Offline tests show cache freshness and never imply live availability.
- Catalog injection fixtures cannot emit terminal control sequences.
- Workflow tests reject missing capabilities or record an approved downgrade.
- Run records contain exact provider, model, revision, and effective reasoning settings.
- Substitution tests prove that adapters cannot change models without a new selection.

## Follow-up

- Version the normalized capability vocabulary.
- Define provider conformance fixtures and certification rules.
- Add adapters only after their contract suites pass.
- Document custom endpoint identity and transport requirements.
