# CLI Rendering

## Status

This document defines the normative rendering contract for the Researk CLI.

The key words **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and **MAY** describe requirements for implementations of the official CLI and compatible clients.

---

# 1. Purpose

Researk is a downloadable, local-first, open-source research harness and CLI. Scientific responses commonly contain Markdown and LaTeX mathematics. The CLI must make that content readable in an interactive terminal without changing, discarding, or executing the source produced by the runtime.

This contract applies equally when the response is an academic-paper draft, a manuscript revision, a LaTeX authoring result, an APA 7 or IEEE workflow report, or a paper-reproduction plan or report. Equations and LaTeX fragments in all of these workflows remain exact, copyable source.

Rendering is presentation. It is not part of scientific reasoning, verification, provider communication, or session state.

The canonical response is the original Markdown and LaTeX source. Rendered images and terminal escape sequences are disposable views of that source.

---

# 2. Scope

This contract covers:

- incremental parsing of streamed Markdown and math,
- terminal and non-terminal output,
- high-quality rendering of math expressions,
- terminal capability detection,
- safe fallbacks,
- accessible and machine-readable output,
- configuration and command-line behavior,
- rendering isolation and resource limits,
- diagnostics, caching, tests, and acceptance criteria.

This contract does **not** cover:

- compiling complete `.tex` documents,
- generating or previewing PDF, DVI, or PostScript documents,
- executing a TeX distribution,
- loading arbitrary TeX packages or files,
- replacing LaTeX verification in the Research Domain,
- a browser, web view, hosted rendering service, or CDN.

Full-document LaTeX compilation and preview are explicitly out of scope for the CLI rendering pipeline. They may be designed later as separate, permission-aware tools.

Terminal math visualization MUST remain distinct from:

- manuscript authoring and structured manuscript state,
- LaTeX source-file creation and export,
- APA 7, IEEE, journal, citation, or manuscript validation,
- LaTeX syntax and semantic verification,
- execution of code or LaTeX described by a paper-reproduction workflow.

Those systems may produce source for the CLI to display, but rendering MUST NOT modify their artifacts, claim that a manuscript compiles, or execute their contents.

---

# 3. Architectural Boundary

The rendering flow is:

```text
Runtime response stream
        ↓
Incremental Markdown and math parser
        ↓
Presentation-neutral render events
        ↓
CLI layout and capability selection
        ↓
Graphics renderer or exact-source fallback
        ↓
Terminal, Markdown, or JSON emitter
```

The runtime and harness MUST emit presentation-neutral content. They MUST NOT emit ANSI control sequences, terminal image protocols, HTML, SVG, or raster images as part of a normal response.

The CLI owns:

- Markdown presentation,
- math delimiter recognition,
- terminal layout,
- terminal capability detection,
- math image generation,
- terminal protocol emission,
- presentation diagnostics.

The runtime owns the canonical response stream. The Research Domain may validate LaTeX syntax or scientific meaning, but it MUST NOT select terminal rendering behavior.

Sessions MUST persist the canonical source and relevant runtime diagnostics. They MUST NOT persist terminal escape sequences or rendered SVG and raster artifacts. A rendering cache is disposable and MUST NOT become session state.

When a graphic is shown in place of a math span, the CLI MUST retain a direct, documented way to reveal and copy that span's exact source without OCR or reverse conversion. `--math source`, Markdown output, and JSON output MUST always provide the source directly. An interactive source-view or copy action MAY provide additional convenience, but MUST copy the canonical event source rather than text extracted from the rendered image.

---

# 4. Canonical Source and Render Events

Every parsed event MUST retain the exact source slice from which it was produced. Removing delimiters for the rendering backend MUST NOT mutate the source stored in the event.

The minimum logical event types are:

```text
Text
InlineMath
DisplayMath
Code
Diagnostic
```

A math event contains at least:

```text
kind          inline or display
source        exact source, including delimiters when present
tex           expression passed to the math backend
delimiter     recognized delimiter or environment
location      response-relative source position
```

