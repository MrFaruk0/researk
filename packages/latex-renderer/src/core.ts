import { Buffer } from "node:buffer";
import { liteAdaptor } from "@mathjax/src/js/adaptors/liteAdaptor.js";
import { RegisterHTMLHandler } from "@mathjax/src/js/handlers/html.js";
import { TeX } from "@mathjax/src/js/input/tex.js";
// Register only the explicitly selected AMS TeX configuration. Do not import the component
// loader, autoload, require, HTML, URL, or all-packages bundles: this worker must keep a closed
// package graph for untrusted source.
import "@mathjax/src/js/input/tex/ams/AmsConfiguration.js";
import { mathjax } from "@mathjax/src/js/mathjax.js";
import { SVG } from "@mathjax/src/js/output/svg.js";
import { type LatexRenderStyle, normalizeLatexRenderStyle } from "./style.js";

const maximumInputBytes = 16 * 1024;
const maximumOutputBytes = 1024 * 1024;
const maximumBraceNesting = 128;
const maximumViewBoxDimension = 32_768;

const safeElementNames = new Set(["svg", "g", "path", "rect", "text"]);
const safeAttributeNames = new Set([
  "d",
  "data-mjx-error",
  "aria-hidden",
  "aria-label",
  "class",
  "color",
  "data-c",
  "data-latex",
  "data-mml-node",
  "dx",
  "dy",
  "fill",
  "focusable",
  "font-family",
  "font-size",
  "height",
  "role",
  "stroke",
  "stroke-width",
  "style",
  "text-anchor",
  "transform",
  "viewBox",
  "width",
  "x",
  "xml:space",
  "xmlns",
  "y",
]);

export const latexSvgRendererLimits = Object.freeze({
  maximumBraceNesting,
  maximumInputBytes,
  maximumOutputBytes,
  maximumViewBoxDimension,
});

export type LatexSvgRenderErrorCode =
  | "invalid_input"
  | "input_limit"
  | "output_limit"
  | "render_failed"
  | "unsafe_svg";

export class LatexSvgRenderError extends Error {
  public readonly code: LatexSvgRenderErrorCode;

  public constructor(code: LatexSvgRenderErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LatexSvgRenderError";
    this.code = code;
  }
}

export interface LatexSvgRenderRequest {
  readonly display?: boolean;
  /** Optional pixel-affecting style. Omission preserves the legacy SVG/raster defaults. */
  readonly style?: LatexRenderStyle;
  readonly tex: string;
}

export interface LatexSvgRenderResult {
  readonly display: boolean;
  readonly renderer: "mathjax-4.1.3";
  readonly svg: string;
  readonly tex: string;
  readonly png?: Uint8Array;
  /** Raw RGBA pixels for bounded terminal protocols that do not consume PNG. */
  readonly pixels?: Uint8Array;
  readonly width?: number;
  readonly height?: number;
}

/**
 * Structural facts about a validated SVG, produced by the same single parse that validates it.
 *
 * These are properties of *parsed markup*, never of the serialized string. A `data-latex` attribute
 * echoes the caller's own TeX verbatim, so `x_{font-family}` and `\mbox{font-family: serif}` put the
 * literal bytes `font-family` and even `font-family:` into an otherwise pure-path SVG. A substring
 * test over the serialization cannot tell that apart from a real glyph run and refuses valid math.
 */
export interface LatexSvgStructure {
  /** True only when at least one `<text>` element was actually parsed. */
  readonly hasTextElement: boolean;
  /**
   * True only when a real `font-family` presentation attribute was parsed on some element, or a
   * real `font-family:` CSS declaration was parsed inside a real `style` attribute. An attribute
   * *value* that merely contains the characters `font-family` does not set this.
   */
  readonly hasFontFamily: boolean;
}

/** A validated SVG together with the structural facts observed while validating it. */
export interface ValidatedSvg {
  readonly structure: LatexSvgStructure;
  readonly svg: string;
}

interface Renderer {
  readonly adaptor: ReturnType<typeof liteAdaptor>;
  readonly document: ReturnType<typeof mathjax.document>;
}

let renderer: Renderer | undefined;

/**
 * Renders one restricted TeX expression to a validated SVG string in memory.
 *
 * This intentionally loads MathJax's base and explicitly selected AMS TeX packages. It does not execute
 * system TeX, invoke a shell, load external resources, rasterize output, or write files.
 */
