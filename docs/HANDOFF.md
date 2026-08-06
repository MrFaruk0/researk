# Development handoff

**Last update:** 2026-08-06

## Objective

Recover and verify the interrupted independent-review changes before starting another feature.
The Harness remains the execution authority, and typed events drive the CLI.

## Last fully verified baseline

The first in-process vertical slice was fully green on Windows with Node.js `v24.14.1` and npm
`11.11.0` before the independent review changed the tree.

```text
npm install --ignore-scripts --no-audit --no-fund  # passed
npm run build                                      # passed: 5 packages
npm run typecheck                                  # passed: 5 packages
npm test                                           # passed: 40 tests in 6 files
npm run lint                                       # passed: 49 files
npm run format-check                               # passed: 49 files
node packages/cli/dist/bin.js help                 # passed
$env:RESEARK_FAKE_PROVIDER='1'; node packages/cli/dist/bin.js models
                                                     # passed: fake:research-fake
$env:RESEARK_FAKE_PROVIDER='1'; node packages/cli/dist/bin.js chat --model fake:paper --raw "test prompt"
                                                     # passed
```

This result applies only to the pre-review baseline. **Do not trust the old 40-test green result
for the current post-review tree.**

## Implemented baseline

- Root Node.js 24 npm workspace, TypeScript project references, Biome configuration, and lockfile.
- `@researk/contracts`: Zod runtime schemas and readonly shared types.
- `@researk/harness`: provider registry, exact model selection, capability checks, reasoning
  resolution, cancellation, typed events, redaction, and deterministic fake adapter.
- `@researk/provider-openai-compatible`: model discovery, JSON and SSE chat completion, limits,
  cancellation, reasoning maps, substitution checks, and redacted errors.
- `@researk/research`: bounded workflow and publication-profile metadata.
- `@researk/cli`: help, version, doctor, models, chat, in-process Harness connection, fake mode,
  TTY REPL, raw and JSON output, and safe exact-source LaTeX handling.

## Interrupted review state

Changes from the independent review are present in the shared working tree, but the final tree has
not passed the full verification set.

The CLI reviewer changed command parsing, `--json` and `--raw` exclusivity, exit codes, redaction,
fake and provider behavior, the approval callback, abort forwarding, and related tests. The
reviewer reported 22 of 22 CLI tests and 2 of 2 Research Domain tests passing at an intermediate
point. A final injected-REPL redaction repair then started and was interrupted. Inspect that repair
and verify it. The intermediate targeted results do not certify the current tree.

The provider reviewer changed Harness timeout-versus-cancellation behavior and stop handling after
completion. The reviewer then started, but did not finish or verify, these provider security
repairs:

- make the SSE event limit independent of transport byte and chunk boundaries;
- cancel response readers on all termination paths;
- reject credentials, query strings, and fragments in provider base URLs;
- reject duplicate model identities;
- handle missing model revisions explicitly;
- reject unavailable model selection; and
- validate numeric limits.

Some of these edits are already on disk. Notable touched files include `sse.ts`, `registry.ts`,
`harness.ts`, and CLI REPL, safety, and runtime tests. Treat every item as incomplete until the diff
and tests prove otherwise.

Public status documents and ADR 0008 were also edited to describe the runnable pre-alpha source
build. Their link, format, terminology, and status scans were interrupted. Review and verify those
edits before calling the documentation work complete.

No review agents remain active after this handoff.

## Current limitations

- No installable GitHub Release or native package exists. The CLI runs from the built workspace.
- Only the generic OpenAI-compatible adapter and offline fake adapter exist. Native provider
  support is not verified.
- Model catalogs have no persistent last-known cache or offline freshness behavior.
- Credentials use an environment-variable reference. Operating-system credential storage is not
  implemented.
- Sessions, workspace persistence, migrations, and resume behavior are not implemented.
- The Research Domain exposes bounded metadata only. It does not ingest sources or execute
  workflows.
- APA 7 and IEEE processors, CSL integration, manuscript exports, and golden tests are not
  implemented.
- CLI math output uses the safe exact-source fallback. Graphical math backends are not implemented.
- Scholarly web tools and isolated paper-reproduction execution are not implemented.

## Exact next task

Inspect the complete current diff. Finish the provider and CLI review repairs and their tests. In
particular, resolve the interrupted injected-REPL redaction change and every provider security item
listed above. Review the public-status documentation and ADR 0008, then complete the link,
terminology, and status scans.

After the repairs are complete, run the full verification set on the current tree:

```text
npm install
npm run build
npm run typecheck
npm test
npm run lint
npm run format-check
git diff --check
node packages/cli/dist/bin.js help
$env:RESEARK_FAKE_PROVIDER='1'; node packages/cli/dist/bin.js models
$env:RESEARK_FAKE_PROVIDER='1'; node packages/cli/dist/bin.js chat --model fake:paper --raw "test prompt"
```

Record the final test and file counts only after these commands pass. Only after the complete tree
is green should work proceed to the versioned model-catalog cache and CLI capability filters.

## Decisions in force

- Researk is an Apache-2.0 local-first Harness and CLI only.
- The Harness is the single in-process execution authority.
- The CLI contains presentation logic but no duplicate research or provider logic.
- Provider selection uses dynamic capabilities and canonical `provider:model` identity.
- Internet research must retain source and claim provenance.
- APA 7 and IEEE are the initial publication profiles.
- CLI math rendering preserves source and never invokes system TeX.
- TypeScript, Node.js 24, npm workspaces, Vitest, and Biome are the source toolchain recorded by
  ADR 0008, pending final documentation verification.
- Paper reproduction requires approval and disposable isolation.

Update this file after each completed milestone and before ending a development session.