Concatenating the `source` fields of content events MUST reproduce the canonical response. Diagnostics are metadata and are not part of that reconstruction.

The parser MUST produce events incrementally. It MUST NOT require the complete response before yielding ordinary text or completed math expressions.

The implementation MUST maintain an incremental Markdown abstract syntax tree, or an equivalent structured event state with the same context guarantees. A flat, whole-response regular-expression pass is not conformant.

---

# 5. Math Syntax

## 5.1 Supported delimiters

The parser MUST recognize:

| Form | Meaning |
|---|---|
| `\(...\)` | Inline math |
| `$...$` | Inline math |
| `\[...\]` | Display math |
| `$$...$$` | Display math |
| fenced `math` block | Display math |

The parser MUST recognize the following standalone display environments, including their complete `\begin` and `\end` tokens:

- `equation` and `equation*`
- `align` and `align*`
- `alignat` and `alignat*`
- `gather` and `gather*`
- `multline` and `multline*`

An environment is standalone only when it begins outside a paragraph's ordinary prose and its closing environment has the same name. Other environments may occur inside an already recognized math span if the backend supports them, but they MUST NOT independently start rendering.

Fenced `tex` and `latex` blocks are literal source examples and MUST NOT be rendered as math. A fenced `math` block is an explicit request for display rendering.

## 5.2 Dollar-sign rules

`$$` MUST be considered before `$` so a display delimiter cannot be consumed as an empty inline expression.

For `$` to open inline math, it must:

- be unescaped,
- be followed by a non-whitespace character,
- have a matching valid closing `$` in the same paragraph.

For `$` to close inline math, it must:

- be unescaped,
- be preceded by a non-whitespace character,
- not be immediately followed by a decimal digit.

These rules reduce accidental rendering of currency while retaining conventional scientific notation. A delimiter is escaped when it is preceded by an odd-length run of backslashes.

## 5.3 Excluded contexts

Math recognition MUST run over Markdown structure rather than a global regular-expression replacement.

Delimiters MUST remain literal inside:

- inline code,
- fenced code other than a `math` fence,
- indented code,
- raw URLs and autolinks,
- raw HTML tags and attributes,
- escaped Markdown text.

The parser MUST NOT reinterpret the contents of a `tex` or `latex` code fence.

## 5.4 Streaming behavior

The parser may buffer only the currently unfinished construct and the minimum Markdown context required to classify it.

A math span MUST be emitted only after its valid closing delimiter or environment is received. If the response ends before closure, the buffered source MUST be emitted literally and a non-fatal diagnostic MAY be recorded.

Parser results MUST be identical regardless of provider chunk boundaries, including boundaries inside UTF-8 sequences, delimiters, command names, braces, and environment names.

Expressions MUST NOT cross paragraph boundaries except for display forms that explicitly allow multiple lines.

---

# 6. Math Rendering Backend

Math rendering MUST be accessed through a replaceable interface with behavior equivalent to:

```text
render(tex, display_mode, container_width, scale, theme, macro_set)
    → rendered artifact and diagnostics
```

The initial bundled implementation is:

```text
MathJax 4 TeX input
        ↓
standalone SVG
        ↓
SVG validation and sanitization
        ↓
resvg rasterization
        ↓
transparent RGBA or PNG
```

The initial backend MUST:

- operate entirely on the local machine,
- be included in official distributions,
- work offline after installation,
- use a fixed, tested set of locally packaged fonts and TeX extensions,
- avoid browser automation and browser dependencies,
- avoid CDNs and all runtime network requests,
- avoid system TeX installations,
- avoid invoking `latex`, `pdflatex`, `xelatex`, `lualatex`, `tectonic`, `kitten`, `imgcat`, `chafa`, or any other external executable,
- produce deterministic output for the same input, backend version, configuration, width, scale, and theme.

Renderer isolation MAY use a worker thread or another embedded, terminable worker supplied with Researk. It MUST NOT invoke an external rendering subprocess.

