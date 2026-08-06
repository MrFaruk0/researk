import { describe, expect, it } from "vitest";
import {
  CanonicalModelIdSchema,
  canonicalModelId,
  ModelCapabilitiesSchema,
  ModelCatalogSchema,
  ModelDescriptorSchema,
  NormalizedErrorSchema,
  ProviderIdSchema,
  RunEventSchema,
  RunRequestSchema,
  splitCanonicalModelId,
} from "../src/index.js";

const capabilities = ModelCapabilitiesSchema.parse({
  streaming: true,
  toolCalls: false,
  structuredOutput: true,
  vision: false,
  files: false,
  contextWindowTokens: 128_000,
  maxOutputTokens: 8_192,
  reasoning: {
    supported: true,
    intents: ["auto", "off", "low", "high"],
    nativeOverride: true,
  },
});

const descriptor = ModelDescriptorSchema.parse({
  providerId: "local",
  modelId: "research:latest",
  canonicalId: "local:research:latest",
  displayName: "Research Latest",
  capabilities,
  status: "available",
  catalogSource: "live",
  discoveredAt: "2026-08-06T12:00:00.000Z",
});

describe("model identities", () => {
  it("preserves colons inside dynamic model IDs", () => {
    const identity = canonicalModelId("local", "research:latest");
    expect(identity).toBe("local:research:latest");
    expect(splitCanonicalModelId(identity)).toEqual({
      providerId: "local",
      modelId: "research:latest",
    });
  });

  it("rejects invalid providers and control text", () => {
    expect(ProviderIdSchema.safeParse("OpenAI").success).toBe(false);
    expect(CanonicalModelIdSchema.safeParse("local:bad\u001b[31m").success).toBe(false);
  });

  it("rejects a mismatched canonical identity", () => {
    expect(
      ModelDescriptorSchema.safeParse({
        ...descriptor,
        canonicalId: "other:research:latest",
      }).success,
    ).toBe(false);
  });

  it("rejects duplicate and cross-provider catalog entries", () => {
    const result = ModelCatalogSchema.safeParse({
      provider: { providerId: "local", displayName: "Local", kind: "local" },
      models: [descriptor, descriptor],
      source: "live",
      refreshedAt: "2026-08-06T12:00:00.000Z",
      stale: false,
    });
    expect(result.success).toBe(false);
  });

  it("records a missing provider revision explicitly", () => {
    expect(ModelDescriptorSchema.parse(descriptor).revision).toBeNull();
  });

  it("rejects contradictory normalized reasoning metadata", () => {
    expect(
      ModelCapabilitiesSchema.safeParse({
        ...capabilities,
        reasoning: {
          supported: true,
          intents: ["off"],
          nativeOverride: false,
          mandatory: true,
        },
      }).success,
    ).toBe(false);
  });
});

describe("run contracts", () => {
  it("applies safe request defaults", () => {
    const request = RunRequestSchema.parse({
      schemaVersion: 1,
      runId: "run-1",
      selection: { providerId: "local", modelId: "research:latest" },
      messages: [{ role: "user", content: "Explain the result." }],
    });

    expect(request.selection.reasoning).toEqual({ intent: "auto" });
    expect(request.requiredCapabilities).toEqual({});
    expect(request.toolPermissions).toEqual([]);
    expect(request.stream).toBe(true);
    expect(Object.isFrozen(request)).toBe(true);
  });

  it("parses a selection event and rejects unknown event fields", () => {
    const event = {
      schemaVersion: 1,
      runId: "run-1",
      sequence: 0,
      timestamp: "2026-08-06T12:00:00.000Z",
      type: "selection",
      selection: {
        providerId: "local",
        modelId: "research:latest",
        canonicalId: "local:research:latest",
        capabilities,
        reasoning: {
          requestedIntent: "auto",
          effectiveIntent: "auto",
          usedNativeOverride: false,
          diagnostics: [],
        },
      },
    } as const;

    expect(RunEventSchema.parse(event).type).toBe("selection");
    expect(RunEventSchema.safeParse({ ...event, unsafe: true }).success).toBe(false);
  });

  it("parses every terminal run event", () => {
    const base = {
      schemaVersion: 1,
      runId: "run-1",
      sequence: 4,
      timestamp: "2026-08-06T12:00:00.000Z",
    } as const;

    expect(RunEventSchema.parse({ ...base, type: "text_delta", delta: "Result" }).type).toBe(
      "text_delta",
    );
    expect(
      RunEventSchema.parse({ ...base, type: "cancelled", reason: "User cancelled" }).type,
    ).toBe("cancelled");
    expect(
      RunEventSchema.parse({
        ...base,
        type: "error",
        error: { code: "timeout", message: "Provider timed out", retryable: true },
      }).type,
    ).toBe("error");
  });
});

describe("safe errors", () => {
  it("rejects terminal controls in public error messages", () => {
    expect(
      NormalizedErrorSchema.safeParse({
        code: "provider_protocol_error",
        message: "bad\u001b[2J",
        retryable: false,
      }).success,
    ).toBe(false);
  });
});
