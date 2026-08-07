# Development handoff

**Last update:** 2026-08-07

## Current verified state: full gate set green after the trusted-renderer-output fix

The complete required gate set was run against the current working tree after the final reviewer
finding was fixed in `packages/cli/src/run.ts`. Every gate passed. These are the authoritative
counts for the tree as it stands.

```text
npm run clean                                      # passed: 7 workspace packages
npm run build                                      # passed: 7 workspace packages
npm run typecheck                                  # passed: 7 workspace packages
npm test                                           # passed: 166 tests in 15 files
npm run lint                                       # passed: 80 files
npm run format-check                               # passed: 80 files
git diff --check                                   # passed: no whitespace errors
```

Per-package test totals behind the 166: `@researk/cli` 55 in 7 files, `@researk/latex-renderer` 76
in 3 files, `@researk/provider-openai-compatible` 12 in 1, `@researk/contracts` 10 in 1,
`@researk/harness` 7 in 1, `@researk/provider-openrouter` 4 in 1, and `@researk/research` 2 in 1.
`git diff --check` was run with the untracked files added as intent-to-add so they were actually
inspected; the index was restored afterward.

## Completed milestone: trusted renderer output is no longer double-escaped

The final reviewer finding is addressed in `packages/cli/src/run.ts`. Trusted ANSI produced by
`renderInteractiveEvents` was previously passed back through `safeTerminalText`, which escaped the
renderer's own theme sequences into literal `\u{001b}` text. Interactive themed output was therefore
visibly corrupted rather than styled, at all three call sites: the streaming `writeText` callback,
the streaming return value, and the end-of-response parser tail.

The trust boundary is now applied exactly once and in the correct order. Untrusted model text is
redacted and neutralized by `safeTerminalText` before it reaches the parser or the theme, so the
parser only ever sees inert source and every event the renderer styles is already safe. The
renderer's output is then written verbatim. The parser tail receives identical handling: its events
descend only from already-neutralized deltas, so the tail and its `writeText` callback are written
without a second escape pass. The raw path keeps single-pass `safeTerminalText` on the model delta.

Escaping before parsing is safe for the incremental parser because `escapeUnsafeTerminalControls`
maps per code point and preserves tab, carriage return, and line feed, so Markdown and math
boundaries are unchanged. Secret redaction is unaffected: streaming redaction still runs first in
`executeChat`, and the per-event call still passes the configured secret values.

Both invariants are pinned by regression tests in `test/runtime.test.ts` driving a real dark TTY
theme. One asserts active styling reaches stdout (`\u001b[38;5;222m`, `\u001b[38;5;117m`, the reset,
and exact `theme.code`/`theme.math` spans) and that literal `\u{001b}` does not appear. Another
feeds model text containing an OSC title sequence, a bare C0 control, and a synthetic credential,
then asserts the controls are escaped to visible text, no active `ESC`/`BEL`/C0 byte reaches the
terminal, the credential is redacted, and trusted theme styling is still active alongside them. A
third covers the raw path. The tests were confirmed load-bearing: both theme tests fail when the
prior double-escaping is restored.

All four supported CLI smoke checks pass against the built `packages/cli/dist/bin.js`:

```text
node packages/cli/dist/bin.js help                 # passed: exit 0
node packages/cli/dist/bin.js version              # passed: exit 0, 0.1.0-alpha.1
node packages/cli/dist/bin.js doctor --json        # passed: exit 0, telemetry false, no secret values
"" | node packages/cli/dist/bin.js                 # passed: exit 2, non-TTY guard on stderr
```

Renderer process lifecycle is verified twice over. The five `test/process-lifecycle.test.ts` cases
pass inside the suite, and the same paths were re-confirmed independently against the built package
from real `--input-type=module` stdin hosts, because inherited `execArgv` and worker event-loop
references are only observable in a real host. Each host exited on its own with code 0 and no
`ERR_INPUT_TYPE_NOT_ALLOWED`: a one-shot render in 544 ms, a pre-warmed but unused pool in 497 ms,
and a deterministic close followed by a reopened render in 789 ms. A regression in either lifecycle
fix would present as a hang, so the prompt wall-clock exit is the load-bearing observation.

