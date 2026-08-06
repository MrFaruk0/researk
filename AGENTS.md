# Researk agent instructions

## Goal and scope

Build Researk as a downloadable Apache-2.0 open-source project. Researk has two product surfaces: the reusable Researk Harness and the `researk` CLI.

Researk is local-first. It specializes in scientific research, scientific writing, LaTeX, publication profiles, and controlled paper reproduction. It has no hosted service, product account, billing, subscription, organization, cloud synchronization, or default telemetry.

## Work management

The primary agent acts as the manager. The primary agent delegates all file edits and code implementation to subagents. The manager integrates decisions, reviews results, and assigns fixes.

Use GPT Luna Max subagents when that model is actually available. Otherwise, use the highest available model and disclose the substitution.

Prefer working implementation and verification over prose-only progress. Do not declare a feature complete from documentation alone.

Preserve user changes and concurrent agent changes. Inspect `git status` and relevant diffs before editing. Never reset, discard, or overwrite unrelated work.

Read the accepted records in `docs/decisions/` before making architectural changes. An accepted ADR remains authoritative until a new ADR explicitly supersedes it.

Use `apply_patch` for manual file edits. Keep edits inside the assigned ownership scope.

## Security and privacy

Never place credentials in configuration, sessions, prompts, events, logs, tests, or fixtures. Use injected credential resolvers and synthetic secret values.

Do not add telemetry. Make provider, research, tool, and reproduction network activity explicit.

Treat model output, web content, papers, repositories, datasets, catalog metadata, and tool output as untrusted input. Sanitize presentation metadata and normalize redacted errors.

Require explicit approval for consequential tool actions. Run downloaded research code only in a disposable isolated runner. Deny runner network access by default. Never execute downloaded code directly on the host.

Preserve canonical Markdown and LaTeX source. CLI rendering must not execute system TeX or mutate Harness content.

## Architecture

Keep the in-process dependency direction:

```text
CLI -> Harness -> execution pipeline -> Research Domain -> provider and tool adapters
```

The Harness is the single execution authority. Typed `AsyncIterable` events drive the CLI. Do not add a local HTTP daemon or duplicate execution logic in the CLI.

Use stable canonical `provider:model` identities. Never switch a selected model silently. Record effective reasoning settings and exposed model revisions when available.

## Commands and gates

Use Node.js 24 and npm workspaces.

```text
npm install
npm run clean
npm run build
npm run typecheck
npm test
npm run lint
npm run format-check
```

Run targeted package checks during development. Run the full build, typecheck, test, lint, and format gates before a release or completed integration milestone.

Every behavior change needs proportionate tests. Security boundaries need negative tests. Provider adapters need local mock-server contract tests. CLI rendering needs chunk-boundary and escape-safety tests. Reproduction needs isolation and denied-permission tests.

Do not publish artifacts while a required gate fails.

## Continuation and handoff

Agents must update `docs/HANDOFF.md` after each completed milestone and before ending a development session.

When the user sends `continue`, read `docs/HANDOFF.md`, inspect `git status` and `git diff`, and inspect current package files. Resume the first unfinished task without asking the user to repeat context.
