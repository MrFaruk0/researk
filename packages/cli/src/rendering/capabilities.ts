import type { TerminalCapability, TerminalGraphicsProtocol } from "./terminal.js";
import type {
  CellPixelDimensions,
  KittyGraphicsResponse,
  TerminalCapabilityProbeResult,
} from "./terminal-query.js";

/**
 * The protocol evidence retained by the capability layer.
 *
 * Probe replay bytes are intentionally not copied here: they are user input, not capability
 * evidence, and retaining them would make this value unsuitable for long-lived application state.
 */
export interface TerminalProtocolEvidence {
  readonly protocol: TerminalGraphicsProtocol;
  readonly reason: string;
  readonly kittyResponse?: KittyGraphicsResponse;
  readonly da1Parameters?: readonly number[];
  readonly cellPixels?: CellPixelDimensions;
}

/** Explicit, already-detected terminal signals supplied by the caller. */
export interface TerminalCapabilitySignals {
  /** False disables graphics regardless of the protocol evidence. */
  readonly isTTY?: boolean;
  /** False disables graphics and mouse input. Defaults to true for a probed result. */
  readonly interactive?: boolean;
  /** Accessible output never emits graphics or color styling. */
  readonly accessible?: boolean;
  /** Mouse support must be positively detected by the caller; it is false when omitted. */
  readonly mouse?: boolean;
  /** True-color support must be positively detected by the caller; it is false when omitted. */
  readonly trueColor?: boolean;
}

/**
 * A normalized, presentation-neutral terminal capability value.
 *
 * `protocol` is the effective protocol after TTY/output-mode gates. `detectedProtocol` and
 * `evidence` retain what the upstream terminal probe observed, which is useful for diagnostics
 * without allowing a non-interactive caller to accidentally select a graphics renderer.
 */
export interface TerminalCapabilities {
  readonly kittyGraphics: boolean;
  readonly sixel: boolean;
  readonly itermImages: boolean;
  readonly mouse: boolean;
  readonly trueColor: boolean;
  readonly protocol?: TerminalGraphicsProtocol;
  readonly detectedProtocol?: TerminalGraphicsProtocol;
  readonly reason?: string;
  readonly evidence?: TerminalProtocolEvidence;
  readonly isTTY?: boolean;
  readonly interactive?: boolean;
  readonly accessible?: boolean;
}

export type TerminalCapabilityEvidence = TerminalCapability | TerminalCapabilityProbeResult;

/**
 * Convert the existing synchronous capability or bounded probe result into the central shape.
 * This function deliberately performs no environment inspection. Environment and protocol
 * evidence remain the responsibility of `detectTerminalCapability`/`probeTerminalCapability`.
 */
export function createTerminalCapabilities(
  input: TerminalCapabilityEvidence,
  signals: TerminalCapabilitySignals = {},
): TerminalCapabilities {
  const isTTY = signals.isTTY !== false;
  const interactive = signals.interactive !== false;
  const accessible = signals.accessible === true;
  const graphicsAllowed = isTTY && interactive && !accessible;
  const detectedProtocol = input.protocol;
  const protocol = graphicsAllowed ? detectedProtocol : "unsupported";

  const evidence = protocolEvidence(input);
  const reason = graphicsAllowed
    ? input.reason
    : accessible
      ? "graphics disabled for accessible output"
      : !interactive
        ? "graphics disabled for non-interactive output"
        : !isTTY
          ? "graphics disabled because output is not a TTY"
          : input.reason;

  return Object.freeze({
    kittyGraphics: protocol === "kitty",
    sixel: protocol === "sixel",
    itermImages: protocol === "iterm2",
    mouse: signals.mouse === true && isTTY && interactive && !accessible,
    trueColor: signals.trueColor === true && isTTY && interactive && !accessible,
    protocol,
    detectedProtocol,
    reason,
    evidence,
    isTTY,
    interactive,
    accessible,
  });
}

/** Descriptive alias for callers that start from the asynchronous probe result. */
export const terminalCapabilitiesFromProbe = createTerminalCapabilities;

/** Descriptive alias for callers that already have a synchronous terminal capability. */
export const adaptTerminalCapability = createTerminalCapabilities;

/** Alias for callers that prefer normalization terminology. */
export const normalizeTerminalCapabilities = createTerminalCapabilities;

function protocolEvidence(input: TerminalCapabilityEvidence): TerminalProtocolEvidence {
  const candidate = input as Partial<TerminalCapabilityProbeResult>;
  return Object.freeze({
    protocol: input.protocol,
    reason: input.reason,
    ...(candidate.kittyResponse === undefined ? {} : { kittyResponse: candidate.kittyResponse }),
    ...(candidate.da1Parameters === undefined ? {} : { da1Parameters: candidate.da1Parameters }),
    ...(candidate.cellPixels === undefined ? {} : { cellPixels: candidate.cellPixels }),
  });
}

export type FormulaRendererId = "kitty" | "sixel" | "iterm2" | "exact-source";
export type FormulaRendererKind = "graphics" | "exact-source";

/** Structured formula data. Renderers must never replace this canonical source with pixels. */
export interface FormulaArtifact {
  readonly id: string;
  /** Canonical expression sent to a math backend, normally without display delimiters. */
  readonly latex: string;
  /** Exact original source, including delimiters when the parser retained them. */
  readonly originalLatex: string;
  readonly parsed?: MathAst;
  readonly metadata?: FormulaMetadata;
}

/** Deliberately open for a future parser/AST package without coupling capability selection to it. */
export type MathAst = unknown;
export type FormulaMetadata = Readonly<Record<string, unknown>>;

