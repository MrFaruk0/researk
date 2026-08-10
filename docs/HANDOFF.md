# Development handoff

## 2026-08-10 OpenCode-inspired TUI redesign

Completed the OpenCode-inspired Researk TUI redesign, using `img/home.png` and `img/fullscreen.png`
as visual references. The home view is clean and centered, and the interactive shell adapts to
full-screen terminal dimensions.

### Delivered behavior

- User and assistant messages render in bordered surfaces without visible `you:`/`researk:` labels.
  There is no routine bottom chat-log/status feed; actionable notices remain, with compact activity
  in the header.
- Transcript scrolling supports keyboard input and SGR mouse-wheel input, with follow-tail and
  anchored states.
- Canonical Markdown/LaTeX is preserved. Terminal-safe styled math, code, and citation rendering is
  used; `/source` shows exact source with a bounded sparse layout cache for very long or unbroken
  content.
- Added `tokyo-night`, `catppuccin`, `rose-pine`, and `everforest` themes with semantic tokens;
  runtime no-color preference dominates theme styling.
- Tiny terminals degrade responsively, including overlay sizing. History redacts secrets; active-run
  commands are guarded; cancellation suppresses late writes; session/workspace safety is preserved.
- Provider reconnect race guards, redactor finalization, and credential-fingerprint cache
  invalidation harden runtime behavior.
- Config and session writes are atomic and serialized per target; unrelated sessions can write
  concurrently.
- Normal startup uses non-persistent credentials. The OS keychain backend remains future work; no
  plaintext key is persisted by normal startup.

### Validation

- `npm install`: passed — 125 packages audited, 0 vulnerabilities.
- In the one `npm run verify` attempt, clean/build/typecheck passed across all 7 workspaces; all
  non-CLI workspace tests passed (132); CLI had 329/330 passing. The sole failure was test code,
  `ReferenceError: mountGated is not defined` in `tui-app.test.tsx`, not product behavior. The
  aggregate command was therefore not green and stopped before lint/format.
- The test-helper scoping defect was fixed afterward; the formerly failing test passed 1/1 in a
  targeted run.
- No second full-suite run was performed, intentionally avoiding another redundant broad rerun at
  the user's request.
- Final `npm run lint`: exit 0 — 122 files, one non-blocking style warning plus 14 informational
  template/import suggestions.
- Final `npm run format-check`: passed — 122 files.
- Final `git diff --check`: passed.
- CLI smoke: help, version, and doctor passed; piped non-TTY invocation rejected a missing command as
  designed.

### Residual limitations / risks

- The OS keychain backend is not yet implemented; keys must be injected through supported
  environment-variable references each startup.
- Atomic persistence serialization is in-process; cross-process writers remain a limitation.
- Help/version currently print `0.1.0-alpha.1` while the root package is `0.1.0-alpha.3`; this
  pre-existing version metadata mismatch remains a follow-up.

## 2026-08-10 TUI persistence wiring

Wired the persistence storage layer into the Researk TUI controller and startup. The storage layer
from the previous milestone is now consumed end to end: startup restoration, session autosave,
the `/sessions` browser, and `/new`.

### What was built

- `TuiController` gained an optional `storage` constructor dependency (`configStore`,
  `sessionStore`, `providerRegistry`, `credentialStore`). Every storage method degrades to a no-op
  (null / empty array / void) when the matching store is absent, so the controller stays fully
  usable in tests and non-TUI contexts.
- Controller persistence API: `loadConfig`, `saveConfig` (partial merge over the persisted config),
  `listSessions`, `loadSession`, `saveSession`, `deleteSession`, `autoTitle`, `resolveBaseUrl`,
  `resolveCredential`, `getProvider`, `persistProvider`. All I/O is best-effort and swallowed inside
  the controller; App call sites add `.catch(() => {})` as defence in depth.
- `startTui` now builds the stores from `ensureDataDirs()` (guarded: no data root means in-memory
  only), loads the persisted app config, and restores the provider profile, default model, reasoning
  variant, theme, colour preference, and the last session's conversation. Normal startup credentials
  are intentionally non-persistent and must be supplied through supported environment-variable
  references each run. Explicit CLI flags still win over persisted values.
- Provider persistence: after a successful connect, the active provider profile and connection
  metadata are persisted; normal TUI startup does not persist or restore plaintext credentials, so
  supported environment-variable references must provide keys again on each startup.
- Session autosave: after every completed exchange the conversation (history captured before the run
  plus the run outcome) is persisted to a stable per-session file; the session id is reused across
  exchanges, and `lastSessionId` is recorded. `/new` clears the pointer.
- `/sessions` now opens a real session browser (`SessionOverlay`) listing saved sessions; Enter loads
  the selected session into the conversation. `/new` starts a fresh untitled session and clears the
  persisted pointer.
- `createInitialState` accepts optional session metadata and a restored conversation so startup
  restoration can carry the transcript directly.

### Verification

```text
npm test --workspace @researk/cli                                  # passed: 263 in 18 files
npm run typecheck                                                  # passed
npm run build                                                      # passed: 7 workspace packages
npm run format-check                                               # passed: 114 files
git diff --check                                                   # passed: no whitespace errors
```

`@researk/cli` went from 250 to 263 tests. New coverage: controller persistence (config partial
merge, model-preserving writes, session CRUD through the controller, provider profile persistence,
no-op behaviour without stores) and TUI session integration (browser listing, load into the
conversation, autosave with footer title, `/new` pointer clearing, `/clear` leaving saved sessions
untouched).

The only remaining lint error is in the untracked `packages/cli/test/tmp-debug.test.tsx` debug
fixture from the earlier TUI milestone; it is not part of this milestone's ownership scope.

### Files changed (this milestone, on top of the storage layer)

- `packages/cli/src/tui/controller.ts`
- `packages/cli/src/tui.tsx`
- `packages/cli/src/tui/App.tsx`
- `packages/cli/src/tui/state.ts`
- `packages/cli/src/tui/overlays/SelectOverlays.tsx`
- `packages/cli/test/tui-controller.test.ts`
- `packages/cli/test/tui-app.test.tsx`
- `docs/HANDOFF.md`

### Remaining work / next steps

- Rename/retitle sessions (`/rename` is not implemented yet; `session/title` action exists).
- Real schema migrations once version 2 of any schema is introduced.
- An OS-keychain credential backend per ADR 0003 remains future work; normal startup does not
  persist plaintext credentials and requires supported environment-variable references each run.

## 2026-08-10 Persistence storage layer for the CLI

Implemented the complete persistence storage layer in `packages/cli/src/config/` with full tests in
`packages/cli/test/config/`. Nothing is wired into the TUI yet; the layer is ready to be consumed by
the next milestone.

### What was built

- `paths.ts` — platform-specific per-user data directories under a `researk/` root: `config`,
  `sessions`, `credentials` (created as an empty dir marker), `cache`, and `logs`. Windows uses
  `%APPDATA%`, macOS `~/Library/Application Support`, Linux `$XDG_DATA_HOME` or `~/.local/share`.
  `ensureDataDirs()` creates them all idempotently; resolution degrades to `null`/rejection when no
  platform root is available.
- `store.ts` — `FileConfigStore<T>`: versioned JSON persistence. `load` merges saved JSON over
  defaults (saved values win), reads `schemaVersion` from the saved file, and returns defaults with a
  warning for an unknown newer version (real migrations are future work). `save` writes atomically
  (temp file + `rename`).