export function renderTexToSvgInWorker(request: LatexSvgRenderRequest): LatexSvgRenderResult {
  return renderTexToValidatedSvgInWorker(request).result;
}

/**
 * The same render, additionally returning the structural facts observed during SVG validation.
 *
 * The worker needs to know whether the output contains a real glyph run before it rasterizes.
 * That question is answered here, by the parser that already walks every tag and attribute, rather
 * than by a second regex pass over the serialization that cannot distinguish markup from a
 * `data-latex` source echo. The `result` field is the unchanged public render result.
 */
export function renderTexToValidatedSvgInWorker(request: LatexSvgRenderRequest): {
  readonly result: LatexSvgRenderResult;
  readonly structure: LatexSvgStructure;
} {
  validateTex(request.tex);

  const display = request.display ?? true;

  try {
    let style: ReturnType<typeof normalizeLatexRenderStyle>;
    try {
      style = normalizeLatexRenderStyle(request.style);
    } catch (error) {
      throw new LatexSvgRenderError("invalid_input", "LaTeX render style is invalid.", {
        cause: error,
      });
    }
    const activeRenderer = getRenderer();
    const node = activeRenderer.document.convert(request.tex, { display });
    const svgNode = activeRenderer.adaptor.tags(node, "svg")[0];

    if (svgNode === undefined) {
      throw new LatexSvgRenderError("render_failed", "MathJax did not produce an SVG element.");
    }

    const serialized = activeRenderer.adaptor.serializeXML(svgNode);
    const validated = validateSvg(serialized);
    const styledSvg =
      style === undefined ? validated.svg : applySvgForeground(validated.svg, style.foreground);

    return {
      result: {
        display,
        renderer: "mathjax-4.1.3",
        svg: styledSvg,
        tex: request.tex,
      },
      structure: validated.structure,
    };
  } catch (error) {
    if (error instanceof LatexSvgRenderError) {
      throw error;
    }

    throw new LatexSvgRenderError("render_failed", "MathJax could not render the expression.", {
      cause: error,
    });
  }
}

/**
 * MathJax's path groups use `currentColor`. A validated root `color` presentation attribute applies
 * the caller's semantic foreground without rewriting glyph paths or embedding theme decisions in
 * this package. The color grammar in `style.ts` excludes quotes and control bytes, but the root is
 * still checked structurally before this attribute is inserted.
 */
function applySvgForeground(svg: string, foreground: string): string {
  const openingEnd = svg.indexOf(">");
  if (openingEnd < 0 || !svg.startsWith("<svg")) {
    throw new LatexSvgRenderError("unsafe_svg", "Rendered SVG has an invalid root element.");
  }

  const opening = svg.slice(0, openingEnd);
  const withoutColor = opening.replace(/\scolor="[^"]*"/u, "");
  return `${withoutColor} color="${foreground}"${svg.slice(openingEnd)}`;
}

function getRenderer(): Renderer {
  if (renderer !== undefined) {
    return renderer;
  }

  const adaptor = liteAdaptor();
  RegisterHTMLHandler(adaptor);

  const tex = new TeX({ packages: ["base", "ams"] });
  const svg = new SVG({ fontCache: "none" });

  renderer = {
    adaptor,
    document: mathjax.document("", {
      InputJax: tex,
      OutputJax: svg,
    }),
  };

  return renderer;
}

function validateTex(tex: string): void {
  if (typeof tex !== "string" || tex.length === 0) {
    throw new LatexSvgRenderError("invalid_input", "TeX input must be a non-empty string.");
  }

  if (Buffer.byteLength(tex, "utf8") > maximumInputBytes) {
    throw new LatexSvgRenderError(
      "input_limit",
      `TeX input exceeds the ${maximumInputBytes}-byte limit.`,
    );
  }

  let braceDepth = 0;
  let escaped = false;

  for (const character of tex) {
    if (escaped) {
      escaped = false;
      continue;
    }

    if (character === "\\") {
      escaped = true;
      continue;
    }

    if (character === "{") {
      braceDepth += 1;
      if (braceDepth > maximumBraceNesting) {
        throw new LatexSvgRenderError(
          "input_limit",
          `TeX input exceeds the ${maximumBraceNesting}-level brace nesting limit.`,
        );
      }
    } else if (character === "}") {
      braceDepth -= 1;
      if (braceDepth < 0) {
        throw new LatexSvgRenderError("invalid_input", "TeX input has an unmatched closing brace.");
      }
    }
  }

  if (braceDepth !== 0) {
    throw new LatexSvgRenderError("invalid_input", "TeX input has an unmatched opening brace.");
  }
}