## Completed milestone: strict worker-protocol runtime validation

Every message received from a LaTeX renderer worker is now validated as untrusted input before any
field reaches a caller. The previous guard only checked the discriminator and that `id` was a safe
integer; a `result` payload was never inspected at all, and a worker `error` message was reflected
verbatim into the caller-visible error.

Validation lives in `packages/latex-renderer/src/protocol.ts` and is closed by construction.
`parseWorkerResponse` takes the request actually in flight and requires: an exact discriminator, a
bounded request id in `[1, 2^32]` that matches the outstanding request exactly, an exact key set on
both the envelope and the payload, the pinned `mathjax-4.1.3` renderer identity, a bounded `svg`
string, an error `code` drawn from the closed worker-owned set, and a bounded error `message`. PNG
responses additionally require a real `ArrayBuffer`-backed `Uint8Array` within the 8 MiB ceiling and
finite positive integer `width`/`height` within 4096x2048 and the 8388608-pixel area ceiling. A
shared-memory-backed view is rejected because it would let a worker mutate bytes after validation.

Operation consistency is enforced in both directions: an SVG request must not come back carrying
raster fields, a PNG request must carry all of them, and the worker-echoed `tex` and `display` are
compared to the request rather than merely type-checked, so a worker cannot substitute the canonical
source the caller keeps. The ready handshake is a separate exact check, so a worker whose first
message is not precisely `{ type: "ready" }` never becomes usable.

Any malformed message fails as `worker_failed` and drives the existing terminate-and-replace path;
no worker-supplied text is surfaced. A validated in-contract error code is preserved rather than
downgraded, but its sentence is pool-authored by `describeWorkerError`, so untrusted TeX, MathJax
internals, and host paths cannot reach a caller or a log through an error. The request-id counter
now wraps at the bound so an id is always an exact small integer. `src/worker.ts` shares the same
request guard instead of duplicating a weaker one.

`test/protocol-validation.test.ts` adds focused negative coverage driven by
`test/malformed-worker.mjs`, which emits one malformed message and then behaves correctly, so each
case also proves the poisoned worker was replaced and the next expression succeeded. Coverage spans
discriminator, id, envelope, error-code, error-message, payload, operation-consistency, PNG, and
dimension violations, asserts no leak of a fixture secret through any error field or nested cause,
and pins the accepted boundary at exactly 4096x2048. The suite was verified load-bearing: restoring
the old permissive check fails 36 of 56 tests.

All prior lifecycle fixes are preserved unchanged. Gates run for this change:
`npm run build`/`typecheck`/`test` for `@researk/latex-renderer` (3 files, 76 tests), repository-wide
`typecheck`, `@researk/cli` tests (7 files, 52 tests), and Biome lint plus format on the package.
The full repository gate set has since been rerun green; see the current verified state above.

## Completed milestone: worker-pool host-process blockers

Two proven blockers in the LaTeX renderer worker pool are fixed in `@researk/latex-renderer`.

First, pool workers no longer inherit `process.execArgv`. Inheriting host flags propagated
`--input-type=module` into a file-URL worker, which is rejected with `ERR_INPUT_TYPE_NOT_ALLOWED`
and failed every render whenever the host process was started from stdin. Workers are now
constructed with an explicit empty `execArgv`; they require no host flags.

Second, an idle pool no longer keeps a one-shot process alive. Pre-warmed workers previously held
the event loop open, so a normal `researk` render invocation never exited. Workers are created
unreferenced, referenced only while a job is actually in flight, and unreferenced again as soon as
the slot goes idle, so an in-flight render still cannot be dropped by process exit. Initialization
and per-job timers are unreferenced as well, and an unobserved initialization rejection is absorbed
so it cannot surface as an unhandled rejection that changes a one-shot exit code. The new exported
`closeManagedLatexRenderer()` provides deterministic shutdown for long-lived hosts and is called by
the CLI REPL at session end; it also resets the shared pool so a later render reopens it.

