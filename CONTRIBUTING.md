# Contributing to Researk

Thank you for helping build Researk. The project is pre-alpha. A runnable source build and test
suite exist, but there is no installable release or compatibility guarantee.

## Before opening an issue

- Search existing issues first.
- Report suspected vulnerabilities privately through [SECURITY.md](SECURITY.md).
- Do not attach credentials, unpublished manuscripts, private research data, restricted datasets,
  or provider transcripts.
- Include only papers, data, code, and fixtures you have the right to redistribute. Prefer
  synthetic, public-domain, or explicitly licensed fixtures.

## Development setup

Use Node.js 24 and npm 11. The repository uses npm workspaces, TypeScript project references,
Vitest, and Biome.

```bash
npm install
npm run build
npm run typecheck
npm test
npm run lint
npm run format-check
```

Run a workspace check when a change is isolated to one package. For example:

```bash
npm run typecheck --workspace @researk/cli
npm test --workspace @researk/cli
```

After `npm run build`, smoke-test CLI commands that do not require a configured provider.
PowerShell:

```powershell
node packages/cli/dist/bin.js help
node packages/cli/dist/bin.js version
node packages/cli/dist/bin.js doctor --json
```

The offline fake adapter is for Harness-level tests; the CLI does not support
`RESEARK_FAKE_PROVIDER` or `fake:paper`. Test `models` and `chat` only against a configured endpoint
you control.

## Pull requests

Keep changes focused. Explain the problem and intended behavior. Update relevant documentation
and tests when behavior changes. New dependencies need a clear purpose, maintained provenance,
and a license compatible with Apache-2.0 distribution. Contributors remain responsible for
reviewing and testing AI-assisted material and for having the right to contribute it.

The implementation must preserve these project boundaries:

- local-first operation and no telemetry;
- external access only through explicitly selected provider, research, or tool adapters;
- credentials kept separate from configuration and session data;
- provenance-aware research and citation verification;
- untrusted web content, papers, repositories, and datasets never granting tool permissions;
- downloaded research code never executing automatically or directly on the host; and
- source-preserving, non-executing LaTeX rendering by default.

Do not describe the generic OpenAI-compatible adapter as verified native provider support. Test
network-dependent changes against an endpoint you control, and redact endpoint data and
credentials from fixtures and logs.

## Developer Certificate of Origin

Researk uses the [Developer Certificate of Origin 1.1](DCO.md), not a contributor license
agreement. Sign off every commit:

```bash
git commit --signoff
```

The sign-off adds a line in this form using your real name and a reachable email address:

```text
Signed-off-by: Your Name <you@example.com>
```

By adding it, you certify the statements in the DCO. To add a missing sign-off to your most recent
local commit, use `git commit --amend --signoff` and update the pull request branch.

## Review

Maintainers may request design discussion before accepting large changes. A pull request is ready
when its scope is clear, documentation is accurate, security and privacy effects are addressed,
required checks pass, and every commit has a valid DCO sign-off.

All accepted contributions are licensed under the [Apache License 2.0](LICENSE).