The implementation MUST load a fixed allowlist of TeX extensions. It MUST NOT permit an expression to dynamically load code or packages. In particular, runtime `autoload`, `\require`, TeX-to-HTML injection, external file inclusion, arbitrary links, and in-expression renderer option mutation MUST be disabled.

Workspace-defined macros are not required for the initial release. If added, they MUST be validated configuration, immutable for the duration of a response, bounded by the limits in this document, and included in the cache key. An expression MUST NOT mutate macros for later expressions.

Dependency versions, licenses, notices, and the software bill of materials MUST be reviewed and locked during the build and packaging phase.

---

# 7. Output Modes

## 7.1 Automatic behavior

The default output mode is `auto` and the default math mode is `auto`.

When standard output is an interactive TTY, the CLI SHOULD use terminal presentation and SHOULD render math graphically only when a supported graphics protocol has been positively detected.

When standard output is not an interactive TTY, the CLI MUST emit Markdown with the original LaTeX source. It MUST NOT emit ANSI styling, cursor movement, terminal queries, OSC, APC, image protocol bytes, spinners, or progress rewrites.

Uncertainty MUST resolve to source, not graphics.

## 7.2 Math modes

The CLI supports:

```text
--math auto
--math graphics
--math source
```

Their meanings are:

- `auto`: use graphics only after positive capability detection; otherwise use source.
- `graphics`: request graphics and apply the configured fallback if graphics are unavailable or rendering fails.
- `source`: never initialize the math renderer or emit an image protocol.

The CLI MUST NOT use approximate Unicode substitutions as an automatic fallback. Fractions, matrices, indices, accents, and operators can be changed or made ambiguous by partial character substitution. The exact LaTeX source is the only required fallback.

## 7.3 Output formats

The CLI supports:

```text
--output auto
--output terminal
--output markdown
--output json
```

- `auto` selects `terminal` for an interactive TTY and `markdown` otherwise.
- `terminal` enables interactive layout only when stdout is a TTY. Requesting it for redirected output is a configuration error; it does not force escape sequences into a pipe.
- `markdown` emits the canonical Markdown and LaTeX representation without terminal control sequences.
- `json` emits the machine-readable contract in Section 10.

## 7.4 Fallback and theme

The CLI supports:

```text
--math-fallback source
--math-fallback error
--math-theme auto
--math-theme dark
--math-theme light
```

`source` is the default fallback. `error` is intended for strict one-shot commands and automated checks.

Raster output SHOULD use a transparent background. `auto` theme selection may use a trusted terminal foreground query or known terminal metadata. If color cannot be determined safely, the renderer MUST use the configured fallback theme and MUST retain sufficient contrast.

## 7.5 Persistent configuration

The persistent equivalents are:

```toml
[output]
format = "auto"
math = "auto"
math_fallback = "source"
math_theme = "auto"
accessible = false
```

Command-line flags override workspace configuration, which overrides user configuration, which overrides built-in defaults.

---

# 8. Terminal Graphics

The first supported graphics protocols are:

1. Kitty graphics protocol
2. iTerm2 inline-image protocol

Sixel support is planned but MUST be reported as unsupported until its encoder, capability detection, layout, and cleanup behavior pass the same conformance tests as the first two backends.

The CLI MUST emit protocol bytes directly from its trusted terminal backend. It MUST NOT depend on helper executables.

Display math SHOULD be rendered graphically when a backend is available. Inline math may be rendered graphically only when the layout engine can reserve the required cell rectangle, preserve the surrounding text order, and reflow or redraw it correctly. If it cannot do so, that inline expression MUST fall back to exact source even when display math uses graphics.

## 8.1 Capability detection

Capability detection proceeds in this order:

1. Confirm stdout is a TTY.
2. Reject `TERM=dumb` and known non-interactive environments.
3. Disable graphics when accessible mode is active.
4. Detect a supported terminal protocol.
5. Verify multiplexer passthrough when a multiplexer is present.
6. Cache the result for the process.

