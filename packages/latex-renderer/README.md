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
owns terminal capability detection, terminal protocol payload generation, and exact source fallback;
this package owns the isolated SVG-to-raster step.

## Styled raster output

`renderTexToPng` accepts an optional `style` on the render request (or in its options object):

```ts
{
  foreground: "#5fd7ff",
  // Optional; omitted means transparent pixels.
  background: "#242832",
  fontScale: 1,
  dpi: 96,
}
```

The caller supplies semantic theme colors. Colors, scale, and DPI are validated against bounded
closed forms before a worker receives them. MathJax's `currentColor` glyphs use `foreground`, and
the source TeX echo remains unchanged. Requests without a style retain the legacy opaque-white
compatibility canvas; styled requests use transparent padding unless `background` is supplied.

`rendererVersion` (`mathjax-4.1.3-resvg-2.6.2`) is a stable source-and-raster identity suitable for
cache keys. The worker still returns the historical `renderer: "mathjax-4.1.3"` SVG identity for
wire compatibility.
