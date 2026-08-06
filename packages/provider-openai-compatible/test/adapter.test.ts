import {
  canonicalModelId,
  ModelCapabilitiesSchema,
  ModelDescriptorSchema,
  ModelSelectionSchema,
  RunRequestSchema,
} from "@researk/contracts";
import type { ProviderContext, ResolvedProviderSelection } from "@researk/harness";
import { describe, expect, it } from "vitest";
import { OpenAiCompatibleAdapter, parseSse } from "../src/index.js";
import { nextTurn, readRequestBody, sendJson, withLoopbackServer } from "./loopback.js";

const SYNTHETIC_SECRET = "synthetic-test-secret";
const capabilities = ModelCapabilitiesSchema.parse({
  streaming: true,
  toolCalls: false,
  structuredOutput: false,
  vision: false,
  files: false,
  reasoning: { supported: true, intents: ["high"], nativeOverride: false },
});

describe("OpenAiCompatibleAdapter", () => {
  it("discovers unknown valid models over a real loopback connection", async () => {
    let authorization: string | undefined;
    await withLoopbackServer(
      (request, response) => {
        authorization = request.headers.authorization;
        sendJson(response, { data: [{ id: "new-model" }, { id: "bad\u001b[31m" }] });
      },
      async ({ baseUrl }) => {
        const catalog = await createAdapter(baseUrl).discoverModels(context());
        expect(catalog.models).toHaveLength(1);
        expect(catalog.models[0]).toMatchObject({
          modelId: "new-model",
          revision: null,
          status: "unknown",
        });
        expect(catalog.models[0]?.capabilities.streaming).toBe(false);
      },
    );
    expect(authorization).toBe(`Bearer ${SYNTHETIC_SECRET}`);
  });

  it("rejects duplicate discovered model IDs instead of hiding one", async () => {
    await withLoopbackServer(
      (_request, response) => sendJson(response, { data: [{ id: "same" }, { id: "same" }] }),
      async ({ baseUrl }) => {
        await expect(createAdapter(baseUrl).discoverModels(context())).rejects.toMatchObject({
          normalized: { code: "provider_protocol_error" },
        });
      },
    );
  });

  it("parses split SSE data, stops at completion, and closes the response", async () => {
    let responseClosed: Promise<void> | undefined;
    await withLoopbackServer(
      async (request, response) => {
        if (request.url !== "/v1/chat/completions") {
          response.writeHead(404).end();
          return;
        }
        responseClosed = new Promise((resolve) => response.once("close", resolve));
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write('data: {"model":"known","choices":[{"delta":{"content":"Hel');
        await nextTurn();
        response.write('lo"},"finish_reason":null}]}\n\n');
        await nextTurn();
        response.write(
          'data: {"model":"known","choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
        );
      },
      async ({ baseUrl }) => {
        const adapter = createAdapter(baseUrl);
        const events = await collect(adapter.stream(run(adapter), context()));
        expect(events).toEqual([
          { type: "text_delta", delta: "Hello", responseModelId: "known" },
          { type: "completed", finishReason: "stop", responseModelId: "known" },
        ]);
        await expectResponseClosed(responseClosed);
      },
    );
  });

  it("maps only configured reasoning fields in a real completion request", async () => {
    let body: Record<string, unknown> | undefined;
    await withLoopbackServer(
      async (request, response) => {
        body = JSON.parse(await readRequestBody(request)) as Record<string, unknown>;
        sendJson(response, {
          model: "known",
          choices: [{ message: { content: "Done" }, finish_reason: "stop" }],
        });
      },
      async ({ baseUrl }) => {
        const adapter = createAdapter(baseUrl);
        const model = descriptor(adapter);
        const reasoning = await adapter.resolveReasoning(model, { intent: "high" });
        expect(reasoning.nativeOptions).toEqual({ reasoning_effort: "high" });
        await expect(adapter.resolveReasoning(model, { intent: "low" })).rejects.toMatchObject({
          normalized: { code: "capability_missing" },
        });
        await collect(
          adapter.stream(run(adapter, resolvedWithReasoning(adapter, reasoning)), context()),
        );
      },
    );
    expect(body).toMatchObject({ model: "known", reasoning_effort: "high", stream: true });
  });

  it("redacts credentials from real HTTP error responses", async () => {
    await withLoopbackServer(
      (_request, response) => {
        response.writeHead(401, { "content-type": "text/plain" });
        response.end(`api_key=${SYNTHETIC_SECRET}`);
      },
      async ({ baseUrl }) => {
        await expect(createAdapter(baseUrl).discoverModels(context())).rejects.toMatchObject({
          normalized: {
            code: "provider_http_error",
            message: expect.not.stringContaining(SYNTHETIC_SECRET),
          },
        });
      },
    );
  });

  it("normalizes malformed JSON from a real response", async () => {
    await withLoopbackServer(
      (_request, response) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"data":');
      },
      async ({ baseUrl }) => {
        await expect(createAdapter(baseUrl).discoverModels(context())).rejects.toMatchObject({
          normalized: { code: "provider_protocol_error" },
        });
      },
    );
  });

  it("rejects unsafe base URLs and invalid numeric limits before network access", () => {
    for (const baseUrl of [
      "https://user:password@provider.invalid/v1/",
      "https://provider.invalid/v1/?api_key=bad",
      "https://provider.invalid/v1/#fragment",
      "ftp://localhost/v1/",
      "http://provider.invalid/v1/",
    ]) {
      expect(() => createAdapter(baseUrl)).toThrow(TypeError);
    }
    for (const timeoutMs of [0, -1, 1.5, Number.NaN, 3_600_001]) {
      expect(() => createAdapter("https://provider.invalid/v1/", { timeoutMs })).toThrow(TypeError);
    }
    for (const maxBodyBytes of [0, -1, 1.5, Number.NaN, 64_000_001]) {
      expect(() => createAdapter("https://provider.invalid/v1/", { maxBodyBytes })).toThrow(
        TypeError,
      );
    }
  });

  it("preserves caller cancellation after response headers and closes the reader", async () => {
    let headersSent: (() => void) | undefined;
    const receivedHeaders = new Promise<void>((resolve) => {
      headersSent = resolve;
    });
    let responseClosed: Promise<void> | undefined;
    await withLoopbackServer(
      (_request, response) => {
        responseClosed = new Promise((resolve) => response.once("close", resolve));
        response.writeHead(200, { "content-type": "application/json" });
        response.flushHeaders();
        headersSent?.();
      },
      async ({ baseUrl }) => {
        const controller = new AbortController();
        const discovery = createAdapter(baseUrl).discoverModels(context(controller.signal));
        await receivedHeaders;
        controller.abort(new DOMException("cancelled", "AbortError"));
        await expect(discovery).rejects.toMatchObject({ name: "AbortError" });
        await expectResponseClosed(responseClosed);
      },
    );
  });

  it("classifies a JSON body stall after headers as a provider timeout", async () => {
    let headersSent: (() => void) | undefined;
    const receivedHeaders = new Promise<void>((resolve) => {
      headersSent = resolve;
    });
    let responseClosed: Promise<void> | undefined;
    await withLoopbackServer(
      (_request, response) => {
        responseClosed = new Promise((resolve) => response.once("close", resolve));
        response.writeHead(200, { "content-type": "application/json" });
        response.flushHeaders();
        headersSent?.();
      },
      async ({ baseUrl }) => {
        const discovery = createAdapter(baseUrl, { timeoutMs: 20 }).discoverModels(context());
        await receivedHeaders;
        await expect(discovery).rejects.toMatchObject({ normalized: { code: "timeout" } });
        await expectResponseClosed(responseClosed);
      },
    );
  });

  it("classifies an SSE body stall after headers as a provider timeout", async () => {
    let headersSent: (() => void) | undefined;
    const receivedHeaders = new Promise<void>((resolve) => {
      headersSent = resolve;
    });
    let responseClosed: Promise<void> | undefined;
    await withLoopbackServer(
      (_request, response) => {
        responseClosed = new Promise((resolve) => response.once("close", resolve));
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.flushHeaders();
        headersSent?.();
      },
      async ({ baseUrl }) => {
        const adapter = createAdapter(baseUrl, { timeoutMs: 20 });
        const streaming = collect(adapter.stream(run(adapter), context()));
        await receivedHeaders;
        await expect(streaming).rejects.toMatchObject({ normalized: { code: "timeout" } });
        await expectResponseClosed(responseClosed);
      },
    );
  });

  it("rejects response model substitution over the network", async () => {
    await withLoopbackServer(
      (_request, response) =>
        sendJson(response, {
          model: "different-model",
          choices: [{ message: { content: "No" }, finish_reason: "stop" }],
        }),
      async ({ baseUrl }) => {
        const adapter = createAdapter(baseUrl);
        await expect(collect(adapter.stream(run(adapter), context()))).rejects.toMatchObject({
          normalized: { code: "model_substitution" },
        });
      },
    );
  });

  it("enforces the same SSE event limit regardless of response chunking", async () => {
    const payload = "x".repeat(20);
    await withLoopbackServer(
      async (_request, response) => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(`data: ${payload.slice(0, 10)}`);
        await nextTurn();
        response.write(`${payload.slice(10)}\n`);
        await nextTurn();
        response.end("\n");
      },
      async ({ baseUrl }) => {
        const response = await fetch(new URL("sse", baseUrl));
        if (response.body === null) throw new Error("Test server returned an empty stream.");
        await expect(collect(parseSse(response.body, { maxEventBytes: 27 }))).rejects.toThrow(
          "Provider stream event exceeded its byte limit.",
        );
      },
    );
  });
});