Kitty support MUST be established with its graphics query and a terminal device-attributes response, not solely with environment variables. The query wait MUST be bounded to 100 milliseconds. A missing, malformed, or late response means unsupported for that process.

iTerm2 support may use its documented terminal identity and version metadata. Inside `tmux`, `screen`, or another multiplexer, it MUST remain disabled until passthrough is explicitly recognized and covered by integration tests.

The terminal input broker MUST distinguish capability replies from user keystrokes. A probe MUST NOT consume user input, insert response bytes into the prompt, or hang startup.

No capability query may be emitted in Markdown, JSON, accessible, or non-TTY output.

## 8.2 Layout and lifecycle

The terminal backend MUST:

- constrain images to the available terminal width,
- preserve aspect ratio,
- reserve the correct rows and columns,
- move the cursor according to the selected protocol,
- clean up placements during redraw, resize, cancellation, and exit,
- fall back to source when resize or redraw cannot remain correct,
- avoid corrupting scrollback or the input prompt.

Terminal resize invalidates width-dependent cache entries and layout. It does not invalidate canonical source.

---

# 9. Accessible Output

Accessible mode is enabled with:

```text
--accessible
```

Accessible mode MUST:

- disable terminal images,
- disable animation, spinners, cursor rewrites, and color-only meaning,
- emit math as exact, visibly delimited source,
- preserve a stable linear reading order,
- keep diagnostics separate from response content.

Accessible mode takes precedence over `--math auto` and `--math graphics`.

`NO_COLOR` controls color only. It MUST NOT be treated as an accessibility setting, a non-TTY signal, or a request to discard Markdown structure.

Speech or Braille descriptions may be added later as optional metadata. They MUST NOT replace or mutate canonical LaTeX source.

---

# 10. JSON Output

JSON output MUST contain structured response events and MUST NOT contain terminal escape sequences or rendered image payloads.

Each math event contains at least:

```json
{
  "type": "math",
  "kind": "display",
  "source": "\\[E = mc^2\\]",
  "tex": "E = mc^2",
  "delimiter": "\\[...\\]",
  "location": {
    "start": 0,
    "end": 12
  }
}
```

JSON string encoding MUST escape control characters. Diagnostics MUST be emitted as typed diagnostic events or in a documented diagnostics collection; they MUST NOT be inserted into response text.

Consumers MUST be able to reconstruct the canonical response from ordered content events without interpreting rendered artifacts.

The JSON schema is a public compatibility surface and MUST be versioned before the first stable release.

---

# 11. Safety Model

Provider output, workspace content, macros, and terminal metadata are untrusted.

## 11.1 Terminal escape safety

Only the trusted terminal emitter may construct ANSI, OSC, APC, or graphics protocol sequences.

Untrusted text MUST NOT be written directly to an interactive terminal. C0 and C1 control characters other than permitted line breaks and horizontal tabs MUST be rendered as visible escaped text. In Markdown output they MUST be safely escaped; in JSON they MUST use JSON escapes. The internal canonical record may retain the original code points for audit, but no output mode may allow them to become active terminal controls.

TeX source MUST be passed to the renderer as data. It MUST NOT be interpolated into a shell command, executable argument string, HTML template, path, URL, or terminal escape sequence.

## 11.2 Renderer isolation

Math rendering MUST run in a pre-initialized, terminable worker isolated from the REPL event loop. The worker MUST have no network authority and no general workspace file access. It MUST NOT spawn third-party executables.

Failure, timeout, or memory exhaustion MUST terminate and replace the worker before another expression is accepted. A renderer failure MUST NOT terminate the interactive session.

## 11.3 SVG and raster safety

Generated SVG MUST be parsed and validated before rasterization. The allowlist MUST be limited to elements and attributes required by known MathJax output.

The sanitizer MUST reject:

- scripts and event handlers,
- `foreignObject`,
- external URLs and references,
- embedded remote or local resources,
- animation,
- unbounded filters or dimensions,
- unexpected namespaces or elements.