function validateSvg(svg: string): ValidatedSvg {
  if (Buffer.byteLength(svg, "utf8") > maximumOutputBytes) {
    throw new LatexSvgRenderError(
      "output_limit",
      `Rendered SVG exceeds the ${maximumOutputBytes}-byte limit.`,
    );
  }

  const openElements: string[] = [];
  let rootSeen = false;
  let cursor = 0;
  // Accumulated from parsed markup only, in the same pass that enforces the allowlists below.
  let hasTextElement = false;
  let hasFontFamily = false;

  while (cursor < svg.length) {
    const start = svg.indexOf("<", cursor);
    if (start === -1) {
      validateSvgText(svg.slice(cursor));
      break;
    }

    validateSvgText(svg.slice(cursor, start));

    const end = findTagEnd(svg, start);
    if (end === -1) {
      throw new LatexSvgRenderError("unsafe_svg", "Rendered SVG contains an unterminated tag.");
    }

    const tag = svg.slice(start, end + 1);
    if (tag.startsWith("</")) {
      const closingMatch = /^<\/([A-Za-z][A-Za-z0-9:_-]*)\s*>$/u.exec(tag);
      const closingName = closingMatch?.[1];
      if (closingName === undefined || openElements.pop() !== closingName) {
        throw new LatexSvgRenderError("unsafe_svg", "Rendered SVG has invalid element nesting.");
      }
    } else {
      const parsed = parseStartTag(tag);

      if (!safeElementNames.has(parsed.name)) {
        throw new LatexSvgRenderError(
          "unsafe_svg",
          `Rendered SVG contains disallowed <${parsed.name}> markup.`,
        );
      }

      if (!rootSeen) {
        if (parsed.name !== "svg") {
          throw new LatexSvgRenderError("unsafe_svg", "Rendered SVG has no SVG root element.");
        }
        rootSeen = true;
      } else if (openElements.length === 0) {
        throw new LatexSvgRenderError("unsafe_svg", "Rendered SVG has more than one root element.");
      }

      validateAttributes(parsed.name, parsed.attributes);

      // An element name, not a substring of the serialization.
      if (parsed.name === "text") hasTextElement = true;
      // A real presentation attribute, or a real declaration inside a real `style` attribute.
      if (parsed.attributes.has("font-family")) hasFontFamily = true;
      const style = parsed.attributes.get("style");
      if (style !== undefined && declaresFontFamily(style)) hasFontFamily = true;

      if (!parsed.selfClosing) {
        openElements.push(parsed.name);
      }
    }

    cursor = end + 1;
  }

  if (!rootSeen || openElements.length !== 0) {
    throw new LatexSvgRenderError("unsafe_svg", "Rendered SVG has incomplete element nesting.");
  }

  validateViewBox(svg);

  return { structure: { hasTextElement, hasFontFamily }, svg };
}

/**
 * Detects a real `font-family` CSS declaration in a `style` attribute value.
 *
 * The property name must start a declaration — at the beginning of the value or immediately after a
 * `;` — and must be followed by a `:`. This ignores `font-family` appearing inside a declaration
 * *value*, which is where an echoed TeX source string would land.
 */
function declaresFontFamily(style: string): boolean {
  for (const declaration of style.split(";")) {
    const separator = declaration.indexOf(":");
    if (separator === -1) continue;
    if (declaration.slice(0, separator).trim().toLowerCase() === "font-family") return true;
  }

  return false;
}

function validateSvgText(text: string): void {
  if (/[^\t\n\r\u0020-\u{10FFFF}]/u.test(text)) {
    throw new LatexSvgRenderError("unsafe_svg", "Rendered SVG contains a control character.");
  }
}

function findTagEnd(svg: string, start: number): number {
  let quote: '"' | "'" | undefined;

  for (let index = start + 1; index < svg.length; index += 1) {
    const character = svg[index];

    if (quote !== undefined) {
      if (character === quote) {
        quote = undefined;
      }
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === ">") {
      return index;
    }
  }

  return -1;
}

