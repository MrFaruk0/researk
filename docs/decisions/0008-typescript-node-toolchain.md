# ADR 0008: TypeScript and Node.js toolchain

- **Status:** Accepted
- **Date:** 2026-08-06
- **Decision owner:** Project maintainers
- **Supersedes:** None
- **Superseded by:** None
- **Related docs:** [Architecture](../ARCHITECTURE.md), [Roadmap](../ROADMAP.md),
  [Releasing](../RELEASING.md)

## Context

Researk needs one source toolchain for the Harness and CLI. The toolchain must support strict
contracts, streaming adapters, terminal I/O, package boundaries, and tests. Contributors must be
able to verify a checkout with standard commands.

The repository now contains the first working vertical slice. This record makes its toolchain and
package layout explicit. It does not approve a release package.

## Decision

Use TypeScript for the Harness, CLI, Research Domain, and adapters. Use Node.js 24 or later as the
runtime. Use npm 11 and npm workspaces for dependency and package management.

Use ECMAScript modules and TypeScript `NodeNext` resolution. Enable strict compiler checks. Build
declarations, source maps, and JavaScript into each package `dist` directory. Use TypeScript
project references for package build order.

Use these workspace packages:

- `@researk/contracts` owns runtime schemas and shared types.
- `@researk/harness` owns orchestration and provider selection.
- `@researk/provider-openai-compatible` owns the experimental generic protocol adapter.
- `@researk/research` owns research and writing domain rules.
- `@researk/cli` owns terminal input and presentation.

Use Zod for runtime contract validation. Use Vitest for tests. Use Biome for linting and formatting.
Commit the npm lockfile.

Keep GitHub Release packaging gated. Do not claim an installable or native package until a later
decision defines supported platforms, artifact formats, installation, signing, checksums, an SBOM,
and provenance.

## Reasons

- TypeScript gives the public Harness contracts static types and runtime JavaScript reach.
- Node.js provides stable streams, cancellation, HTTP, and terminal APIs.
- npm workspaces keep package boundaries visible without a second package manager.
- Project references detect invalid dependency direction during the build.
- Vitest and Biome provide one test path and one style path for all workspaces.

## Consequences

### Positive

- A clean checkout uses one runtime and one package manager.
- The Harness and CLI share contracts without copied types.
- Contributors can run the same checks from the repository root.
- Packages can be tested and built independently.

### Negative

- Contributors need Node.js 24 and npm 11.
- The workspace does not produce a native executable or installer.
- JavaScript dependencies add supply-chain and license-review work.
- Project references require explicit package boundaries and build order.

## Rejected alternatives

### One undivided package

Do not put the CLI, Harness, adapters, contracts, and Research Domain in one package. That layout
hides dependency direction and makes the reusable Harness boundary difficult to test.

### Python as the primary implementation

Do not use Python as the primary toolchain now. It would replace the working TypeScript vertical
slice and add a second packaging model without a current product need.

### Rust as the primary implementation

Do not use Rust as the primary toolchain now. Native binaries can help distribution later, but a
rewrite would delay the Harness contracts and adapter work. A future native launcher or isolated
component needs a separate decision.

## Dependency license spikes

The citation processor and graphical math renderer are not selected.

The current `citeproc-js` candidate uses `CPAL-1.0 OR AGPL`. Those reciprocal licenses need legal
and distribution review before the project can combine or ship that processor with Apache-2.0
artifacts. Do not add it as a dependency until the review closes.

The Rust `resvg` core uses `Apache-2.0 OR MIT`. The candidate Node.js binding
`@resvg/resvg-js` uses MPL-2.0. Its source and bundled binary obligations need review before
adoption. Do not infer that the core license applies to the Node.js package.

Record the selected dependency, exact version, license files, notices, binary contents, and
distribution obligations in a later decision or dependency review.

## Security and privacy effects

The npm lockfile fixes the resolved dependency graph for review. Runtime validation remains
required at every external boundary because TypeScript types do not validate untrusted data.
Package lifecycle scripts and transitive packages are supply-chain inputs. Release automation must
review them before it executes or bundles them.

The toolchain does not change the local-first boundary. It does not authorize telemetry, credential
persistence, tool execution, or network access.

## Validation criteria

- A clean checkout with Node.js 24 and npm 11 completes `npm install`.
- `npm run build` completes for all workspace packages.
- `npm run typecheck` completes for all workspace packages.
- `npm test` completes for all workspace packages.
- `npm run lint` and `npm run format-check` complete from the repository root.
- The built CLI runs its help command and offline fake-provider smoke tests.
- No official release is published until the release gates in `docs/RELEASING.md` pass.

## Follow-up

- Add continuous integration for the declared operating-system matrix.
- Define release artifact formats and native packaging in a separate decision.
- Complete license review before adding a CSL processor or graphical math backend.
- Add dependency, secret, and license checks to release gates.