Raster dimensions and decoded memory MUST be checked before allocation. Terminal protocol payloads MUST be generated in memory. If a temporary file is unavoidable on a future backend, it must be a private, randomly named regular file in the operating system's temporary directory and must be removed on success, failure, cancellation, and startup recovery.

---

# 12. Resource Ceilings

The initial implementation MUST enforce all of these ceilings:

| Resource | Ceiling |
|---|---:|
| UTF-8 bytes per math expression | 16 KiB |
| Math expressions per response | 256 |
| Parsed brace/environment nesting | 128 levels |
| Configured macros | 64 |
| Macro expansions per expression | 10,000 |
| Warm render time per expression | 1,000 ms |
| One-time worker initialization | 5,000 ms |
| Cumulative render time per response | 5,000 ms |
| Concurrent render jobs | 2 |
| Worker memory | 128 MiB |
| Serialized SVG per expression | 1 MiB |
| Raster width | 4,096 px |
| Raster height | 2,048 px |
| Raster area | 8,388,608 px |
| Encoded image/protocol payload | 8 MiB |
| In-memory render cache | 64 MiB or 512 entries, whichever is reached first |

Reaching a ceiling is a typed rendering failure. With the default fallback, the expression is shown as exact source. Limits may become configurable only within conservative compiled minimum and maximum bounds; unbounded values are forbidden.

---

# 13. Cache

The renderer SHOULD use a bounded in-memory least-recently-used cache.

The cache key MUST include:

- exact TeX input,
- inline or display mode,
- macro-set digest,
- backend and font versions,
- TeX extension set,
- container width,
- raster scale,
- foreground/theme selection,
- sanitizer version.

Cached values MUST pass the same size limits as newly rendered values. Cache entries are untrusted after a software upgrade and MUST NOT be reused across incompatible renderer or sanitizer versions.

An optional disk cache may be added later. It MUST live in the platform cache directory, be size-bounded, use atomic writes and private permissions, validate every read, and remain safe to delete at any time. It MUST NOT live in the research workspace or be committed to source control.

---

# 14. Failures and Diagnostics

Rendering is best-effort presentation. It MUST NOT suppress a valid response.

On an unmatched delimiter, unsupported expression, backend error, sanitizer rejection, timeout, or resource-limit breach, the CLI MUST:

1. preserve and display the exact source when fallback is `source`,
2. record a typed diagnostic with source location and stable error code,
3. avoid emitting partial images or incomplete protocol sequences,
4. continue the interactive session.

Interactive terminal output SHOULD show no more than one concise rendering warning per response unless verbose diagnostics are enabled. Repeated failures SHOULD be summarized.

Markdown output sends diagnostics to standard error and response content to standard output. JSON output represents diagnostics structurally. Logs SHOULD record error codes, locations, limits, and source digests rather than complete research expressions by default.

Suggested process exit behavior for one-shot commands is:

| Exit code | Meaning |
|---:|---|
| `0` | Output completed, including successful source fallback |
| `2` | Invalid output or rendering configuration |
| `3` | Forced graphics unavailable with fallback `error` |
| `4` | Parse, render, timeout, sanitization, or limit failure with fallback `error` |
| `5` | Output or terminal protocol I/O failure |

Interactive rendering failures do not exit the CLI. Global CLI exit-code policy may reserve additional codes, but it MUST preserve these distinct error categories.

`/status` and the non-interactive diagnostic command SHOULD report:

- requested and effective output mode,
- requested and effective math mode,
- detected terminal protocol,
- renderer availability and version,
- fallback reason,
- accessible-mode state,
- worker health.

---

# 15. Test Requirements

## 15.1 Parser tests

The test suite MUST include golden cases for:

- every supported delimiter and environment,
- escaped and adjacent delimiters,
- currency and decimal amounts,
- Markdown emphasis adjacent to math,
- code spans and all fence types,
- URLs, autolinks, and raw HTML,
- unmatched or mismatched delimiters,
- nested braces and environments,
- malformed and non-ASCII Unicode,
- maximum-length and maximum-count boundaries.

