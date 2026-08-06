import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { canonicalModelId, ModelSelectionSchema, RunRequestSchema } from "@researk/contracts";
import type { ProviderContext, ResolvedProviderSelection } from "@researk/harness";
import { describe, expect, it } from "vitest";
import { OpenRouterAdapter } from "../src/index.js";

const SYNTHETIC_SECRET = "synthetic-openrouter-test-secret";

describe("OpenRouterAdapter", () => {
  it("normalizes OpenRouter catalog metadata over a real loopback connection", async () => {
    let authorization = "";
    await withLoopbackServer(
      (request, response) => {
        authorization = request.headers.authorization ?? "";
        sendJson(response, {
          data: [
            {
              id: "acme/reasoner",
              canonical_slug: "acme/reasoner-2026-08-01",
              name: "Acme Reasoner",
              context_length: 200000,
              architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
              top_provider: { max_completion_tokens: 8192 },
              supported_parameters: ["tools", "structured_outputs", "reasoning"],
              reasoning: { supported_efforts: ["low", "high", "xhigh"] },
              default_parameters: { reasoning: { effort: "high" } },
            },
          ],
        });
      },
      async ({ baseUrl }) => {
        const catalog = await adapter(baseUrl).discoverModels(context());
        expect(catalog.models).toHaveLength(1);
        expect(catalog.models[0]).toMatchObject({
          canonicalId: "openrouter:acme/reasoner",
          displayName: "Acme Reasoner",
          revision: "acme/reasoner-2026-08-01",
          capabilities: {
            streaming: true,
            toolCalls: true,
            structuredOutput: true,
            vision: true,
            contextWindowTokens: 200000,
            maxOutputTokens: 8192,
            reasoning: {
              supported: true,
              intents: ["low", "high", "xhigh"],
              defaultIntent: "high",
            },
          },
        });
      },
    );
    expect(authorization).toBe(`Bearer ${SYNTHETIC_SECRET}`);
  });

  it("maps only catalog-advertised reasoning effort to OpenRouter's native request shape", async () => {
    let requestBody: Record<string, unknown> | undefined;
    await withLoopbackServer(
      async (request, response) => {
        requestBody = JSON.parse(await readBody(request)) as Record<string, unknown>;
        sendJson(response, {
          model: "acme/reasoner",
          choices: [{ message: { content: "done" }, finish_reason: "stop" }],
        });
      },
      async ({ baseUrl }) => {
        const provider = adapter(baseUrl);
        const model = await discoveredModel();
        const reasoning = await provider.resolveReasoning(model, { intent: "high" });
        expect(reasoning.nativeOptions).toEqual({ "reasoning.effort": "high" });
        await expect(provider.resolveReasoning(model, { intent: "medium" })).rejects.toMatchObject({
          normalized: { code: "capability_missing" },
        });
        await collect(provider.stream(run(provider, model, reasoning), context()));
      },
    );
    expect(requestBody).toMatchObject({
      model: "acme/reasoner",
      stream: true,
      reasoning: { effort: "high" },
    });
    expect(Object.hasOwn(requestBody ?? {}, "reasoning.effort")).toBe(false);
  });

  it("rejects duplicate catalog ids and response-model substitution over the network", async () => {
    await withLoopbackServer(
      (_request, response) =>
        sendJson(response, { data: [{ id: "same/model" }, { id: "same/model" }] }),
      async ({ baseUrl }) => {
        await expect(adapter(baseUrl).discoverModels(context())).rejects.toMatchObject({
          normalized: { code: "provider_protocol_error" },
        });
      },
    );
    await withLoopbackServer(
      (_request, response) =>
        sendJson(response, {
          model: "other/model",
          choices: [{ message: { content: "no" }, finish_reason: "stop" }],
        }),
      async ({ baseUrl }) => {
        const provider = adapter(baseUrl);
        const model = await discoveredModel();
        await expect(
          collect(provider.stream(run(provider, model), context())),
        ).rejects.toMatchObject({
          normalized: { code: "model_substitution" },
        });
      },
    );
  });

  it("redacts synthetic credentials and rejects unsafe endpoint configuration", async () => {
    await withLoopbackServer(
      (_request, response) => {
        response.writeHead(401, { "content-type": "text/plain" });
        response.end(`api_key=${SYNTHETIC_SECRET}`);
      },
      async ({ baseUrl }) => {
        await expect(adapter(baseUrl).discoverModels(context())).rejects.toMatchObject({
          normalized: {
            code: "provider_http_error",
            message: expect.not.stringContaining(SYNTHETIC_SECRET),
          },
        });
      },
    );
    for (const baseUrl of [
      "https://user:password@provider.invalid/v1/",
      "https://provider.invalid/v1/?api_key=bad",
      "https://provider.invalid/v1/#fragment",
      "http://provider.invalid/v1/",
    ])
      expect(() => adapter(baseUrl)).toThrow(TypeError);
    for (const timeoutMs of [0, -1, 1.5, Number.NaN, 3_600_001]) {
      expect(() => new OpenRouterAdapter({ timeoutMs })).toThrow(TypeError);
    }
  });
});

