# CLI Rendering

## Status

This document defines the normative rendering contract for the Researk CLI. The current
`0.1.0-alpha.4` source build includes restricted local MathJax 4 SVG generation, in-memory resvg
rasterization, one-shot display-math emission in positively detected iTerm2 TTYs, and retained
formula graphics in the full-screen TUI. The TUI uses Kitty only after complete bounded query
evidence (matching `i=31` literal `OK`, valid DA1, and measured cell pixels) and Windows Terminal
Sixel only after its advertised capability and cell-pixel response are proven. Exact source is used
everywhere else. Sections that explicitly describe planned command-line or configuration options are
future contract requirements, not claims that those options are accepted by the current CLI.

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

When a graphic is shown in place of a math span, the CLI MUST retain a direct, documented way to reveal and copy that span's exact source without OCR or reverse conversion. The current full-screen TUI provides `/source` and `/formula`: `/formula` can navigate indexed assistant formulas, toggle exact source, and copy the canonical event source through bounded OSC 52 when explicitly eligible. Raw, accessible, Markdown, and JSON output provide exact source directly. The planned `--math source` mode MUST do the same when that option is implemented. Any interactive source-view, copy, edit, or insert action MUST start from the canonical event source rather than text extracted from a rendered image.

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

The current bundled image implementation is:

```text
MathJax 4 TeX input
        ↓
standalone SVG
        ↓
SVG validation and sanitization
        ↓
resvg rasterization at fixed 2× scale
        ↓
opaque-white RGBA pixels and PNG
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

The TUI formula path uses this same restricted MathJax 4 → SVG → resvg pipeline for both display
math and inline math promoted to a dedicated row. The fixed opaque-white background keeps glyphs
visible in dark terminals; the rasterizer returns both PNG and raw RGBA data for the terminal
protocol emitters. No path executes system TeX, accesses files, or makes network requests.

Renderer isolation MAY use a worker thread or another embedded, terminable worker supplied with Researk. It MUST NOT invoke an external rendering subprocess.

The implementation MUST load a fixed allowlist of TeX extensions. It MUST NOT permit an expression to dynamically load code or packages. In particular, runtime `autoload`, `\require`, TeX-to-HTML injection, external file inclusion, arbitrary links, and in-expression renderer option mutation MUST be disabled.

Workspace-defined macros are not required for the initial release. If added, they MUST be validated configuration, immutable for the duration of a response, bounded by the limits in this document, and included in the cache key. An expression MUST NOT mutate macros for later expressions.

Dependency versions, licenses, notices, and the software bill of materials MUST be reviewed and locked during the build and packaging phase.

---

# 7. Output Modes

## 7.1 Automatic behavior

The current CLI selects terminal presentation only for an interactive TTY. One-shot `chat` uses
non-I/O iTerm2 identity detection for display math; the argument-less full-screen TUI performs its
bounded Kitty/Sixel capability probe before Ink mounts. The named `auto` values below describe the
planned explicit output and math option contract.

When standard output is an interactive TTY, the CLI SHOULD use terminal presentation and SHOULD render math graphically only when a supported graphics protocol has been positively detected.

When standard output is not an interactive TTY, the CLI MUST emit Markdown with the original LaTeX source. It MUST NOT emit ANSI styling, cursor movement, terminal queries, OSC, APC, image protocol bytes, spinners, or progress rewrites.

Uncertainty MUST resolve to source, not graphics.

## 7.2 Planned math modes

The following options define planned contract behavior. They are not accepted by the current CLI:

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

## 7.3 Planned output-format option

The current CLI exposes `--raw` and `--json`, rather than `--output`. The following `--output`
values define planned contract behavior and are not accepted by the current CLI:

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

## 7.4 Planned fallback and theme options

The following options define planned contract behavior. They are not accepted by the current CLI:

```text
--math-fallback source
--math-fallback error
--math-theme auto
--math-theme dark
--math-theme light
```

`source` is the default fallback. `error` is intended for strict one-shot commands and automated checks.

The current TUI raster output uses an opaque-white background at fixed 2× scale so formula glyphs
remain visible on dark surfaces. Future theme options MAY choose another safe background, but they
MUST retain sufficient contrast and MUST NOT weaken exact-source fallback.

## 7.5 Local persistence boundary

The full-screen TUI currently persists non-secret provider profiles, selected model/reasoning/theme
configuration, and bounded canonical sessions in the platform's local data directories. It restores
the selected workspace session when the saved workspace matches the current directory. Normal TUI
startup deliberately uses a non-persistent credential store: API keys remain in memory and are
resolved through environment-variable references. An operating-system credential backend remains
future work. Rendered protocol bytes and raster cache entries are never session state.

The following equivalents remain planned command-line/configuration contract values rather than
accepted current CLI flags:

```toml
[output]
format = "auto"
math = "auto"
math_fallback = "source"
math_theme = "auto"
accessible = false
```

When the planned persistent configuration flags are implemented, command-line flags MUST override
workspace configuration, which MUST override user configuration, which MUST override built-in
defaults.

---

# 8. Terminal Graphics

The current source build has two deliberately separate graphics paths:

1. **One-shot `chat`:** positively identified iTerm2 TTYs may receive display-math images through
   the iTerm2 inline-image protocol. Inline math remains exact source in this path. iTerm2 is not a
   retained full-screen TUI overlay protocol.
2. **Full-screen TUI:** argument-less interactive TTY startup probes before Ink mounts. Assistant
   display math and inline math promoted to a dedicated row may use retained Kitty or Windows
   Terminal Sixel placements after the evidence gates in Section 8.1. The common image backend is
   restricted MathJax 4 → SVG → resvg at fixed 2× scale, returning opaque-white PNG/RGBA data.

The CLI MUST emit protocol bytes directly from its trusted terminal backend. It MUST NOT depend on
helper executables. Unsupported, inaccessible, raw, JSON, non-TTY, renderer-failure, clipped,
scrolled, resized, or stale-frame paths MUST show the exact source.

When a graphical TUI formula is placeable, its source MUST be omitted from that visual slot to avoid
duplicate visible content; the canonical assistant/session source remains immutable and available
through `/source` and `/formula`. If the image cannot be rasterized, reserved, contained, or emitted
without corrupting layout, `FormulaGraphic` MUST keep its exact source projection instead.

The TUI graphics runtime emits after the matching Ink frame has flushed, outside the Ink tree. Before
each frame it synchronously clears prior placements. Generation checks, serialized writes, stream
failure handling, terminal dimensions, clipping, and the reserved final scroll row prevent stale or
misplaced images from surviving a redraw. Dispose, cancellation, resize, and exit clear or disable
placements before terminal restoration.

The `/formula` overlay provides keyboard navigation (Up/Down or `j`/`k`), exact canonical-source
copy through bounded OSC 52 (`c`), local draft editing and rerendering (`e`, then Enter), source
toggle (`s`), and insertion (`i`) of either the edited draft or the original canonical formula.
Copy is an explicit eligible-TTY action; when it is unavailable, the overlay keeps source visible
and reports the bounded fallback reason. Formula drafts belong only to the overlay, and assistant
conversation/session source is never rewritten. The overlay exposes no CAS simplify or differentiate
operation.

## 8.1 Capability detection

For the retained TUI path, capability detection proceeds before Ink mounts:

1. Confirm stdin and stdout are TTYs and the invocation is interactive.
2. Reject `TERM=dumb`, CI/non-interactive environments, accessible/raw/JSON paths, and unverified
   `tmux`, `screen`, or other multiplexer sessions.
3. Send one bounded Kitty graphics query together with DA1 and cell-pixel queries. The initial
   probe is capped at 100 milliseconds. Kitty requires complete evidence: matching query id `31`
   with literal protocol `OK`, a valid DA1 response, and bounded measured cell-pixel dimensions.
4. Select Windows Terminal Sixel only when `WT_SESSION` is non-empty, the DA1 response includes
   parameter `4`, and a valid bounded `CSI 6;<height>;<width>t` cell-pixel response is present.
5. Otherwise use source fallback. A trusted iTerm2 identity may enable the one-shot path, but it does
   not enable retained TUI placements.

No capability query may be emitted in Markdown, JSON, accessible, raw, or non-TTY output. A missing,
malformed, late, or oversized response means unsupported for that process. If the initial timeout
leaves an unresolved APC/CSI candidate and a paused readable stream plus replay sink are available,
an unref'd 50-millisecond retirement broker may continue that candidate without extending the
initial probe. Ordinary, malformed, or ultimately incomplete bytes that are not positively
identified as replies are replayed exactly once within the response/replay ceilings, preserving
order on bounded handoff. Replies arriving after broker retirement cannot be distinguished from
ordinary input and are treated as ordinary input. Before that retirement boundary, user keystrokes
must not be consumed or inserted into the prompt.

## 8.2 Layout and lifecycle

The retained TUI backend MUST:

- constrain images to the available terminal width and measured cell-pixel size,
- preserve aspect ratio and reserve the correct rows and columns,
- emit Kitty or Sixel bytes only after the corresponding Ink frame flush,
- synchronously clear old placements before a new frame and on dispose,
- fall back to exact source when resize, scroll, clipping, stale generation, or redraw cannot remain
  correct,
- serialize writes and disable graphics after a stream failure, and
- avoid corrupting scrollback, the alternate screen, or the input prompt.

Terminal resize invalidates layout and width-dependent raster placement decisions. It does not
invalidate canonical source or assistant/session persistence.

## 8.3 Host notes

Kitty output in VS Code requires a recent integrated terminal with
[`terminal.integrated.enableImages`](https://code.visualstudio.com/docs/terminal/advanced#_image-support)
enabled and GPU support (`terminal.integrated.gpuAcceleration` set to `on` or `auto`). The official
[Kitty graphics protocol notes](https://code.visualstudio.com/updates/v1_110#_kitty-graphics-protocol)
also document `terminal.integrated.windowsUseConptyDll` for Windows; the setting may be required on
an individual installation. These notes do not promise every VS Code version or profile. Windows
Terminal Sixel is selected only when the running terminal actually advertises support, not from a
profile name alone. See the official [ConPTY DLL setting guidance](https://code.visualstudio.com/updates/v1_93/#_conpty-shipping-in-product)
for the current Windows-specific setting.

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

Accessible mode takes precedence over automatic graphical rendering now and MUST take precedence
over the planned `--math auto` and `--math graphics` options when they are implemented.

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
| In-memory TUI formula cache | 64 MiB or 32 entries by default (bounded configuration maximum 256) |

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

- bounded Kitty query success only after the matching explicit `OK`, rejection, malformed reply,
  timeout, and replay of user bytes,
- Windows Terminal Sixel gating by `WT_SESSION`, DA1 parameter 4, and valid cell-pixel response,
- iTerm2 positive and negative identity for the one-shot display-math path,
- redirected stdout and stderr, `TERM=dumb`, CI, SSH, `tmux`, and `screen`,
- resize, cancellation, redraw, scrollback, stale-generation, clipping, and clean exit,
- protocol byte snapshots, pre-frame cleanup, outside-Ink emission ordering, and incomplete-write
  recovery,
- user keystrokes arriving during a capability probe, and
- exact-source fallback when correct cell layout or frame freshness is impossible.

The retained TUI may use Kitty or Sixel only after its corresponding bounded capability and layout
tests pass. iTerm2 remains a one-shot display-math protocol, not a retained TUI overlay protocol.

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
- iTerm2 renders representative display equations without corrupting the prompt, cursor, resize
  behavior, or scrollback in one-shot `chat`.
- The full-screen TUI renders inline (promoted to a row) and display formulas through the restricted
  MathJax 4 → SVG → resvg 2× opaque-white PNG/RGBA path when retained Kitty or Sixel capability and
  layout criteria pass.
- Retained TUI graphics are emitted outside Ink after frame flush with pre-frame cleanup; scroll,
  resize, clipping, stale generations, and failures fall back to exact source.
- `/formula` navigates, copies canonical source through bounded OSC 52, locally edits/rerenders,
  toggles source, and inserts edited or canonical source without mutating assistant/session source.
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