Fixtures MUST include equations embedded in manuscript drafts, revision reports, LaTeX authoring responses, and paper-reproduction plans and reports. The parser and renderer MUST treat them identically and MUST never execute adjacent LaTeX or reproduction code.

Every streaming fixture MUST be tested with splits at every byte boundary and every Unicode scalar boundary. Its events MUST equal the non-streaming parse.

The parser MUST be fuzzed for termination, bounded memory, delimiter ambiguity, malformed UTF-8 ingress, and adversarial nesting.

## 15.2 Renderer tests

The renderer MUST have:

- normalized SVG golden tests,
- representative raster snapshot tests,
- inline and display sizing tests,
- multiline alignment, matrix, fraction, accent, Unicode, and chemistry fixtures,
- deterministic cache-key tests,
- explicit unsupported-command tests,
- sanitizer rejection tests,
- macro recursion, expansion, timeout, dimension, and memory-limit tests,
- worker termination and restart tests.

## 15.3 Terminal tests

Terminal tests MUST cover:

- Kitty query success, rejection, malformed reply, and timeout,
- iTerm2 positive and negative identification,
- redirected stdout and stderr,
- `TERM=dumb`, CI, SSH, `tmux`, and `screen`,
- resize, cancellation, redraw, scrollback, and clean exit,
- protocol byte snapshots and incomplete-write recovery,
- user keystrokes arriving during a capability probe,
- inline fallback when correct cell layout is impossible.

Until Sixel passes the equivalent suite, it MUST remain planned rather than supported.

## 15.4 Output and accessibility tests

Tests MUST prove that:

- non-TTY Markdown contains no terminal escape or image protocol sequences,
- accessible output contains no images, animation, cursor rewrites, or color-only meaning,
- JSON is valid, control characters are escaped, and events reconstruct canonical source,
- diagnostics never contaminate Markdown stdout,
- default fallback preserves exact LaTeX source,
- approximate Unicode math is never selected automatically.

## 15.5 Platform and packaging tests

Official packages MUST be smoke-tested on supported Windows, macOS, and Linux targets. Tests MUST run offline and MUST verify that rendering succeeds without a browser, system TeX, global runtime package, helper executable, or network request.

Dependency lockfiles, notices, reproducibility data, and software-bill-of-materials generation MUST be tested in the build phase.

---

# 16. Acceptance Criteria

CLI rendering is complete for its initial release only when all of the following are true:

- Canonical Markdown and LaTeX survive parsing, persistence, fallback, and JSON output without semantic mutation.
- Every graphically rendered expression has a documented exact-source reveal or copy path that does not use OCR or reverse conversion.
- Parser results are independent of streaming chunk boundaries.
- Supported display math renders through the bundled MathJax-to-SVG and resvg pipeline while offline.
- Kitty and iTerm2 render representative equations without corrupting the prompt, cursor, resize behavior, or scrollback.
- Unsupported terminals receive exact source automatically and without installation steps.
- Redirected output contains no terminal control or graphics protocol bytes.
- Accessible mode provides stable, linear, exact-source math output.
- JSON output is structured, reconstructable, and escape-safe.
- Adversarial input cannot execute commands, load files or network resources, inject terminal controls, or bypass resource ceilings.
- Renderer timeout or crash is contained, the worker is replaced, and the interactive session continues.
- Rendering failures produce typed diagnostics and never hide response content.
- The full parser, backend, protocol, safety, accessibility, and cross-platform test suites pass.
- Official distributions require no browser, CDN, hosted service, system TeX installation, or external rendering helper.
- Paper-authoring and reproduction content follows the same lossless visualization rules and is never executed by the renderer.
- Full-document LaTeX compilation and preview remain outside this pipeline.

---

# Guiding Rule

> Render when the terminal can do so faithfully; preserve exact source everywhere else.