function adapter(baseUrl: string): OpenRouterAdapter {
  return new OpenRouterAdapter({ baseUrl, apiKeyReference: "OPENROUTER_TEST_KEY" });
}

function context(signal = new AbortController().signal): ProviderContext {
  return { credentials: { resolve: async () => SYNTHETIC_SECRET }, signal };
}

async function discoveredModel() {
  // This is an in-memory descriptor sourced from the same real endpoint schema;
  // the stream endpoint is separately exercised below.
  const catalog = await withLoopbackServer(
    (_request, response) =>
      sendJson(response, {
        data: [
          {
            id: "acme/reasoner",
            supported_parameters: ["reasoning"],
            reasoning: { supported_efforts: ["high"] },
          },
        ],
      }),
    ({ baseUrl }) => adapter(baseUrl).discoverModels(context()),
  );
  // The passed provider has a different loopback base URL. Only its descriptor is used to build a run.
  // A model descriptor is provider-identity data, not transport state.
  const model = catalog.models[0];
  if (model === undefined) throw new Error("Loopback catalog did not return its model.");
  return model;
}

function run(
  provider: OpenRouterAdapter,
  model: Awaited<ReturnType<typeof discoveredModel>>,
  reasoning?: Awaited<ReturnType<OpenRouterAdapter["resolveReasoning"]>>,
): Parameters<OpenRouterAdapter["stream"]>[0] {
  const resolved: ResolvedProviderSelection = {
    selection: ModelSelectionSchema.parse({
      providerId: provider.descriptor.providerId,
      modelId: model.modelId,
      canonicalId: canonicalModelId(provider.descriptor.providerId, model.modelId),
      revision: model.revision,
      capabilities: model.capabilities,
      reasoning: reasoning?.reasoning ?? {
        requestedIntent: "auto",
        usedNativeOverride: false,
        diagnostics: [],
      },
    }),
    nativeOptions: reasoning?.nativeOptions ?? {},
  };
  return {
    run: RunRequestSchema.parse({
      schemaVersion: 1,
      runId: "run-openrouter",
      selection: { providerId: "openrouter", modelId: model.modelId },
      messages: [{ role: "user", content: "Hello" }],
    }),
    resolved,
  };
}

async function withLoopbackServer<T>(
  handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>,
  execute: (server: { baseUrl: string }) => Promise<T>,
): Promise<T> {
  const server = createServer((request, response) => {
    void Promise.resolve(handler(request, response)).catch(() => response.writeHead(500).end());
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  try {
    return await execute({ baseUrl: `http://127.0.0.1:${port}/api/v1/` });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error))),
    );
  }
}

async function readBody(request: IncomingMessage): Promise<string> {
  let body = "";
  for await (const part of request) body += String(part);
  return body;
}

function sendJson(response: ServerResponse, body: unknown): void {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of stream) values.push(value);
  return values;
}
