# Versioning and releases

## Status

Researk has no release yet. This policy applies once release artifacts and public schemas exist. Roadmap gates describe readiness; they do not assign versions automatically.

## Semantic Versioning

Researk uses Semantic Versioning: `MAJOR.MINOR.PATCH`, optionally followed by a prerelease suffix such as `-alpha.1`, `-beta.1`, or `-rc.1`.

- **MAJOR** changes make an incompatible change to a supported public contract.
- **MINOR** changes add backward-compatible public behavior or mark a previously experimental contract stable.
- **PATCH** changes fix behavior without intentionally breaking a supported public contract.

Internal refactoring does not determine the version. User-visible compatibility does.

## Public contracts

Once published, the following are versioned contracts to the extent documented as supported:

- exported Researk Harness API names, types, and behavior;
- request, event, result, approval, source, verification, and error schemas;
- CLI commands, flags, exit codes, non-TTY stdout/stderr separation, raw output, and machine-output schemas;
- configuration, session, source-registry, manuscript-state, and reproduction-record schemas;
- canonical provider/model identities and persisted effective reasoning settings;
- provider/tool adapter interfaces and capability vocabulary when marked stable; and
- documented file/export behavior, including exact Markdown/LaTeX source preservation.

Terminal colors, spacing, interactive animation, diagnostic prose, internal package layout, prompts, private symbols, caches, and experimental features are not stable contracts unless explicitly documented otherwise. Accessibility, safety, provenance, and escape-free output requirements remain contractual even when visual styling does not.

## Pre-1.0 policy

Versions below 1.0.0 are public development releases, not private or commercial previews. For `0.MINOR.PATCH` releases:

- an incompatible public-contract change increments `MINOR`;
- backward-compatible features and fixes normally increment `PATCH` until the next planned minor line;
- every breaking change must be called out in release and migration notes; and
- unstable interfaces must be labelled experimental rather than implied stable.

Pre-1.0 flexibility does not permit silent data loss, credential exposure, undocumented model substitution, or removal of a migration path for persisted user data without an explicit security/data-loss rationale.

Version 1.0.0 means the documented Harness API, CLI contracts, schemas, migrations, security process, and support matrix are ready for an ongoing compatibility commitment. It does not mean a hosted service or commercial launch.

## Schemas and negotiation

Machine-readable envelopes and persisted formats carry their own schema version. Schema versions are not necessarily the package version.

- Readers SHOULD accept all schema versions promised by the release support window.
- Writers emit one documented current schema unless an explicit compatibility option exists.
- Unknown event types and fields are handled according to the schema contract, never guessed.
- Adapter capability negotiation precedes use; branding or model-name pattern matching is not a compatibility mechanism.
- A run records exact canonical `provider:model`, exposed revision if available, requested reasoning intent, provider-native override if any, and effective resolved settings.

## Deprecation and breaking changes

After 1.0.0, a supported public contract should be deprecated in at least one MINOR release before removal in the next MAJOR release. Deprecation notices include the replacement, first deprecated version, and earliest removal version.

An immediate breaking security fix is allowed when retaining behavior would materially endanger users or data. Release notes must explain the impact and recovery without disclosing active secrets.

No release may silently change the selected provider/model, reinterpret a publication profile incompatibly, weaken a tool permission, or alter canonical saved output. Such changes require an explicit migration or opt-in, and may require a MAJOR version after 1.0.

## Data migrations

Configuration, sessions, source/evidence state, manuscripts, and reproduction records require transactional migrations.

Before a destructive transformation, Researk must validate the input and create a recoverable backup. Failure leaves the original usable. Release notes identify automatic and manual steps, downgrade limitations, and recovery commands. Credentials are never copied into migrated ordinary state.

Publication-profile updates that can change rendered citations or manuscripts must identify the underlying ruleset/profile revision and offer a reviewable diff before overwriting user files.

## Release channels and tags

- `vX.Y.Z-alpha.N` is incomplete and may change significantly.
- `vX.Y.Z-beta.N` is feature-complete for its declared scope but still under validation.
- `vX.Y.Z-rc.N` is a release candidate expected to become `vX.Y.Z` if no blocking issue is found.
- `vX.Y.Z` is a stable release within the compatibility policy for its major line.

Git tags and GitHub Release names use the exact `vX.Y.Z...` form and point to the reviewed release commit. The default branch may be unreleased and must identify itself as such.

## Release requirements

Every published release must:

- build, test, and package from a clean checkout on the declared OS/runtime matrix;
- pass functional, provider-contract, schema, migration, security, terminal-rendering, and packaging tests relevant to the change;
- include changelog, compatibility, migration, and known-limitation notes;
- publish supported GitHub artifacts with checksums and build provenance;
- identify dependency and license changes; and
- update documentation in the same change as behavior.

Provider catalogs and availability change independently of Researk releases. A catalog refresh is data, not proof of adapter compatibility; adapter behavior changes follow this policy.

## Support window

A concrete supported-version and security-fix window will be declared before the first stable release. Until then, pre-1.0 releases may support only the latest development line, but migration and data-recovery notes remain required.
