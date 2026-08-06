import { canonicalModelId, ModelDescriptorSchema, RunRequestSchema } from "@researk/contracts";
import type { ProviderContext, ResolvedProviderSelection } from "@researk/harness";
import { describe, expect, it, vi } from "vitest";
import { OpenAiCompatibleAdapter } from "../src/index.js";

const capabilities = {
  streaming: true,
  toolCalls: false,
  structuredOutput: false,
  vision: false,
  files: false,
  reasoning: { supported: true, intents: ["high"] as const, nativeOverride: false },
};
const context: ProviderContext = {
  credentials: { resolve: async () => "top-secret" },
  signal: new AbortController().signal,
};

describe("OpenAiCompatibleAdapter", () => {
  it("discovers unknown valid models without claiming capabilities", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ data: [{ id: "new-model" }, { id: "bad\u001b[31m" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const adapter = createAdapter(fetch);
    const catalog = await adapter.discoverModels(context);
    expect(catalog.models).toHaveLength(1);
    expect(catalog.models[0]).toMatchObject({ modelId: "new-model", status: "unknown" });
    expect(catalog.models[0]?.capabilities.streaming).toBe(false);
  });

  it("parses split SSE chunks and DONE", async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode('data: {"model":"known","choices":[{"delta":{"content":"Hel'),
        );
        controller.enqueue(encoder.encode('lo"},"finish_reason":null}]}\n\n'));
        controller.enqueue(
          encoder.encode(
            'data: {"model":"known","choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
          ),
        );
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    const fetch = vi.fn(
      async () =>
        new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
    );
    const adapter = createAdapter(fetch);
    const events = [];
    for await (const event of adapter.stream(run(adapter), context)) events.push(event);
    expect(events).toEqual([
      { type: "text_delta", delta: "Hello", responseModelId: "known" },
      { type: "completed", finishReason: "stop", responseModelId: "known" },
    ]);
  });

  it("maps only configured reasoning fields", async () => {
    const adapter = createAdapter(vi.fn());
    const model = descriptor(adapter);
    const resolved = await adapter.resolveReasoning(model, { intent: "high" });
    expect(resolved.nativeOptions).toEqual({ reasoning_effort: "high" });
    await expect(adapter.resolveReasoning(model, { intent: "low" })).rejects.toMatchObject({
      normalized: { code: "capability_missing" },
    });
  });

  it("redacts credentials from HTTP errors", async () => {
    const fetch = vi.fn(async () => new Response("api_key=top-secret", { status: 401 }));
    const adapter = createAdapter(fetch);
    await expect(adapter.discoverModels(context)).rejects.toMatchObject({
      normalized: {
        code: "provider_http_error",
        message: expect.not.stringContaining("top-secret"),
      },
    });
  });

  it("normalizes malformed JSON as a provider protocol error", async () => {
    const fetch = vi.fn(
      async () =>
        new Response('{"data":', {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const adapter = createAdapter(fetch);
    await expect(adapter.discoverModels(context)).rejects.toMatchObject({
      normalized: { code: "provider_protocol_error" },
    });
  });

  it("propagates caller cancellation to fetch", async () => {
    const controller = new AbortController();
    controller.abort(new DOMException("cancelled", "AbortError"));
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      init?.signal?.throwIfAborted();
      return new Response();
    });
    const adapter = createAdapter(fetch);
    await expect(
      adapter.discoverModels({ credentials: context.credentials, signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("rejects response model substitution", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            model: "different-model",
            choices: [{ message: { content: "No" }, finish_reason: "stop" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const adapter = createAdapter(fetch);
    const events = adapter.stream(run(adapter), context);
    await expect(collect(events)).rejects.toMatchObject({
      normalized: { code: "model_substitution" },
    });
  });
});

function createAdapter(fetch: typeof globalThis.fetch) {
  return new OpenAiCompatibleAdapter({
    providerId: "compatible",
    displayName: "Compatible provider",
    baseUrl: "https://provider.invalid/v1/",
    apiKeyReference: "provider-key",
    fetch,
    capabilities: { known: capabilities },
    reasoning: { high: { field: "reasoning_effort", value: "high" } },
  });
}

function descriptor(adapter: OpenAiCompatibleAdapter) {
  return ModelDescriptorSchema.parse({
    providerId: adapter.descriptor.providerId,
    modelId: "known",
    canonicalId: canonicalModelId(adapter.descriptor.providerId, "known"),
    displayName: "Known",
    capabilities,
    status: "available",
    catalogSource: "configured",
  });
}

function run(adapter: OpenAiCompatibleAdapter) {
  const selection: ResolvedProviderSelection = {
    selection: {
      providerId: adapter.descriptor.providerId,
      modelId: "known",
      canonicalId: canonicalModelId(adapter.descriptor.providerId, "known"),
      capabilities,
      reasoning: { requestedIntent: "auto", usedNativeOverride: false, diagnostics: [] },
    },
    nativeOptions: {},
  };
  return {
    run: RunRequestSchema.parse({
      schemaVersion: 1,
      runId: "run-provider",
      selection: { providerId: adapter.descriptor.providerId, modelId: "known" },
      messages: [{ role: "user", content: "Hello" }],
    }),
    resolved: selection,
  };
}

async function collect<T>(values: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const value of values) result.push(value);
  return result;
}