interface ParsedStartTag {
  readonly attributes: ReadonlyMap<string, string>;
  readonly name: string;
  readonly selfClosing: boolean;
}

function parseStartTag(tag: string): ParsedStartTag {
  const interior = tag.slice(1, -1).trim();
  const selfClosing = interior.endsWith("/");
  const content = (selfClosing ? interior.slice(0, -1) : interior).trim();
  const nameMatch = /^([A-Za-z][A-Za-z0-9:_-]*)(.*)$/su.exec(content);
  const name = nameMatch?.[1];
  let remaining = nameMatch?.[2];

  if (name === undefined || remaining === undefined) {
    throw new LatexSvgRenderError("unsafe_svg", "Rendered SVG contains invalid markup.");
  }

  const attributes = new Map<string, string>();

  while (remaining.length > 0) {
    const attributeMatch = /^\s+([A-Za-z][A-Za-z0-9:._-]*)="([^"]*)"/su.exec(remaining);
    const attributeName = attributeMatch?.[1];
    const attributeValue = attributeMatch?.[2];
    const fullAttribute = attributeMatch?.[0];

    if (
      attributeName === undefined ||
      attributeValue === undefined ||
      fullAttribute === undefined ||
      attributes.has(attributeName)
    ) {
      throw new LatexSvgRenderError("unsafe_svg", "Rendered SVG contains invalid attributes.");
    }

    attributes.set(attributeName, attributeValue);
    remaining = remaining.slice(fullAttribute.length);
  }

  return { attributes, name, selfClosing };
}

function validateAttributes(elementName: string, attributes: ReadonlyMap<string, string>): void {
  for (const [name, value] of attributes) {
    if (!safeAttributeNames.has(name) && !name.startsWith("data-")) {
      throw new LatexSvgRenderError(
        "unsafe_svg",
        `Rendered SVG contains disallowed ${name} attribute.`,
      );
    }

    // MathJax echoes canonical TeX in data-latex. XML permits tab, LF, and CR in an attribute,
    // and preserving those whitespace bytes is required for multi-line AMS input; all other
    // controls remain rejected. Presentation attributes never receive this relaxation.
    if (
      /^(?:href|xlink:href)$/iu.test(name) ||
      containsUnsafeControlCharacter(value, name === "data-latex")
    ) {
      throw new LatexSvgRenderError("unsafe_svg", "Rendered SVG contains an unsafe attribute.");
    }

    if (name === "style" && /(?:url\s*\(|@import|expression\s*\(|javascript\s*:)/iu.test(value)) {
      throw new LatexSvgRenderError("unsafe_svg", "Rendered SVG contains unsafe style content.");
    }

    if (name === "xmlns" && (elementName !== "svg" || value !== "http://www.w3.org/2000/svg")) {
      throw new LatexSvgRenderError("unsafe_svg", "Rendered SVG has an unexpected namespace.");
    }
  }
}

function containsUnsafeControlCharacter(value: string, allowXmlWhitespace = false): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint !== undefined &&
      (codePoint === 0x7f ||
        (codePoint <= 0x1f && !(allowXmlWhitespace && [0x09, 0x0a, 0x0d].includes(codePoint))))
    ) {
      return true;
    }
  }

  return false;
}

function validateViewBox(svg: string): void {
  const rootMatch = /^<svg\b[^>]*\bviewBox="([^"]+)"[^>]*>/u.exec(svg);
  const rawViewBox = rootMatch?.[1];

  if (rawViewBox === undefined) {
    throw new LatexSvgRenderError("unsafe_svg", "Rendered SVG has no viewBox.");
  }

  const dimensions = rawViewBox.trim().split(/\s+/u).map(Number);
  if (
    dimensions.length !== 4 ||
    dimensions.some((dimension) => !Number.isFinite(dimension)) ||
    Math.abs(dimensions[2] ?? Number.POSITIVE_INFINITY) > maximumViewBoxDimension ||
    Math.abs(dimensions[3] ?? Number.POSITIVE_INFINITY) > maximumViewBoxDimension
  ) {
    throw new LatexSvgRenderError("unsafe_svg", "Rendered SVG has an unsafe viewBox.");
  }
}