Regression coverage is deliberately split. In-process tests assert that worker options carry an
empty `execArgv` and that a slot is unreferenced while idle and referenced only for an active job.
Because `execArgv` inheritance and event-loop references are only observable in a real host,
`test/process-lifecycle.test.ts` drives the built package from child processes started with
`--input-type=module` and asserts prompt exit for a one-shot render, a pre-warmed unused pool, a
render still in flight, and a deterministic close followed by a reopened render. Each child is
killed on a timeout so a regression fails as an assertion rather than hanging the suite. Both fixes
were verified to be load-bearing by reverting each one against the built artifact and confirming
the new tests fail.

Full gates passed at that milestone: `npm run build`, `npm run typecheck`, `npm test` (14 files, 102
tests), `npm run lint`, and `npm run format-check` (78 files). CLI smoke checks `help`,
`doctor --json`, and the non-TTY guard each exit promptly with the expected codes. Those counts are
the historical result for that milestone and are superseded by the current verified state above.

## Completed milestone: isolated untrusted TeX rendering

MathJax and Resvg now run in a pre-initialized, bounded Node worker pool rather than on the REPL
event loop. Response-scoped expression-count and cumulative-time budgets are enforced alongside
per-job input, timeout, SVG, raster-dimension/payload, and worker-memory ceilings. Timeout, crash,
malformed protocol, cancellation, and renderer failure terminate the affected worker and replace it
before another job is accepted. The worker dependency path has no network, shell, subprocess,
browser, workspace, or system-TeX helper authority.

CLI graphical rendering preserves exact canonical source on every failure, while raw, JSON,
accessible, and non-TTY modes remain source-only. The worker module is emitted into `dist` by the
normal TypeScript build and shipped by the renderer package. Negative fixtures cover timeout,
crash/restart, protocol rejection/restart, cancellation, and response limits. Full build,
typecheck, test, lint, and format gates pass.

## Completed milestone: final documentation review corrections

Public documentation now matches the implemented terminal-math and provider boundaries: local
MathJax SVG plus in-memory resvg is emitted only for display math in positively detected iTerm2
TTYs; all other paths preserve exact source; Kitty and Sixel remain unsupported; and the CLI has no
`RESEARK_FAKE_PROVIDER` or `fake:paper` mode. The unimplemented `--math`, `--math-fallback`, and
`--math-theme` options are identified as planned contract behavior rather than current CLI options.
Documentation validation passed with `npm run format-check`, targeted contradiction and terminology
scans, and `git diff --check`. No repository link-check script is available; the edited documents'
relative links were reviewed against existing targets.

## Completed milestone: three-chunk raw palette input

Reviewer finding 4 is addressed in `packages/cli`. Raw CSI palette input is explicitly covered when
the bytes arrive as three separate chunks (`ESC`, `[`, `B`), so the initial Escape byte is buffered
instead of cancelling the prompt. The parser's bounded 35 ms wait for incomplete escape sequences is
also verified with fake timers: an incomplete sequence is discarded after the timeout and does not
cancel the palette.

Focused validation passed: `npm test --workspace @researk/cli -- io.test.ts` and
`npm run typecheck --workspace @researk/cli`.

## Completed milestone: accessible REPL theme preservation

Reviewer finding 3 is addressed in `packages/cli`. Recreating a theme through the argument-less
`/theme` REPL command now preserves accessible mode's plain-output invariant, so changing themes
cannot introduce ANSI controls into prompts or notices. Regression coverage drives the real guided
TTY palette under `--accessible` and asserts ANSI-free stdout and stderr after selecting a new theme.

Focused validation passed: `npm test --workspace @researk/cli -- runtime.test.ts` and
`npm run typecheck --workspace @researk/cli`.

## Completed milestone: non-duplicating graphical math source reveal

Reviewer finding 2 in the terminal graphics work is addressed in `packages/cli`. A successfully
rendered display equation now emits only the graphical terminal protocol in normal visible output;
the renderer no longer returns the same raw LaTeX for a second visible write. Canonical response
text remains unchanged in `executeChat` and REPL history. The documented `/source` REPL command
reveals the latest assistant response as exact source for direct inspection or copying. Unsupported,
accessible, raw, JSON, and graphics-error paths continue to use exact-source output.