function createAdapter(
  baseUrl: string,
  options: Readonly<{ timeoutMs?: number; maxBodyBytes?: number }> = {},
): OpenAiCompatibleAdapter {
  return new OpenAiCompatibleAdapter({
    providerId: "compatible",
    displayName: "Compatible provider",
    baseUrl,
    apiKeyReference: "provider-key",
    capabilities: { known: capabilities },
    reasoning: { high: { field: "reasoning_effort", value: "high" } },
    ...options,
  });
}

function context(signal = new AbortController().signal): ProviderContext {
  return {
    credentials: { resolve: async () => SYNTHETIC_SECRET },
    signal,
  };
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

function run(
  adapter: OpenAiCompatibleAdapter,
  resolved = defaultResolved(adapter),
): Parameters<OpenAiCompatibleAdapter["stream"]>[0] {
  return {
    run: RunRequestSchema.parse({
      schemaVersion: 1,
      runId: "run-provider",
      selection: { providerId: adapter.descriptor.providerId, modelId: "known" },
      messages: [{ role: "user", content: "Hello" }],
    }),
    resolved,
  };
}

function defaultResolved(adapter: OpenAiCompatibleAdapter): ResolvedProviderSelection {
  return {
    selection: ModelSelectionSchema.parse({
      providerId: adapter.descriptor.providerId,
      modelId: "known",
      canonicalId: canonicalModelId(adapter.descriptor.providerId, "known"),
      capabilities,
      reasoning: { requestedIntent: "auto", usedNativeOverride: false, diagnostics: [] },
    }),
    nativeOptions: {},
  };
}

function resolvedWithReasoning(
  adapter: OpenAiCompatibleAdapter,
  reasoning: Awaited<ReturnType<OpenAiCompatibleAdapter["resolveReasoning"]>>,
): ResolvedProviderSelection {
  const base = defaultResolved(adapter);
  return {
    selection: ModelSelectionSchema.parse({ ...base.selection, reasoning: reasoning.reasoning }),
    nativeOptions: reasoning.nativeOptions,
  };
}

async function expectResponseClosed(responseClosed: Promise<void> | undefined): Promise<void> {
  if (responseClosed === undefined) throw new Error("Test server did not receive a response.");
  await responseClosed;
}

async function collect<T>(values: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const value of values) result.push(value);
  return result;
}
