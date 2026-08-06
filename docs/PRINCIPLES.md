# Engineering principles

These principles guide decisions when the specification does not already decide them.

## 1. Research and scientific writing first

Core work must serve literature research, evidence and citation management, manuscript planning, writing, analysis, revision, publication formatting, LaTeX, or paper reproduction. General chat features do not belong in the Research Domain unless they directly support those workflows.

## 2. Open, local-first, and user-owned

Researk is an Apache-2.0 open-source Harness and CLI. Workspaces, sessions, and derived state remain local by default. There is no Researk account or telemetry by default. External model and research adapters are allowed only when configured, and their data boundaries must be visible.

## 3. Harness over hidden prompting

Planning, retrieval, evidence assembly, state, tool use, prompt compilation, generation, and verification belong to inspectable Harness contracts. Prompt engineering may be used, but it is not the product and must not hide consequential behavior from the user.

## 4. Evidence before fluency

Never invent a citation or represent an unchecked claim as verified. Research output must retain stable source identifiers, URLs or DOIs when available, access dates, and claim-to-source provenance. Conflicts, missing evidence, inaccessible material, and verification limits remain visible.

## 5. Retrieve selectively; preserve traceability

Select relevant source material, deduplicate it, and compress only when necessary. Do not silently truncate or summarize away material constraints. Derived context points back to its source, and user files—not an index or model-generated representation—remain authoritative.

## 6. Research standards are data, not string templates

The semantic manuscript model is separate from citation/style formatting and export. Publication profiles are extensible, testable descriptions of rules. APA 7 and IEEE are the initial planned profiles, implemented in a standards-based CSL/citeproc-style direction rather than hand-built citation strings.

## 7. LaTeX has two distinct paths

LaTeX authoring, validation, and export are Research Domain capabilities. Mathematical visualization in a terminal is a CLI presentation concern. Canonical source is never replaced by a visual approximation, and full/system TeX execution is never an implicit rendering step.

## 8. Capability-aware portability

Models, providers, tools, operating systems, and terminals differ. Adapters declare capabilities; the Harness selects only supported behavior or returns an actionable limitation. “Provider agnostic” means a stable boundary and graceful capability negotiation, not identical features everywhere.

Model identity and effective reasoning settings are provenance. Live catalogs may be cached for offline use, but catalog data is untrusted, custom/local endpoints retain distinct identities, and no adapter may switch models silently or send unsupported controls.

## 9. Safe tools and visible effects

Model output, retrieved documents, websites, repositories, and tool results are untrusted input. Network access, filesystem writes, manuscript changes, and command execution use least privilege and clear approval points. Output controls and escape sequences are sanitized. Credentials never enter prompts, sessions, traces, or ordinary logs.

## 10. Reproduction is controlled experimentation

Paper reproduction is distinct from literature review and from independent replication. A workflow may prepare a reviewable plan without execution. Downloaded code runs only after explicit approval and only in a disposable isolated runner with no host credentials, allowlisted read-only inputs, default-denied network access, and resource limits. A reproduction claim requires captured inputs, environment, commands, artifacts, metrics, tolerances, and evidence; missing or licensed resources are reported, never bypassed.

## 11. Bounded agents, explicit workflows

A research agent is a bounded policy or workflow with declared inputs, tools, budgets, stopping conditions, and approvals. The system does not grant an agent unrestricted autonomy or authority outside the active workspace and configured adapters.

## 12. Verification is scoped and honest

Deterministic validation, source-backed checks, model critique, and human review are different confidence levels. Results identify which checks ran, what evidence they used, and what remains unverified. Verification failure produces a warning or failure state, never a false assurance.

## 13. Deterministic contracts and reproducible tests

Given normalized inputs and configuration, pure stages such as context ordering, citation formatting, and prompt compilation should be deterministic. Public behavior is exercised with fakes, fixtures, golden files, and cross-platform tests. Network-dependent tests are separated from the default suite.

## 14. Thin CLI, reusable Harness

The CLI handles input, terminal capabilities, rendering, and presentation. It contains no research policy. The Harness contains no terminal assumptions. The Research Domain depends on Harness contracts, while provider and tool adapters isolate external I/O.

## 15. Evolve through small vertical slices

Build tested end-to-end behavior before broad abstractions. Extension points are added for demonstrated needs and versioned when public. Pre-alpha architecture may change; documentation, migrations, and tests change with it.

## Decision checklist

Before accepting a feature, ask:

- Does it serve a defined research, writing, LaTeX, publication, or reproduction workflow?
- Are evidence, provenance, verification state, and external data movement visible?
- Are canonical user files preserved and changes reviewable?
- Are tools and downloaded code constrained by least privilege and explicit approval?
- Can capability differences fail safely?
- Is the behavior independently testable through the Harness?
- Does the CLI remain a presentation layer?

A “no” requires redesign or an explicit specification change.