Terminal integration coverage asserts approved iTerm2 protocol bytes, absence of duplicate visible
LaTeX, exact canonical returned text, and `/source` output through the real REPL command loop.
Focused validation passed: `npm test --workspace @researk/cli -- terminal.test.ts runtime.test.ts`
(2 files, 21 tests), `npm run build --workspace @researk/cli`, `npm run typecheck --workspace
@researk/cli`, and `git diff --check`.

## Completed milestone: overlap-safe streaming credential redaction

Reviewer finding 1 in the current safety implementation is addressed in `packages/cli`. Streaming
redaction now removes complete secret matches before retaining a possible prefix for the next chunk,
so self-overlapping and repeated-prefix credentials such as `abab` cannot be reconstructed from
separately emitted output. Ordinary text and incomplete-prefix buffering behavior remain unchanged.

Regression coverage checks every possible chunk partition of repeated-prefix inputs (`abab` and
`aaaa`) and exercises the real CLI chat runtime with `abab` split across text events. Focused safety
and runtime validation passed: `npm test --workspace @researk/cli -- safety.test.ts` (1 file, 3
tests) and `npm test --workspace @researk/cli -- runtime.test.ts` (1 file, 15 tests).

## Completed milestone: robust command-palette terminal input

Reviewer findings 3, 4, and 5 are addressed in `packages/cli`. Command-palette redraws now move to
the top of the prior frame and clear and replace every rendered row, with serialized writes to avoid
interleaved frames during rapid input. Raw keyboard input is parsed from a buffer, so ANSI CSI and
SS3 arrows may span stream chunks; 8-bit CSI and legacy Windows extended-key arrow forms are also
recognized. A short bounded wait distinguishes standalone Escape cancellation from an incomplete
escape sequence. Unknown or timed-out partial sequences are discarded and do not cancel a prompt.

Focused tests cover redraw cleanup, split CSI navigation, incomplete sequences, standalone Escape,
and masked-input handling. A TTY-like end-to-end `/provider` test drives the real loopback provider
through profile choice, pasted masked synthetic API key, guided model selection, chat response echo
redaction, and a later Escape cancellation. The key is absent from captured stdout and stderr, and
the existing non-TTY fallback remains unchanged. Validation passed: `npm test --workspace
@researk/cli` (6 files, 43 tests), `npm run build --workspace @researk/cli`, and `npm run typecheck
--workspace @researk/cli`.

## Completed milestone: guided provider credential redaction

Reviewer finding 2 is addressed in `packages/cli`. API keys entered through the guided provider
flow remain in an ephemeral credential map and are passed explicitly through provider construction,
Harness resolution, and chat execution without persistence or environment mutation. Environment
credential lookup remains supported. Combined environment and ephemeral secret values now redact
streamed text across event and transport chunk boundaries, JSON events, diagnostics, provider and
construction errors, terminal presentation, returned chat text, and selection metadata.

Regression coverage uses synthetic keys echoed by a real loopback provider in successful streamed
output and HTTP errors, plus interleaved text/diagnostic/error events and construction failures.
Captured stdout and stderr never contain the keys, and tests assert the supplied environment and
`process.env` are unchanged. Validation passed: `npm test --workspace @researk/cli` (6 files, 39
tests), `npm run build --workspace @researk/cli`, and `npm run typecheck --workspace @researk/cli`.

## Completed milestone: safe interactive terminal math graphics

Reviewer finding 1 is addressed in `packages/cli`: the existing bounded local MathJax SVG backend is
rasterized in memory with the bundled `@resvg/resvg-js` adapter and emitted through a trusted iTerm2
inline-image protocol emitter. Capability detection requires a real TTY, rejects dumb/CI and
unverified multiplexers, and requires iTerm2's documented terminal identity; Kitty remains
unsupported rather than being advertised without its bounded query/reply broker. Unsupported or
failed graphics preserve exact math source. Non-TTY, raw, JSON, and accessible paths do not probe or
emit graphics, and event source concatenation remains canonical.