export interface FormulaRenderStyle {
  readonly foreground: string;
  readonly background?: string;
  readonly fontScale: number;
  readonly dpi: number;
}

export interface FormulaRenderResult {
  readonly format: "graphics" | "source";
  /** Always the exact source retained by the artifact. */
  readonly source: string;
  /** Disposable renderer-owned presentation data, when available. */
  readonly content: string | Uint8Array;
}

export type FormulaRendererRender = (
  formula: FormulaArtifact,
  style?: FormulaRenderStyle,
) => FormulaRenderResult | Promise<FormulaRenderResult>;

export interface FormulaRendererSelectionOptions {
  readonly isTTY?: boolean;
  readonly interactive?: boolean;
  readonly accessible?: boolean;
}

export type FormulaRendererCapabilityInput = TerminalCapabilities | TerminalCapabilityEvidence;

/**
 * A selection descriptor. Graphics implementations can attach their render function later; the
 * selection layer itself remains independent from MathJax, terminal writers, and TUI layout.
 */
export interface FormulaRendererDescriptor {
  readonly id: FormulaRendererId;
  readonly kind: FormulaRendererKind;
  readonly isSupported: (
    capabilities: FormulaRendererCapabilityInput,
    options?: FormulaRendererSelectionOptions,
  ) => boolean;
  readonly render?: FormulaRendererRender;
}

/** Alias matching the conceptual domain name used by future TUI integrations. */
export type FormulaRenderer = FormulaRendererDescriptor;

const graphicsSelectionAllowed = (
  capabilities: FormulaRendererCapabilityInput,
  options: FormulaRendererSelectionOptions = {},
): boolean => {
  const normalized = normalizeRendererCapabilities(capabilities);
  return (
    options.isTTY !== false &&
    options.interactive !== false &&
    options.accessible !== true &&
    normalized.isTTY !== false &&
    normalized.interactive !== false &&
    normalized.accessible !== true
  );
};

function normalizeRendererCapabilities(
  capabilities: FormulaRendererCapabilityInput,
): TerminalCapabilities {
  if ("kittyGraphics" in capabilities && "sixel" in capabilities && "itermImages" in capabilities) {
    return capabilities;
  }
  return createTerminalCapabilities(capabilities);
}

function supportsProtocol(
  protocol: "kitty" | "sixel" | "iterm2",
): FormulaRendererDescriptor["isSupported"] {
  return (capabilities, options = {}) => {
    if (!graphicsSelectionAllowed(capabilities, options)) return false;
    const normalized = normalizeRendererCapabilities(capabilities);
    const positivelyDetected =
      protocol === "kitty"
        ? normalized.kittyGraphics
        : protocol === "sixel"
          ? normalized.sixel
          : normalized.itermImages;
    // A hand-built capability fixture may provide only the required booleans. When protocol is
    // present, it remains authoritative so contradictory evidence fails closed.
    return (
      positivelyDetected && (normalized.protocol === undefined || normalized.protocol === protocol)
    );
  };
}

/** Enhanced Kitty Graphics Protocol descriptor. No terminal brand/process name is inspected. */
export const KITTY_FORMULA_RENDERER: FormulaRendererDescriptor = Object.freeze({
  id: "kitty",
  kind: "graphics",
  isSupported: supportsProtocol("kitty"),
});

/** Sixel graphics descriptor for terminals with positively proven Sixel support. */
export const SIXEL_FORMULA_RENDERER: FormulaRendererDescriptor = Object.freeze({
  id: "sixel",
  kind: "graphics",
  isSupported: supportsProtocol("sixel"),
});

/** iTerm inline-image descriptor for terminals with positively proven iTerm2 support. */
export const ITERM_FORMULA_RENDERER: FormulaRendererDescriptor = Object.freeze({
  id: "iterm2",
  kind: "graphics",
  isSupported: supportsProtocol("iterm2"),
});

/**
 * Lossless fallback. ADR 0006 rejects automatic Unicode approximation, so this renderer returns
 * the exact original source for every formula, including unsupported constructs and delimiters.
 */
export const EXACT_SOURCE_FORMULA_RENDERER: FormulaRendererDescriptor = Object.freeze({
  id: "exact-source",
  kind: "exact-source",
  isSupported: () => true,
  render: (formula: FormulaArtifact): FormulaRenderResult => ({
    format: "source",
    source: formula.originalLatex,
    content: formula.originalLatex,
  }),
});

/** Renderer precedence: enhanced protocol first, then the lossless source fallback. */
export const FORMULA_RENDERERS: readonly FormulaRendererDescriptor[] = Object.freeze([
  KITTY_FORMULA_RENDERER,
  SIXEL_FORMULA_RENDERER,
  ITERM_FORMULA_RENDERER,
  EXACT_SOURCE_FORMULA_RENDERER,
]);

/** Select the highest-fidelity renderer supported by the normalized capability value. */
export function selectFormulaRenderer(
  capabilities: FormulaRendererCapabilityInput,
  options: FormulaRendererSelectionOptions = {},
  renderers: readonly FormulaRendererDescriptor[] = FORMULA_RENDERERS,
): FormulaRendererDescriptor {
  for (const renderer of renderers) {
    if (renderer.isSupported(capabilities, options)) return renderer;
  }
  return EXACT_SOURCE_FORMULA_RENDERER;
}

/** Render exact source without any lossy terminal-native conversion. */
export function renderExactFormulaSource(formula: FormulaArtifact): FormulaRenderResult {
  return {
    format: "source",
    source: formula.originalLatex,
    content: formula.originalLatex,
  };
}
