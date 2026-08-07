# `@researk/latex-renderer`

This internal package produces a bounded SVG representation of a single TeX expression with
MathJax 4. It is deliberately not a complete TeX engine, document compiler, rasterizer, terminal
protocol emitter, or file writer.

The package accepts only the MathJax `base` TeX package, returns an in-memory SVG artifact, and
preserves the caller's original TeX separately. A bounded, pre-initialized Node worker pool keeps
untrusted rendering off the caller/REPL event loop. Timed-out, cancelled, crashed, and failed
workers are terminated and replaced. It performs no network request, starts no shell or system TeX
process, invokes no browser or external helper, and does not read or write workspace files.

Response-scoped budgets enforce expression-count and cumulative-time ceilings; each job also has
input, initialization, render-time, memory, SVG-size, and SVG-dimension bounds. The CLI separately
owns terminal capability detection, bounded rasterization, protocol payload generation, and exact
source fallback.