Validation: `npm test --workspace @researk/cli`, `npm run build --workspace @researk/cli`, and
`npm run typecheck --workspace @researk/cli` pass (6 test files, 35 tests), including protocol
emission, unsupported and accessible fallback, and source reconstruction.

## Completed milestone: CLI Markdown and math presentation

The CLI renderer now has a presentation-only, theme-aware Markdown path for interactive TTY output:
headings, list/quote markers, fenced code, and math source receive restrained semantic styling while
the parser's exact event source remains unchanged. Pipes, raw output, and accessible presentation
remain byte-for-byte source-oriented and never receive ANSI controls. A replaceable local
`MathJaxSvgMathRenderer` adapter is available through the existing `@researk/latex-renderer` package.

This presentation milestone preceded the iTerm2 graphics milestone documented above.

## Completed milestone: interactive terminal command palette

The CLI TTY REPL now provides guided, keyboard-selectable flows for provider profiles, model
selection, reasoning intent, and themes. Provider keys entered through the guided flow are masked
and held only in process memory behind the existing environment-reference credential boundary; they
are never written to output, history, configuration, or session state. Raw-key helpers support
Windows-compatible arrow/j/k navigation, Enter, Escape, backspace, and Ctrl-C, and safely return to
the existing line-oriented behavior when raw terminal mode is unavailable. Non-TTY commands remain
unchanged and continue to reject an argument-less invocation; this boundary is covered by the CLI
runtime tests.

Validation for this milestone: the complete workspace gates passed after integration: 11 test files
and 69 tests, including palette selection, masked-input no-leakage, non-TTY degradation, provider
redaction, cancellation, and canonical LaTeX coverage in raw, JSON, and accessible rendering paths.

## Objective

The interrupted CLI integration and independent-review changes are recovered and verified. The
Harness remains the execution authority, and typed events drive the CLI.

## Last fully verified baseline

The first in-process vertical slice was fully green on Windows with Node.js `v24.14.1` and npm
`11.11.0` before the independent review changed the tree.

```text
npm install                                        # passed: 82 packages, 0 vulnerabilities
npm run build                                      # passed: 7 workspace packages
npm run typecheck                                  # passed: 7 workspace packages
npm test                                           # passed: 69 tests in 11 files
npm run lint                                       # passed: 70 files
npm run format-check                               # passed: 70 files
node packages/cli/dist/bin.js help                 # passed
"" | node packages/cli/dist/bin.js                       # passed: exit 2, non-TTY guard
```

The historical result above applies only to the pre-review baseline. The current post-review tree
has been reverified with the complete gate set recorded in the current verified state at the top of
this file.

## Implemented baseline

- Root Node.js 24 npm workspace, TypeScript project references, Biome configuration, and lockfile.
- `@researk/contracts`: Zod runtime schemas and readonly shared types.
- `@researk/harness`: provider registry, exact model selection, capability checks, reasoning
  resolution, cancellation, typed events, redaction, and deterministic fake adapter.
- `@researk/provider-openai-compatible`: model discovery, JSON and SSE chat completion, limits,
  cancellation, reasoning maps, substitution checks, and redacted errors.
- `@researk/research`: bounded workflow and publication-profile metadata.
- `@researk/cli`: help, version, doctor, models, chat, in-process Harness connection, TTY REPL, raw
  and JSON output, and safe exact-source LaTeX handling. The offline fake adapter is available for
  Harness-level tests, but the CLI does not expose a fake-provider mode.

## Verified review state

Changes from the independent review and interactive CLI/rendering work are integrated in the shared
working tree and have passed the full verification set.

The CLI command parsing, `--json` and `--raw` exclusivity, exit codes, redaction, provider behavior,
approval callback, abort forwarding, TTY REPL, guided selection, and exact-source output paths are
covered by the current passing tests. Ephemeral guided credentials are masked, remain memory-only,
and are included in output/error redaction.

