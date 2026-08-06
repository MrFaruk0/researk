# `@researk/latex-renderer`

This internal package produces a bounded SVG representation of a single TeX expression with
MathJax 4. It is deliberately not a complete TeX engine, document compiler, rasterizer, terminal
protocol emitter, or file writer.

The package accepts only the MathJax `base` TeX package, returns an in-memory SVG artifact, and
preserves the caller's original TeX separately. It performs no network request, starts no shell or
system TeX process, and does not read or write workspace files.

This is an SVG proof-of-rendering backend. It does not by itself satisfy the CLI graphical-math
contract in ADR 0006: terminal protocol integration, rasterization, worker isolation, and
capability detection remain separate, gated work.