- `credentials.ts` — `FileCredentialStore` with `get`/`set`/`delete`, one plaintext file per
  reference, `toString` masks secrets. Carries an explicit SECURITY WARNING comment: this is NOT
  secure storage (ADR 0003's OS credential store remains the intended long-term backend).
- `providers.ts` — `ProviderProtocol` (`openrouter` | `compatible`), built-in OpenRouter definition
  (default base URL `https://openrouter.ai/api/v1/`, `OPENROUTER_API_KEY`), and
  `PersistentProviderRegistry` wrapping a `ConfigStore` + `CredentialStore` with CRUD for custom
  providers, credential resolution, and base-URL resolution (profile base URL first, then built-in
  default, else `undefined`).
- `config.ts` — `AppConfig` schema (schemaVersion 1, providers, activeProviderId,
  defaultModelByProvider, selectedVariantByModel, theme, lastSessionId, colorEnabled) and
  `AppConfigStore`.
- `sessions.ts` — `SessionStore` with per-session JSON files, `listSessions` sorted by `updatedAt`
  descending, atomic writes, defensive reads (missing/corrupt/unreadable files surface as `null`),
  and `autoTitle` (first user message, 80 code points, ellipsis).

### Verification

All six npm gates plus `git diff --check` green on Node.js `v24.14.1`, Windows:

```text
npx vitest run test/config                                        # passed: 53 tests in 6 files
npm test --workspace @researk/cli                                  # passed: 244 in 17 files
npm run clean                                                      # passed: 7 workspace packages
npm run build                                                      # passed: 7 workspace packages
npm run typecheck                                                  # passed: 7 workspace packages
npm test                                                           # passed: 376 in 25 files
npm run lint                                                       # passed: 113 files, no warnings
npm run format-check                                               # passed: 113 files
git diff --check                                                   # passed: no whitespace errors
```

Repository totals behind the 376: `@researk/cli` 244 in 17 files (was 191 in 11; +53), plus
`@researk/contracts` 10, `@researk/harness` 7, `@researk/latex-renderer` 97, `@researk/research` 2,
`@researk/provider-openai-compatible` 12, and `@researk/provider-openrouter` 4. Within the new
config suite: `paths` 9, `store` 8, `credentials` 7, `providers` 13, `sessions` 12, `config` 4.

Tests use real `node:os.tmpdir()` fixtures cleaned in `afterEach`; `process.platform` and
`process.env` are stubbed and restored around each `paths` test. The credential non-readable test is
skipped on Windows (access control is not scriptable there).

### Files changed

- `packages/cli/src/config/paths.ts`
- `packages/cli/src/config/store.ts`
- `packages/cli/src/config/credentials.ts`
- `packages/cli/src/config/providers.ts`
- `packages/cli/src/config/config.ts`
- `packages/cli/src/config/sessions.ts`
- `packages/cli/test/config/paths.test.ts`
- `packages/cli/test/config/store.test.ts`
- `packages/cli/test/config/credentials.test.ts`
- `packages/cli/test/config/providers.test.ts`
- `packages/cli/test/config/sessions.test.ts`
- `packages/cli/test/config/config.test.ts`
- `docs/HANDOFF.md`

### Remaining work / next steps

- Wire the stores into the TUI (provider registry + app config on startup/shutdown, session
  auto-save/resume, `/sessions` command).
- Real schema migrations once version 2 of any schema is introduced; for now unknown versions
  degrade to defaults with a warning.
- The credential store is intentionally plaintext and documented as NOT secure; an OS-keychain
  backend per ADR 0003 remains future work.

## 2026-08-09 TUI UX milestone

Implemented a responsive centered shell capped at 112 columns, edge-to-edge narrow rendering,
unique slash-command Tab completion, simplified provider forms, four additional themes, and explicit
keyboard semantics. OpenRouter uses its built-in endpoint and `OPENROUTER_API_KEY`; the advanced
OpenAI-compatible form uses `OPENAI_API_KEY`. Neither form exposes an environment-reference field,
and pasted credentials remain ephemeral and masked. Ctrl+C is an application no-op, Ctrl+X cancels
an active run, and `/exit` is the normal exit path.

Tests cover 140- and 50-column layouts without overflow, completion without submission, provider
field visibility, fixed internal credential references, theme construction, and cancellation/exit
behavior.

### Verification

Focused runs first, then the full gate set, all green on Node.js `v24.14.1`:

```text
npm test --workspace @researk/cli -- tui-state.test.ts                  # passed: 32 tests
npm test --workspace @researk/cli -- tui-app.test.tsx                   # passed: 65 tests
npm test --workspace @researk/cli -- tui-provider-integration.test.tsx  # passed: 5 tests
npm test --workspace @researk/cli -- tui-controller.test.ts theme.test.ts # passed: 27 tests
npm test --workspace @researk/cli                                       # passed: 191 in 11 files
npm run clean                                                           # passed: 7 workspace packages
npm run build                                                           # passed: 7 workspace packages
npm run typecheck                                                       # passed: 7 workspace packages
npm test                                                                # passed: 323 in 19 files
npm run lint                                                            # passed: 101 files
npm run format-check                                                    # passed: 101 files
git diff --check                                                        # passed: no whitespace errors
node packages/cli/dist/bin.js help                                      # passed: exit 0
node packages/cli/dist/bin.js version                                   # passed: exit 0
node packages/cli/dist/bin.js doctor --json                             # passed: exit 0, telemetry false
"" | node packages/cli/dist/bin.js                                      # passed: exit 2, non-TTY guard
```

Per-package totals behind the 323: `@researk/cli` 191 in 11 files (was 180), `@researk/latex-renderer`
97 in 3, `@researk/provider-openai-compatible` 12, `@researk/contracts` 10, `@researk/harness` 7,
`@researk/provider-openrouter` 4, and `@researk/research` 2. The CLI count rose by 11 because this
milestone adds completion, layout, and key-binding coverage.

The real Ink lifecycle was also driven through `startTui` with a TTY-shaped stream pair against the
built `dist`: the alternate screen entered on mount, an idle Ctrl+C kept the app mounted without
inserting a `c`, an idle Ctrl+X was also a no-op, `/pro`+Tab produced `/provider` and Enter opened
the provider picker rather than submitting, `/exit` exited with code 0, the alternate screen was
restored, and stderr stayed empty.

### Files changed

- `packages/cli/src/tui/commands.ts` — `completeSlashCommand` for unambiguous Tab completion
- `packages/cli/src/tui/App.tsx` — Tab handler, Ctrl+C/Ctrl+X semantics, `terminalWidth`/`terminalHeight`
  test seams, centered 112-column layout
- `packages/cli/src/tui/components/Composer.tsx` — placeholder documents Ctrl+X
- `packages/cli/src/tui/components/Footer.tsx` — persistent footer documents Ctrl+X and `/exit`
- `packages/cli/src/tui/components/Conversation.tsx` — empty-state vertical centering
- `packages/cli/src/tui/overlays/InfoOverlays.tsx` — help overlay key bindings
- `packages/cli/src/tui/overlays/ProviderOverlay.tsx` — simplified forms; removed the
  environment-reference field
- `packages/cli/src/tui/controller.ts` — fixed internal references (`OPENROUTER_API_KEY`,
  `OPENAI_API_KEY`) and OpenRouter default base URL
- `packages/cli/src/tui/theme.ts` — four additional semantic themes (nord, dracula, solarized-dark,
  gruvbox)
- `packages/cli/src/theme.ts` — extended one-shot theme names and palettes
- `packages/cli/src/tui.tsx` — comment and `exitOnCtrlC: false` intent
- `packages/cli/test/tui-state.test.ts` — completion unit tests
- `packages/cli/test/tui-app.test.tsx` — completion, layout, cancellation/exit, and provider form
  tests
- `packages/cli/test/tui-controller.test.ts` — connection reference tests
- `packages/cli/test/tui-provider-integration.test.tsx` — pasted-key integration tests
- `packages/cli/test/theme.test.ts` — extended theme construction
- `docs/HANDOFF.md`

### Intentional limitation: OpenAI-compatible URLs

There is no universal default endpoint for an OpenAI-compatible provider. The normal `/provider`
flow keeps the explicit Base URL field on the advanced OpenAI-compatible form (Provider ID + Base
URL + masked key) because omitting it would pretend an impossible default exists. The form itself
carries the disclosure line, and `validateProviderEndpoint` still enforces HTTPS-or-loopback and
rejects credentials, query strings, and fragments in that URL. OpenRouter is the only choice with a
built-in default endpoint, and its form exposes only the masked key field.

**Last update:** 2026-08-09

## Current milestone: macOS TUI provider-integration timeouts fixed as a budget problem, not a hang

The macOS CI job reported exactly two failures in
`packages/cli/test/tui-provider-integration.test.tsx`, both hitting Vitest's default 5000 ms
timeout at exactly 5.0 s: the staging-document test and the ephemeral-credential-redaction test.
The other three tests in the same file passed.

### Diagnosis: scheduling budget, confirmed by measurement

This was **not** a hang, and the two named tests were not special. Run against this tree on Windows
before any change, all five tests *passed* but sat just under the limit:

| Test | Baseline | Margin under 5000 ms |
| --- | --- | --- |
| stages a workspace document | 4696 ms | 304 ms |
| streams provider text across chunk boundaries | 4364 ms | 636 ms |
| preserves canonical LaTeX | 4661 ms | 339 ms |
| never renders an ephemeral pasted credential | 4558 ms | 442 ms |
| rejects workspace traversal | 3791 ms | 1209 ms |

The whole file was within 6-25% of the ceiling, so it was a coin flip per runner. The two that
failed on macOS are the two with the most keystrokes: the staging test adds `/read paper.tex`, and
the redaction test adds an extra Tab plus a 32-character pasted secret. Both reached ~160 `settle`
rounds against ~144 for the cheapest passing test.

The mechanism was the fixed sleep in the test helper, not product code. `settle()` awaited eight
*sequential* `setTimeout(..., 12)` calls, so every simulated keystroke cost at least 96 ms of pure
scheduling, and `connect()` ran a full settle per character of the base URL and per one of fourteen
backspaces. Real HTTP listen/accept, Harness and adapter construction, and a full Ink re-render per
keypress sat on top of a floor of roughly 1.7-1.9 s per test. Timer resolution and coalescing differ
by platform and CI load, which is what moved macOS across the line.

### Fix

Test-only. No production code, provider behavior, assertion, or security boundary was changed.

- **Explicit suite timeout.** `PROVIDER_SUITE_TIMEOUT_MS = 30_000` is applied per test in this
  describe, with a comment explaining the real HTTP, Harness, adapter, and Ink rendering overhead
  and why cross-platform timer behavior makes the 5 s default wrong here. A global `testTimeout`
  was deliberately avoided: it would also mask genuine hangs in the fast unit suites. This matches
  the precedent already in `test/tui-app.test.tsx:587`, which uses `}, 20_000)` for a *stub*-harness
  test doing strictly less work than these real-provider tests.
- **Condition-based waits replace fixed sleeps.** A bounded `waitFor(predicate, budgetMs = 10_000)`
  polls instead of assuming a fixed settle count. Every asynchronous boundary now waits on a real
  rendered signal: connection and model selection wait on the **footer** (`provider compatible`,
  `model compatible:science`), document staging and traversal rejection wait on their rendered
  result, and each streaming assertion waits on its own expected text. `waitFor` returns normally on
  timeout so the caller's original `expect` still reports the actual frame.
- **Per-keystroke settle reduced** from 8x12 ms to 4x1 ms, which is safe only because every awaited
  operation is now covered by `waitFor` rather than by padding.
- **Leak-proof cleanup.** Each test declares `let app` and calls `app?.unmount()` in `finally`, so a
  failed assertion can no longer leave a mounted Ink instance and its stdin listener attached for
  the rest of the file. Previously `app.unmount()` was the last statement before `finally` and was
  skipped entirely on failure.

### Result

Per-test time fell about 2.6x, from ~3.8-4.7 s to ~1.6-2.0 s, and the file went from ~23.5 s to
~10.8 s. The slowest test now has roughly 15x headroom against the 30 s budget instead of 6%.

| Test | Before | After |
| --- | --- | --- |
| stages a workspace document | 4696 ms | 1752 ms |
| streams provider text across chunk boundaries | 4364 ms | 1815 ms |
| preserves canonical LaTeX | 4661 ms | 1971 ms |
| never renders an ephemeral pasted credential | 4558 ms | 1966 ms |
| rejects workspace traversal | 3791 ms | 1671 ms |

Three consecutive focused runs were stable at 10.77 s, 10.90 s, and 10.86 s.

### Verification of the fix itself

Two intermediate mistakes were caught by the suite rather than shipped, and both are recorded
because each pins a real constraint:

- Batching the fourteen backspaces into one `stdin.write` broke four tests with
  `Credential environment variable 'OPENAI_API_KETEST_KEY' is not set`. Ink delivers a single stdin
  write as **one** `input` string, so a burst is handled as one keypress and deletes one character.
  The per-keystroke loop is required and now carries a comment saying so.
- Reducing `settle()` before covering every awaited boundary failed the staging assertion, because
  `/read` performs a real filesystem read through `stageDocument`. That is what drove adding
  `waitFor` at the staging and traversal boundaries instead of lengthening the sleep.

The leak fix was verified directly: forcing one assertion to fail produced exactly
`1 failed | 4 passed` with the run still terminating cleanly in 10.80 s, confirming the failed
test's Ink instance was unmounted and did not strand the remaining tests.

### Gates

```text
npm test --workspace @researk/cli -- tui-provider-integration.test.tsx   # passed: 5 tests, 10.80s
npm run build --workspace @researk/cli                                   # passed: exit 0
npm run typecheck --workspace @researk/cli                               # passed: exit 0
npm run lint                                                             # passed: 101 files
npm run format-check                                                     # passed: 101 files
npm test                                                                 # passed: 312 tests in 19 files
```

`npm run format-check` failed once after the edit, because Biome reflows an `it(...)` call that
gains a timeout argument; `npx biome format --write` on the single file resolved it and lint plus
the focused suite were re-run green afterward. Repository totals are unchanged at 312 tests in 19
files, with `@researk/cli` still 180 in 11 files: this work changed timing and cleanup only, and
added no tests. Environment: Node.js `v24.14.1`, npm `11.11.0`, Windows.

The macOS runner was not available to this session, so the platform-specific failure was reproduced
by measurement of the shared cost rather than observed directly. The margin table above is the
evidence: the fix removes the cause on every platform by cutting the fixed scheduling floor and
adding headroom, rather than by raising a timeout alone.

### Files changed

- `packages/cli/test/tui-provider-integration.test.tsx`
- `docs/HANDOFF.md`

## Previous milestone: macOS terminal-graphics CI failure fixed, with a corrected font policy

`packages/cli/test/terminal.test.ts` failed only on the macOS CI job while Linux and Windows passed.
The tests were not flaky: the CLI really did fall back to exact LaTeX on that host, through the
correct ADR 0006 path. The defect was in the renderer's rasterization step.

### Retraction of the earlier claim in this file

An earlier version of this section stated that **every** validated MathJax SVG is pure `<path>`
geometry, that font enumeration therefore could not affect any image, and that macOS system-font
enumeration "can consult network-backed font providers" and so violated ADR 0006's no-network rule.
**Both claims were wrong and are retracted.** They were generalized from a five-expression sample of
ordinary math and were never tested against text-bearing output, and the network claim was asserted
without evidence. The unconditional `loadSystemFonts: false` that shipped on that reasoning was
unsafe on its own, and has been replaced by the policy below.

Measured directly against this tree, MathJax with `fontCache: "none"` emits a real glyph run —
`<text ...>` inside an `<mtext style="font-family: serif">` — for at least:

| Expression | `<text>` | `font-family` | PNG identical with fonts on vs. off |
| --- | --- | --- | --- |
| `E = mc^2` | no | no | yes, byte-identical (sha `3f003fbb…`) |
| `\mbox{hello world}` | no | no | yes |
| `x = 中文` | yes | yes | **no**: 13244 B vs 6156 B |
| `x = 😀` | yes | yes | **no**: 18249 B vs 9653 B |
| `\frac{1}` (`merror`) | yes | yes | same bytes, but the text is invisible either way |
| `\notarealmacro{x}` (`merror`) | yes | yes | as above |

So the unconditional flag silently dropped CJK and emoji glyphs, and `merror` markers rasterize to a
solid `data-background` rectangle with no readable message regardless of the flag. Wrong and
incomplete graphics are exactly what ADR 0006 forbids.

### Root cause

`@resvg/resvg-js` defaults to loading system fonts, which is unbounded, host-dependent work charged
to the 1000 ms per-render ceiling. Measured on Windows with 537 installed fonts it cost ~430 ms of a
render whose actual rasterization is ~7 ms. A macOS runner carries far more font faces, so the first
PNG render crossed the ceiling, `render` rejected with `timeout`, `renderTerminalMath` returned
`false`, and the CLI emitted exact source, failing the graphics assertions on that job only. The
macOS runner was not available to this session, so the platform-specific timing was inferred from
this measured cost and reproduced locally by constraining the same production code path.

### Fix: a conditional, fail-closed font policy

`packages/latex-renderer/src/worker.ts` now branches before rasterizing, in the PNG path only:

- **Path-only SVG** (no `<text>`, no `font-family`): rasterize with `font: { loadSystemFonts: false }`.
  This is lossless — PNG output is byte-identical with enumeration on and off — and it removes the
  host-font enumeration entirely, which is the deterministic fix for the macOS timing.
- **Font-backed SVG** (any `<text>` element **or** any `font-family` reference): refuse. It does not
  load host fonts, and it does not emit a partial image. It throws `LatexSvgRenderError` with the
  in-contract `render_failed` code, so `renderTexToPng` rejects, `renderTerminalMath` returns
  `false`, and the CLI presents exact canonical LaTeX.

`font-family` is tested independently of `<text>` so a future MathJax revision that paints a
font-backed glyph through a different element still fails closed rather than rendering silently
incomplete output. The SVG path is untouched: `renderTexToSvg` still returns these expressions
normally, and only rasterization is refused.

No contract change was required. `render_failed` is already in `workerErrorCodes`, already maps to a
fixed pool-authored sentence in `describeWorkerError`, and the worker still replaces its own message
with the same redacted sentence, so no TeX, MathJax internal, or host path can reach a caller. The
protocol validator was not loosened and no allowed SVG content was broadened.

### Regression coverage: deterministic, not wall-clock

The previous two threshold assertions (`budget.renderTimeMs < renderTimeoutMs / 2`) were removed.
They asserted a host-speed property, would flake on a slow or loaded runner, and did not actually
test the policy. They are replaced by behavioral tests, all driving the real packaged renderer:

- `latex-renderer`: a PNG is produced only from an SVG containing `<path>` and no `<text>` or
  `font-family` — the invariant that makes disabling system fonts lossless.
- `latex-renderer`, 4 cases: `x = 中文`, `x = 😀`, `\frac{1}`, and `\notarealmacro{x}` each still
  render as SVG with font-backed text, and each rejects with `render_failed` from `renderTexToPng`.
- `latex-renderer`: a refusal does not poison the pool — the next PNG on the same budget succeeds.
- `latex-renderer`: the refusal message is exactly the redacted sentence and leaks no TeX marker,
  font, renderer name, or path separator.
- `cli`, 4 cases: the same four expressions produce exact canonical source with no `\u001b]1337;`
  sequence, with iTerm2 capability positively supported so this isolates the renderer decision.
- `cli`: `E = mc^2` still emits a real inline image end-to-end, asserted by decoding the base64
  payload and checking the PNG magic bytes and a >1 KiB size, so the fix did not disable graphics.
- `cli`: a failing rasterizer yields exact source; `renderTerminalMath` reports `false` rather than
  throwing; capability is a pure function of explicit stream and env input.

These were verified to fail as intended: neutering `requiresFontBackedText` to a constant `false`
fails 7 `latex-renderer` tests and 4 `cli` tests, then passes again when restored. The 7 are the
4 refusal cases plus the pool-reuse, worker-replacement, and redacted-message tests, all of which
depend on a refusal actually occurring.

The injectable `renderImage` seam on `renderTerminalMath` and `renderInteractiveEvents` is retained.
It defaults to the packaged `renderTexToPng`, so production behavior is unchanged when omitted, and
it lets protocol-shape tests inject a fixed 1x1 PNG without depending on native bindings.

### Worker lifecycle

Unchanged and re-verified, but an earlier version of this section described it incorrectly and that
description is **retracted**. It claimed the worker is "**not** replaced" on a refusal and that the
pool-reuse test asserts this. Neither is true. In `ManagedLatexRenderer.#run`, the `onMessage`
handler sets `replace = true` for **every** `type: "error"` response, so an in-contract
`render_failed` refusal replaces the slot's worker exactly like a protocol failure does. The
pool-reuse test asserts only that the pool stays usable — the next PNG on the same budget succeeds —
which it does *through* the replacement, not by avoiding it.

The corrected statement: a refusal is an ordinary in-contract render error for the *caller* — it
rejects with `render_failed` rather than `worker_failed`, and the budget and queue are unaffected —
while the *pool* still discards and re-warms the worker behind it. That is existing pool behavior
this work did not change and does not depend on; the refusal is raised inside the worker's normal
`try`/`catch`, so it travels the standard error-response path. The cost is one extra worker spawn
per refused expression, which is acceptable because a refusal is terminal for that expression: the
CLI falls back to exact source and does not retry.

Idle workers stay unreferenced and the existing lifecycle suites pass, so no thread outlives its
pool. The ~90 s `packages/cli` duration is Ink TUI tests, not the renderer; the whole
`latex-renderer` package runs in ~3.3 s.

### Gates

```text
npm run clean                                      # passed: 7 workspace packages
npm run build                                      # passed: 7 workspace packages
npm run typecheck                                  # passed: 7 workspace packages
npm test                                           # passed: 312 tests in 19 files
npm run lint                                       # passed: 101 files
npm run format-check                               # passed: 101 files
git diff --check                                   # passed: no whitespace errors
```

Per-package totals behind the 312: `@researk/cli` 180 in 11 files (was 168 before this work),
`@researk/latex-renderer` 97 in 3 (was 76), `@researk/provider-openai-compatible` 12,
`@researk/contracts` 10, `@researk/harness` 7, `@researk/provider-openrouter` 4, and
`@researk/research` 2. Environment: Node.js `v24.14.1`, npm `11.11.0`, Windows.

The `latex-renderer` count includes the structural-metadata suite: a 9-case table asserting
`hasTextElement`/`hasFontFamily` straight off the validator, a 3-case table proving
`x_{font-family}`, `\frac{font-family}{2}`, and `\mbox{font-family: serif}` still rasterize, a
4-case table proving CJK, emoji, and both `merror` markers are refused, and an explicit worker
replacement test.

Both directions of the decision were verified by mutation. Forcing `requiresFontBackedText` to
always refuse fails 6 `latex-renderer` tests and 6 `cli` tests; restoring the *old whole-string*
test — `/<text|font-family/` over the serialization — fails exactly the 3 `font-family`-echo
rasterization cases, which is the regression this work removes. Neither mutation survives.

Note for future sessions: `tsc -b` did not rebuild `dist` after a source file was restored to an
earlier mtime, which briefly produced stale-artifact test failures. `npm run clean` before
`npm run build` resolves it when a file is reverted rather than edited forward.

### Known limitation

Display math containing CJK, emoji, or other non-math-font text, and any MathJax error marker, is
never shown graphically on any platform — it always falls back to exact source. This is a deliberate
correctness choice, not a defect. Rendering it properly would require bundling a licensed text font
in the renderer and passing it to resvg explicitly as `fontFiles`/`defaultFontFamily`, which stays
host-independent; that is the natural follow-up if graphical text is wanted later.

## Previous verified state: full gate set green after the carriage-return display fix

An independent final verification pass ran the complete required gate set against the working tree
as it stands, after the carriage-return display fix described below. Every gate passed and no
implementation change was required. These counts are historical: they predate the macOS
terminal-graphics fix above, which is now the authoritative state at 312 tests.

```text
npm run clean                                      # passed: 7 workspace packages
npm run build                                      # passed: 7 workspace packages
npm run typecheck                                  # passed: 7 workspace packages
npm test                                           # passed: 279 tests in 19 files
npm run lint                                       # passed: 101 files
npm run format-check                               # passed: 101 files
git diff --check                                   # passed: no whitespace errors
node packages/cli/dist/bin.js help                 # passed: exit 0
node packages/cli/dist/bin.js version              # passed: exit 0, 0.1.0-alpha.1
node packages/cli/dist/bin.js doctor --json        # passed: exit 0, telemetry false
"" | node packages/cli/dist/bin.js                 # passed: exit 2, non-TTY guard on stderr
fake-TTY dist/tui.js lifecycle                     # passed: enter/exit/cursor restored, exit 0
```

Per-package totals behind the 279: `@researk/cli` 168 in 11 files, `@researk/latex-renderer` 76 in
3, `@researk/provider-openai-compatible` 12 in 1, `@researk/contracts` 10 in 1, `@researk/harness` 7
in 1, `@researk/provider-openrouter` 4 in 1, and `@researk/research` 2 in 1. Within `@researk/cli`:
`tui-app` 62, `tui-state` 25, `tui-controller` 24, `parser` 15, `runtime` 15, `io` 8, `terminal` 5,
`tui-provider-integration` 5, `workspace` 4, `safety` 3, and `theme` 2.

`git diff --check` was run with untracked files added as intent-to-add so the new `src/tui/` and
`test/tui-*` files were actually inspected; `git diff --cached --check` was run too, and the index
was restored to its exact prior state afterward and confirmed byte-identical to the pre-check
`git status --porcelain` snapshot. Environment: Node.js `v24.14.1`, npm `11.11.0`, Windows.

The fake-TTY check drove the built `dist/tui.js` through a TTY-shaped stream pair and asserted
`\u001b[?1049h` on mount, a non-empty painted frame, `\u001b[?1049l` after an idle Ctrl+C with the
enter preceding the exit, a cursor-show following the last cursor-hide, exit code 0, and empty
stderr. The driver was kept outside the repository, so the tree is unchanged by verification.

One discrepancy was found and is recorded under current limitations rather than silently fixed: the
repository carries tag `v0.1.0-alpha.2` while every workspace manifest is still `0.1.0-alpha.1`.

## Completion pass: reviewed TUI fixes implemented and validated

The four reviewed fixes below are implemented and validated in `packages/cli`. At that pass
`@researk/cli` was 165 tests in 11 files (was 136) and the repository suite was 276; both counts are
superseded by the verified state above, which is authoritative. Every gate passed:

```text
npm run clean                                      # passed: 7 workspace packages
npm run build                                      # passed: 7 workspace packages
npm run typecheck                                  # passed: 7 workspace packages
npm test                                           # passed: 276 tests (historical; now 279)
npm run lint                                       # passed: 101 files
npm run format-check                               # passed: 101 files
git diff --check                                   # passed: no whitespace errors
node packages/cli/dist/bin.js help                 # passed: exit 0
node packages/cli/dist/bin.js version              # passed: exit 0, 0.1.0-alpha.1
node packages/cli/dist/bin.js doctor --json        # passed: exit 0, telemetry false
"" | node packages/cli/dist/bin.js                 # passed: exit 2, non-TTY guard
fake-TTY dist/tui.js lifecycle                     # passed: enter/restore/render, exit 0
```

**Exception-safe chat lifecycle.** `TuiController.runChat` performed Harness resolution, canonical
model parsing, prompt composition, and request validation *before* its `try`, so any of those
failures rejected out of `runChat`. `App` awaited it without a `catch` or `finally`, so a setup
failure left `activeRun` populated, the assistant placeholder stranded, and `runStatus` stuck off
idle: the session was wedged and the alternate screen hid the rejection. Both layers are now guarded.
All pre-stream work moved inside the controller's `try`, which converts a setup failure into the same
sanitized `error` + `cancelled`/`failed` outcome a mid-stream failure produces, and honors an already
aborted signal as cancellation rather than failure. `App` wraps the await in `try/catch/finally`: the
error is reported through `safeErrorMessage` with the live secret set, and the `finally` always
clears `activeRun`, finishes the placeholder when text arrived or removes it when nothing streamed,
and returns `runStatus` to idle. Nine tests cover it across both layers, including that the next
interaction succeeds after a failure and that idle Ctrl+C then exits instead of trying to cancel.

**`/source` is fully navigable.** The overlay rendered `slice(0, 200)`, so line 201 onward of a long
response was unreachable and the truncation was silent. It is now a bounded viewport with
Up/Down, PageUp/PageDown, Home, and End over every retained line, a `lines X-Y of N` status, and
explicit above/below indicators. The page size is derived from the real render height, the offset is
clamped to `max(0, total - page)`, and the offset resets when the overlay opens. Two interaction
tests drive a 260-line response and a 240-line response whose final line is unique, paging until the
range stops advancing, which proves both clamping and that the last line is reachable without
depending on a magic press count.

**Canonical source versus safe display.** The retained canonical text and what Ink renders are
separate by construction, which is what lets both invariants hold at once. `ConversationEntry.source`
and `latestAssistantSource` keep redacted canonical Markdown/LaTeX for future export: streamed deltas
pass `StreamingSecretRedactor` first, so a credential split across chunk boundaries is destroyed
before anything retains it and is never recoverable from the canonical copy. Raw C0/C1 bytes are
deliberately *not* stripped there, because doing so would silently corrupt canonical output. Display
is a projection built by `displayText` at the rendering boundary, so those controls are escaped to
visible text and are never active in a frame, while the canonical copy keeps the exact bytes an
export needs. The field comments in `state.ts` state which side each value belongs to, and the
controller documents that `delta` alone carries canonical source while every other event field is
already neutralized. Two combined tests stream LaTeX, a secret split across chunks, and OSC / BEL /
C0 controls in one response, then assert the exact ordinary LaTeX survives byte-for-byte in `/source`,
that no fragment of the secret appears in any frame, and that no active control byte reaches the
terminal - in the conversation view as well as in the overlay, so `/source` is not the only path
checked.

**Housekeeping.** `test/runtime.test.ts` had a UTF-8 BOM, which is removed. Stale provider-connect
completion was re-inspected and needs no further change: the connect handler claims a generation per
attempt and only the newest attempt may write a result, so a late reply from a superseded endpoint
cannot overwrite the chosen connection, catalog, or credentials, and a failure path reports the
redacted error instead of a success notice. No line-scroll redesign was undertaken.

Each fix was confirmed load-bearing by reverting it and observing the new tests fail: restoring the
200-line cap fails five source-overlay tests including both paging tests, making `displayText` the
identity fails the combined test, dropping streaming redaction fails both combined tests, and
hoisting setup back out of the controller's `try` fails three controller tests and, once App's guard
is also removed, five App tests.

## Follow-up fix: the TUI display projection neutralizes carriage returns

The reviewer's remaining non-blocking display-safety finding is addressed in `packages/cli`. A bare
U+000D survived to the terminal, so untrusted model or source text containing `SAFE-PREFIX\rSPOOFED`
returned the cursor to column zero and drew `SPOOFED` over `SAFE-PREFIX`. The user was then shown a
line the response never actually stood behind, which is a display-spoofing primitive even though it
executes nothing.

The cause is that `escapeUnsafeTerminalControls` deliberately preserves tab, carriage return, and
line feed. That is load-bearing for the *one-shot* path, where its output is fed to
`IncrementalMarkdownMathParser`, which strips a trailing `\r` to normalize CRLF fenced-block lines.
Escaping U+000D there would change parser and CRLF semantics, so the shared helper is unchanged.

The fix is a display-only second pass, `neutralizeCarriageReturnsForDisplay` in `src/safety.ts`,
applied by `displayText` in `src/tui/state.ts` after the shared escape. Nothing drawn through
`displayText` reaches the one-shot parser, so this is the correct boundary: `\r\n` collapses to the
`\n` that already ends the line, which is what a terminal shows anyway, and a bare `\r` becomes a
visible `\u{000d}`. Line structure is preserved, tabs and newlines still pass through as layout, and
only cursor repositioning is removed. Canonical source is untouched, so `ConversationEntry.source`
and `latestAssistantSource` keep the exact bytes `/source` pages over and a future export needs.

Three regression tests cover it. Two in `test/tui-app.test.tsx` drive a real streamed response
through `/source`: one asserts that `SAFE-PREFIX\rSPOOFED` renders as `SAFE-PREFIX\u{000d}SPOOFED`
with both halves still visible and that no frame in the session contains a raw `\r`; the other
asserts a CRLF stays a line break while a bare `\r` beside a tab is escaped, so layout is unaffected.
One in `test/parser.test.ts` pins the split explicitly: `escapeUnsafeTerminalControls` still returns
the carriage return unchanged for the parser, while the display projection escapes it. Both TUI tests
were confirmed load-bearing by making `displayText` the plain shared escape again and observing them
fail on the raw `\r` assertion.

Validation actually run for this change:

```text
npm test --workspace @researk/cli                  # passed: 168 tests in 11 files (was 165)
npm run typecheck --workspace @researk/cli         # passed: tsc --noEmit clean
npm run lint                                       # passed: 101 files
npm run format-check                               # passed: 101 files
```

The independent verification pass recorded above re-ran the complete gate set against this fix and
confirmed those counts at the time: `@researk/cli` was 168 tests in 11 files and the repository suite
279 in 19 files, with all six npm gates, `git diff --check`, the four CLI smoke checks, and the
fake-TTY lifecycle green. The macOS terminal-graphics fix has since raised those to 180 and 312.

## Earlier verification pass: four TUI defects found and fixed

An independent verification pass ran the gate set against the Ink TUI and found four real defects
that the previous 127-test suite did not cover. All four are fixed in `packages/cli`, each with a
regression test that was confirmed load-bearing by reverting the fix and observing the failure.

The suite is now 136 tests in 11 files for `@researk/cli` (was 127), and the full gate set is green:

```text
npm run build                                      # passed: 7 workspace packages
npm run typecheck                                  # passed: 7 workspace packages
npm test --workspace @researk/cli                  # passed: 136 tests in 11 files
npm run lint                                       # passed: 101 files
npm run format-check                               # passed: 101 files
node packages/cli/dist/bin.js help                 # passed: exit 0
node packages/cli/dist/bin.js version              # passed: exit 0, 0.1.0-alpha.1
"" | node packages/cli/dist/bin.js                 # passed: exit 2, non-TTY guard
```

**Concurrent runs, the most serious defect.** Pressing Enter while a response was streaming started
a second Harness run and overwrote the single `activeRun` slot. A driven test measured
`starts=2 aborted=[false,true]`: two live runs, and a subsequent Ctrl+C aborted only the second,
orphaning the first with no way to cancel it. `submitComposer` now refuses to start a prompt unless
`runStatus` is `idle`, and `submitPrompt` re-checks the slot before claiming it. Slash commands are
deliberately still accepted while streaming, because they never start a run.

**Cursor position was not rendered.** The composer always drew the cursor block after the entire
value, so Left/Right arrows updated `composer.cursor` invisibly and mid-string editing gave no
feedback. The block is now drawn at the actual offset, preserving the character under it.

**Scrollback ran past the transcript.** `scroll/by` was clamped only at zero, so holding PageUp
drove `scrollOffset` arbitrarily high; with one entry it reached 500. The conversation window then
rendered empty while reporting nothing hidden in either direction. The offset is now clamped to the
retained entry count, so the oldest message stays reachable.

**`/commands` was unreachable.** The `commands` overlay, its reducer case, and `CommandOverlay` were
fully implemented, but nothing opened it: no key binding, and no entry in `SLASH_COMMANDS`, so it was
absent from discovery and from the help overlay. `/commands` is now a real command routed to that
overlay. Selecting `/commands` from inside the overlay closes it rather than reopening it.

Safety boundaries were re-inspected and are unchanged by these fixes: streamed text still passes
`StreamingSecretRedactor` before `safeTerminalText`, notices are neutralized before reaching Ink,
entered API keys stay in the ephemeral credential map and are masked, and canonical assistant source
is still stored byte-exact. Backend behavior, the controller, and the one-shot paths were not
modified; every change is in `App.tsx`, `Composer.tsx`, `reducer.ts`, and `commands.ts`.

## Previously recorded state: full gate set green after the full-screen TUI replacement

The complete required gate set was run against the current working tree after the readline REPL was
replaced with an Ink full-screen TUI. Every gate passed. The counts below are historical and predate
the passes above; the authoritative `@researk/cli` count is now 168.

```text
npm install                                        # passed: lockfile updated for ink/react
npm run clean                                      # passed: 7 workspace packages
npm run build                                      # passed: 7 workspace packages
npm run typecheck                                  # passed: 7 workspace packages
npm test                                           # passed: 238 tests in 19 files
npm run lint                                       # passed: 101 files
npm run format-check                               # passed: 101 files
git diff --check                                   # passed: no whitespace errors
```

Per-package test totals behind the 238: `@researk/cli` 127 in 11 files (now 136; see the
verification pass above), `@researk/latex-renderer` 76
in 3 files, `@researk/provider-openai-compatible` 12 in 1, `@researk/contracts` 10 in 1,
`@researk/harness` 7 in 1, `@researk/provider-openrouter` 4 in 1, and `@researk/research` 2 in 1.
`git diff --check` was run with the untracked files added as intent-to-add so they were actually
inspected; the index was restored afterward.

Distribution was re-verified because the TUI adds runtime dependencies: `npm run pack:standalone`
resolved a conflict-free closure including `ink@7.1.1`, `react@19.2.8`, `yoga-layout`, and the
existing
renderer packages, and `scripts/smoke-standalone-cli.mjs` installed the resulting tarball into an
empty global prefix and ran `help` and `version` successfully from an unrelated working directory.

## Completed milestone: argument-less `researk` is a full-screen alternate-screen TUI

The readline REPL is deleted. `packages/cli/src/repl.ts` is gone and an argument-less TTY invocation
now mounts an Ink application that owns the alternate screen for the whole session. One-shot
commands are untouched: `chat`, `models`, `doctor`, `help`, `version`, `--raw`, `--json`, and the
non-TTY guard all keep their previous behavior and exit codes, and the existing one-shot Markdown
and iTerm2 math renderers are still used by those paths.

Ink 7.1.1 and React 19.2.8 were selected, both pinned exactly to match the repository's dependency
convention. The package builds TSX through the existing TypeScript project
references with `"jsx": "react-jsx"` scoped to `@researk/cli`, so no bundler was introduced.

The presentation boundary in ADR 0002 is preserved. No component performs provider I/O; every
execution path goes through the Harness controller, and provider adapters stay behind it. The TUI
holds one typed state tree reduced by pure transitions, covering connection, catalog, selected
model, variant, theme, messages with canonical source, overlay, composer, streaming status,
workspace and staged documents, and errors.

Variant is provider-driven. Available reasoning intents are derived from the selected
`ModelDescriptor` capabilities rather than a hardcoded per-provider table, so a model exposing no
reasoning support yields only the neutral intent and `/variant` reflects that.

Safety carried over intact rather than being reimplemented. `StreamingSecretRedactor` still runs
first on streamed text so a credential split across chunk boundaries cannot be reconstructed, and
its retained-prefix state is per-run. Everything reaching Ink is neutralized first: assistant text,
provider catalog metadata, diagnostics, and error text, so no active `ESC`, `BEL`, or C0 byte can
reach the terminal through a component. Entered API keys stay in an ephemeral in-memory credential
map, are masked in the form, and are never written to state that renders, to history, or to disk.
Workspace boundary checks and bounded staged-document behavior are reused from the existing helpers,
and history and message sizes remain bounded.

Conversation rendering classifies normal Markdown, fenced code, citations, inline math, display
math, and tool/research output. Canonical source is stored unchanged and display math is visually
separated as exact source; no terminal graphics protocol is emitted inside the Ink layout, which
would corrupt the retained frame. This is the source-oriented view ADR 0006 explicitly permits, and
`/source` reveals the exact retained canonical text.

`/provider` offers only the two adapters the CLI actually implements, OpenRouter and
OpenAI-compatible. It is a keyboard picker followed by an in-TUI form with Tab/Shift+Tab field
movement, a default OpenRouter base URL, a required base URL for the compatible adapter, and a
masked key field. `/model` is a searchable list over the live catalog, `/themes` applies a semantic
palette immediately, and `/help`, `/clear`, `/exit`, and `/read` complete the set. Themes are
consumed only as semantic tokens (background, foreground, muted, border, accent, success, warning,
error, userMessage, assistantMessage, toolMessage); components carry no scattered raw colors.

Ctrl+C cancels an active run through the existing abort path and keeps the app mounted; pressing it
while idle exits cleanly. Streaming updates the assistant message in place, and the view follows the
stream unless the user scrolls with PageUp/PageDown.

Terminal restoration was proven against the real built binary, not only in tests, because
alternate-screen and raw-mode lifecycle is not observable through `ink-testing-library`. Driving
`dist/tui.js` with a fake TTY confirmed `\u001b[?1049h` on mount and `\u001b[?1049l` on exit, and a
second run confirmed idle Ctrl+C exits 0 and still leaves the alternate screen.

Test coverage replaced the obsolete REPL tests with `tui-state`, `tui-controller`, `tui-app`, and
`tui-provider-integration` suites: slash routing and discovery, provider form semantics, searchable
model selection, provider-derived variants, theme token application, streaming chunk updates with
canonical LaTeX retention, errors surfaced in state and UI, Ctrl+C cancel versus idle exit,
scrolling, alternate-screen lifecycle, and credential non-leakage. Snapshot-only assertions were
avoided in favor of behavioral ones.

Two stale artifacts were also corrected: the now-dead `REPL_HELP` constant was removed from
`packages/cli/src/help.ts`, since it documented commands that no longer exist, and the top-level
help text no longer describes the argument-less mode as a line-oriented interactive CLI.

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
`closeManagedLatexRenderer()` provides deterministic shutdown for long-lived hosts and is called at
session end by the interactive CLI session (now the Ink TUI); it also resets the shared pool so a
later render reopens it.

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
- `@researk/cli`: help, version, doctor, models, chat, in-process Harness connection, the Ink
  full-screen TUI for argument-less TTY invocation, raw and JSON output, and safe exact-source LaTeX
  handling. The offline fake adapter is available for Harness-level tests, but the CLI does not
  expose a fake-provider mode.

## Verified review state

Changes from the independent review and interactive CLI/rendering work are integrated in the shared
working tree and have passed the full verification set.

The CLI command parsing, `--json` and `--raw` exclusivity, exit codes, redaction, provider behavior,
approval callback, abort forwarding, the interactive TTY session, guided selection, and exact-source
output paths are covered by the current passing tests. Ephemeral guided credentials are masked,
remain memory-only, and are included in output/error redaction.

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
- Version metadata is inconsistent with the tags. Tag `v0.1.0-alpha.2` exists, but the root and all
  workspace manifests are still `0.1.0-alpha.1`, so `researk version` reports `0.1.0-alpha.1`. This
  was found during verification and deliberately left unchanged, because correcting it is a release
  decision rather than a gate failure. Resolve it before the next release, and note that
  `npm run release:verify-version` is the check that should be reconciled with the intended version.
- Only the OpenRouter and generic OpenAI-compatible adapters are exposed through the CLI and the
  TUI `/provider` picker. Native OpenAI and Anthropic adapters do not exist and are deliberately not
  offered in the picker. An offline fake adapter exists for Harness-level tests only; the CLI does
  not support `RESEARK_FAKE_PROVIDER` or `fake:paper` smoke runs.
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
  positively detected. Rasterization is restricted to path-only MathJax output and runs with resvg
  system-font loading disabled, which is lossless for that content and keeps the image independent
  of host font state. An SVG carrying `<text>` or `font-family` — CJK, emoji and other non-math-font
  characters, and every MathJax error marker — is refused rather than rasterized incompletely. That
  decision reads structural facts recorded by the SVG validator's single parse — an actually parsed
  `<text>` element, an actual `font-family` attribute, or an actual `font-family:` declaration in an
  actual `style` attribute — never a substring scan of the serialization, because every element's
  `data-latex` attribute echoes caller TeX verbatim and a string test would refuse valid math such
  as `x_{font-family}`.
  Exact LaTeX source remains the fallback for unsupported, inaccessible,
  non-TTY, font-backed, and rendering-error paths. Kitty graphics support is not implemented because
  its bounded query/reply capability broker is still missing; Sixel and other terminal graphics
  protocols remain unsupported as well. Full-document TeX compilation, external renderer
  executables, and arbitrary TeX packages remain out of scope.
- Scholarly web tools and isolated paper-reproduction execution are not implemented.
- The TUI conversation view is source-oriented. Display math is shown as separated exact LaTeX rather
  than as an inline image, because emitting a terminal graphics protocol inside a retained Ink frame
  corrupts the layout. The iTerm2 graphics path remains available in the one-shot `chat` renderer.
- TUI verification uses `ink-testing-library` for components and controllers plus fake-TTY runs
  against the built binary for alternate-screen and Ctrl+C lifecycle. There is no real-terminal
  end-to-end harness, so terminal-specific key encodings beyond those covered by the input tests are
  not exercised automatically.

## Exact next task

The full-screen TUI milestone, the four reviewed TUI fixes, the carriage-return display fix, and the
macOS terminal-graphics fix with its corrected font policy are all complete, and the tree is green
under the full gate set; nothing from them is left unfinished. Proceed to the versioned
model-catalog cache and CLI capability filters. The TUI already has the
natural seams for it: `TuiController.refreshCatalog` is the single catalog entry point and
`catalogLoading` / `catalog` already exist in the state tree, so a cache belongs behind the
controller rather than in a component.

Preserve the verified boundaries when doing so: the Harness stays the execution authority, no
component performs provider I/O, streamed text keeps passing through `StreamingSecretRedactor`
before neutralization, everything rendered stays terminal-neutralized, entered credentials stay
ephemeral, and canonical assistant source stays byte-exact.

Before completing the next milestone, run:

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
supported by the current CLI and must not be used as smoke commands. The argument-less TUI cannot be
smoke-tested by piping, because it correctly refuses to start without a TTY; drive `dist/tui.js`
with a fake TTY stream pair instead, as was done to verify alternate-screen entry and restoration.

If the TUI runtime dependencies change, re-run `npm run pack:standalone` and
`scripts/smoke-standalone-cli.mjs`, because the standalone packer rejects a runtime closure that
resolves two versions of the same package.

Record the final test and file counts only after these commands pass.

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

## 2026-08-10 alpha.4 formula/TUI documentation milestone

Documented the completed `0.1.0-alpha.4` formula and full-screen TUI behavior while preserving all
prior handoff history.

### Integrated behavior recorded

- The argument-less TUI indexes assistant formulas from canonical source. Inline formulas are
  promoted to dedicated rows, and inline/display previews use restricted local MathJax 4 → SVG →
  resvg at fixed 2× scale with opaque-white PNG/RGBA output. Rendering performs no system-TeX,
  network, file, shell, or helper-executable work.
- Retained TUI graphics are emitted outside Ink after the matching frame flush. Pre-frame cleanup,
  generation checks, terminal dimensions, clipping, scroll/resize handling, and stream failures
  leave the exact source visible when a placement is not provably safe. Kitty requires an explicit
  bounded query `OK`; Windows Terminal Sixel requires its `WT_SESSION` hint, DA1 parameter 4, and a
  proven cell-pixel response. One-shot iTerm2 remains display-math support only.
- `/formula` supports keyboard navigation, bounded OSC 52 copy of exact canonical source, local
  draft edit/rerender, source toggling, and insertion of edited or canonical source. Assistant and
  persisted session source remain immutable; no CAS simplify/differentiate operations are claimed.
- TUI provider profiles, non-secret configuration, and sessions persist locally; credentials remain
  ephemeral through environment-variable references because the OS credential backend is still
  absent. README host notes link the official VS Code image/GPU and Windows ConPTY guidance without
  promising every terminal version or profile.

### Documentation files

- `README.md`
- `CHANGELOG.md`
- `docs/CLI_RENDERING.md`
- `docs/VISION.md`
- `docs/HANDOFF.md`

### Focused validation already passed

```text
npm test --workspace @researk/cli -- rendering-kitty.test.ts rendering-sixel.test.ts rendering-terminal-query.test.ts tui-clipboard.test.ts tui-formulas.test.ts tui-formula-renderer.test.ts tui-formula-overlay.test.tsx tui-graphics.test.tsx  # 8 files, 71 tests
npm test --workspace @researk/latex-renderer                                                                                                      # 3 files, 115 tests
npm run build --workspace @researk/cli
npm run typecheck --workspace @researk/cli
npm run release:verify-version -- --tag v0.1.0-alpha.4                                                                                           # 7 public packages
```

Markdown link targets were inspected against the official VS Code terminal documentation. At the
time of this earlier documentation pass, the independent review and final full workspace gate set
were still pending; the 2026-08-11 alpha.4 completion milestone below supersedes that status.
Manual real-terminal visual smoke also remains relevant: exercise Kitty in a recent VS Code
terminal with image/GPU support and the documented Windows ConPTY DLL setting when needed, and
exercise Windows Terminal Sixel only on a terminal that actually advertises it.

## 2026-08-11 alpha.4 completion milestone

The final alpha.4 formula, graphics, terminal-convergence, verification, and standalone packaging
pass is complete. Independent formula, graphics, and terminal convergence reviews passed, including
exact reproduction of the replay-cap boundary for both APC and CSI candidates.

### Formula and source boundary

- Formula workspace operations are implemented: keyboard navigation, bounded OSC 52 copy of exact
  canonical source, local draft edit/rerender, source toggling, and insertion of either the edited
  draft or original canonical formula.
- Assistant and persisted session source remain immutable. This milestone makes no CAS
  simplify/differentiate claim.

### Verification and packaging

- The single `npm run verify` invocation reached lint only after build, all workspace typechecks, and
  all workspace tests had succeeded. The test run passed 39 files / 626 tests: CLI 31/474; contracts
  1/10; harness 1/7; latex-renderer 3/117; provider-openai-compatible 1/12; provider-openrouter 1/4;
  research 1/2.
- Lint then found only two test-only control-character regex errors. Those errors were fixed, the
  changed Conversation suite passed 12/12, and subsequent full workspace lint and format-check
  passed. The original `npm run verify` invocation therefore did not exit zero; the required gates
  were green after the targeted test fixes.
- `npm run release:verify-version -- --tag v0.1.0-alpha.4` passed for all 7 public packages.
- The standalone `0.1.0-alpha.4` tarball and SBOM were built with 67 bundled packages, installed and
  smoked offline from an unrelated directory, and passed `help` and `version`. Nothing was
  published.

### Remaining handoff item

Manual visual smoke in a real Kitty/VS Code terminal and Windows Terminal Sixel remains outstanding:
this environment has no supported interactive real TTY, so those checks could not be run here.