The provider review changes for Harness timeout-versus-cancellation behavior, stop handling, and the
following provider security boundaries are present and covered by the passing workspace suite:

- make the SSE event limit independent of transport byte and chunk boundaries;
- cancel response readers on all termination paths;
- reject credentials, query strings, and fragments in provider base URLs;
- reject duplicate model identities;
- handle missing model revisions explicitly;
- reject unavailable model selection; and
- validate numeric limits.

No review agents remain active after this handoff.

## Current limitations

- No installable GitHub Release or native package exists. The CLI runs from the built workspace.
- Only the generic OpenAI-compatible adapter is exposed through the CLI, and native provider
  support is not verified. An offline fake adapter exists for Harness-level tests only; the CLI
  does not support `RESEARK_FAKE_PROVIDER` or `fake:paper` smoke runs.
- Model catalogs have no persistent last-known cache or offline freshness behavior.
- Credentials use an environment-variable reference. Operating-system credential storage is not
  implemented.
- Sessions, workspace persistence, migrations, and resume behavior are not implemented.
- The Research Domain exposes bounded metadata only. It does not ingest sources or execute
  workflows.
- APA 7 and IEEE processors, CSL integration, manuscript exports, and golden tests are not
  implemented.
- CLI math output supports the bounded local MathJax 4 SVG backend, in-memory `@resvg/resvg-js`
  rasterization, and direct iTerm2 inline-image emission when a real supported iTerm2 TTY is
  positively detected. Exact LaTeX source remains the fallback for unsupported, inaccessible,
  non-TTY, and rendering-error paths. Kitty graphics support is not implemented because its bounded
  query/reply capability broker is still missing; Sixel and other terminal graphics protocols remain
  unsupported as well. Full-document TeX compilation, external renderer executables, and arbitrary
  TeX packages remain out of scope.
- Scholarly web tools and isolated paper-reproduction execution are not implemented.

## Exact next task

Proceed to the versioned model-catalog cache and CLI capability filters. Preserve the verified TTY,
credential-redaction, and exact-source output boundaries. Before completing the next milestone, run:

```text
npm install
npm run clean
npm run build
npm run typecheck
npm test
npm run lint
npm run format-check
git diff --check
node packages/cli/dist/bin.js help
node packages/cli/dist/bin.js version
node packages/cli/dist/bin.js doctor --json
"" | node packages/cli/dist/bin.js
```

When new files are still untracked, run `git add -N .` before `git diff --check` so they are
actually inspected, then restore the index. Counts to compare against are in the current verified
state at the top of this file.

The verified CLI smoke commands are `help`, `version`, `doctor --json`, and the non-TTY guard
invoked with empty standard input. `models` and `chat` require a configured, reachable
OpenAI-compatible provider and a real model; `RESEARK_FAKE_PROVIDER` and `fake:paper` are not
supported by the current CLI and must not be used as smoke commands.

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
## Final reviewer blocker: isolated TeX rendering

The final rendering hardening milestone is implemented in `@researk/latex-renderer` and the CLI
rendering boundary. MathJax and Resvg now run in a pre-initialized bounded Node worker pool rather
than on the REPL event loop. Each response has expression-count and cumulative-time accounting;
each job has input, timeout, SVG, raster dimension/payload, and worker memory ceilings. A timeout,
crash, malformed worker protocol, cancellation, or renderer failure terminates the affected worker
and replaces it before accepting another job. Cancellation is propagated from the chat controller.
The worker has no application I/O authority and the dependency path contains no network, shell,
subprocess, browser, workspace, or system-TeX helper.

All CLI graphical paths continue to fall back to exact canonical source on any renderer failure;
JSON/raw/accessibility/non-TTY output remains source-only. The worker entry module is emitted into
the latex-renderer package `dist` by the normal TypeScript build and is included by the package's
existing `dist` files list. Negative fixtures cover timeout, crash, protocol rejection/restart,
cancellation, and response budgets. Targeted typechecks/builds and latex-renderer tests pass. The
full gate suite has since been run green; see the worker-pool host-process blockers milestone above.
