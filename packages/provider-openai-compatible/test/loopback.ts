import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface LoopbackServer {
  readonly baseUrl: string;
}

export async function withLoopbackServer<T>(
  handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>,
  execute: (server: LoopbackServer) => Promise<T>,
): Promise<T> {
  const server = createServer((request, response) => {
    void Promise.resolve(handler(request, response)).catch(() => {
      if (!response.headersSent) response.writeHead(500, { "content-type": "text/plain" });
      response.end("test handler failed");
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("Loopback server did not expose a TCP address.");
  }
  const { port } = address as AddressInfo;

  try {
    return await execute({ baseUrl: `http://127.0.0.1:${port}/v1/` });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)));
    });
  }
}

export async function readRequestBody(request: IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of request) body += String(chunk);
  return body;
}

export function sendJson(response: ServerResponse, value: unknown, status = 200): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

export function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
