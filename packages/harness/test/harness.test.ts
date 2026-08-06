import {
  canonicalModelId,
  EffectiveReasoningSchema,
  type ModelCatalog,
  ModelDescriptorSchema,
  ProviderDescriptorSchema,
  RunRequestSchema,
} from "@researk/contracts";
import { describe, expect, it } from "vitest";
import {
  FakeProviderAdapter,
  Harness,
  type ProviderAdapter,
  ProviderRegistry,
} from "../src/index.js";

const provider = ProviderDescriptorSchema.parse({
  providerId: "fake",
  displayName: "Fake provider",
  kind: "local",
});
const model = ModelDescriptorSchema.parse({
  providerId: "fake",
  modelId: "research-model",
  canonicalId: canonicalModelId("fake", "research-model"),
  displayName: "Research model",
  capabilities: {
    streaming: true,
    toolCalls: false,
    structuredOutput: false,
    vision: false,
    files: false,
    reasoning: { supported: true, intents: ["low", "high"], nativeOverride: false },
  },
  status: "available",
  catalogSource: "configured",
});
const request = RunRequestSchema.parse({
  schemaVersion: 1,
  runId: "run-1",
  selection: { providerId: "fake", modelId: "research-model", reasoning: { intent: "high" } },
  messages: [{ role: "user", content: "Explain the evidence." }],
  requiredCapabilities: { streaming: true, reasoningIntent: "high" },
});
const credentials = { resolve: async () => "unused" };

describe("ProviderRegistry", () => {
  it("rejects duplicate provider IDs", () => {
    const registry = new ProviderRegistry();
    const adapter = new FakeProviderAdapter({ descriptor: provider, models: [model], events: [] });
    registry.register(adapter);
    expect(() => registry.register(adapter)).toThrow(/already registered/u);
  });

  it("rejects missing declared capabilities", async () => {
    const registry = new ProviderRegistry();
    registry.register(
      new FakeProviderAdapter({ descriptor: provider, models: [model], events: [] }),
    );
    await expect(
      registry.resolve(
        request.selection,
        { toolCalls: true },
        {
          credentials,
          signal: new AbortController().signal,
        },
      ),
    ).rejects.toMatchObject({ normalized: { code: "capability_missing" } });
  });

  it("rejects duplicate catalog models instead of hiding one", async () => {
    const registry = new ProviderRegistry();
    registry.register(duplicateCatalogAdapter());
    await expect(
      registry.discover("fake", { credentials, signal: new AbortController().signal }),
    ).rejects.toMatchObject({ normalized: { code: "provider_protocol_error" } });
  });

  it("rejects an explicitly unavailable model selection", async () => {
    const registry = new ProviderRegistry();
    registry.register(
      new FakeProviderAdapter({
        descriptor: provider,
        models: [ModelDescriptorSchema.parse({ ...model, status: "unavailable" })],
        events: [],
      }),
    );
    await expect(
      registry.resolve(
        request.selection,
        {},
        { credentials, signal: new AbortController().signal },
      ),
    ).rejects.toMatchObject({ normalized: { code: "model_unavailable" } });
  });
});

describe("Harness", () => {
  it("streams UI-neutral typed events in process", async () => {
    const registry = new ProviderRegistry();
    registry.register(
      new FakeProviderAdapter({
        descriptor: provider,
        models: [model],
        events: [
          { type: "text_delta", delta: "Evidence" },
          { type: "completed", finishReason: "stop" },
        ],
      }),
    );
    const harness = new Harness({
      registry,
      credentials,
      now: () => new Date("2026-08-06T00:00:00.000Z"),
    });
    const events = [];
    for await (const event of harness.run(request)) events.push(event);
    expect(events.map((event) => event.type)).toEqual([
      "phase",
      "selection",
      "phase",
      "phase",
      "text_delta",
      "phase",
      "completed",
    ]);
    expect(events.map((event) => event.sequence)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("rejects provider model substitution", async () => {
    const registry = new ProviderRegistry();
    registry.register(
      new FakeProviderAdapter({
        descriptor: provider,
        models: [model],
        events: [{ type: "completed", finishReason: "stop", responseModelId: "other" }],
      }),
    );
    const harness = new Harness({ registry, credentials });
    const events = [];
    for await (const event of harness.run(request)) events.push(event);
    expect(events.at(-1)).toMatchObject({ type: "error", error: { code: "model_substitution" } });
  });

  it("stops consuming provider events after the first completion", async () => {
    const registry = new ProviderRegistry();
    registry.register(
      new FakeProviderAdapter({
        descriptor: provider,
        models: [model],
        events: [
          { type: "completed", finishReason: "stop" },
          { type: "text_delta", delta: "must not be emitted" },
        ],
      }),
    );
    const harness = new Harness({ registry, credentials });
    const events = [];
    for await (const event of harness.run(request)) events.push(event);
    expect(events.filter((event) => event.type === "text_delta")).toEqual([]);
    expect(events.at(-1)?.type).toBe("completed");
  });
});

function duplicateCatalogAdapter(): ProviderAdapter {
  return {
    descriptor: provider,
    async discoverModels() {
      return {
        provider,
        models: [model, model],
        source: "live",
        refreshedAt: "2026-08-06T00:00:00.000Z",
        stale: false,
      } as unknown as ModelCatalog;
    },
    async resolveReasoning() {
      return {
        reasoning: EffectiveReasoningSchema.parse({
          requestedIntent: "auto",
          usedNativeOverride: false,
          diagnostics: [],
        }),
        nativeOptions: {},
      };
    },
    async *stream() {
      yield { type: "completed" as const, finishReason: "stop" as const };
    },
  };
}
