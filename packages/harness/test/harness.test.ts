import {
  canonicalModelId,
  ModelDescriptorSchema,
  ProviderDescriptorSchema,
  RunRequestSchema,
} from "@researk/contracts";
import { describe, expect, it } from "vitest";
import { FakeProviderAdapter, Harness, ProviderRegistry } from "../src/index.js";

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
});
