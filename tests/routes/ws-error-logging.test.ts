/**
 * Regression: the WS message-handler catch block must log a string error
 * message, not the raw Error object, matching every other catch in this
 * file (BUG-113).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import http from "node:http";
import WebSocket from "ws";

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@percolator/shared", () => ({
  createLogger: vi.fn(() => mockLogger),
  eventBus: { on: vi.fn() },
  getSupabase: vi.fn(() => ({
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          abortSignal: vi.fn(() => ({
            single: vi.fn(() => Promise.resolve({ data: null, error: null })),
          })),
          single: vi.fn(() => Promise.resolve({ data: null, error: null })),
        })),
      })),
    })),
  })),
  sanitizeSlabAddress: vi.fn((s: string) => s),
  sendInfoAlert: vi.fn(),
}));

interface TestServer {
  server: http.Server;
  port: number;
}

async function startServer(): Promise<TestServer> {
  Object.assign(process.env, { NODE_ENV: "test", WS_AUTH_REQUIRED: "false" });
  vi.resetModules();
  const { setupWebSocket } = await import("../../src/routes/ws.js");
  const server = http.createServer((_req, res) => {
    res.writeHead(200);
    res.end("ok");
  });
  setupWebSocket(server as unknown as import("node:http").Server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return { server, port };
}

function stopServer(ts: TestServer): Promise<void> {
  return new Promise((resolve, reject) =>
    ts.server.close((err) => (err ? reject(err) : resolve())),
  );
}

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.OPEN) return resolve();
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
}

describe("WS message handler — error logging (BUG-113)", () => {
  let ts: TestServer;

  beforeEach(() => {
    mockLogger.warn.mockClear();
  });

  afterEach(async () => {
    if (ts) await stopServer(ts);
    delete process.env.WS_AUTH_REQUIRED;
  });

  it("logs a string error message (not the raw Error object) for a malformed message", async () => {
    ts = await startServer();
    const ws = new WebSocket(`ws://127.0.0.1:${ts.port}/`);
    await waitForOpen(ws);

    try {
      ws.send("not valid json {{{");
      await new Promise((r) => setTimeout(r, 50));

      const call = mockLogger.warn.mock.calls.find((c) => c[0] === "Error processing WS message");
      expect(call).toBeDefined();
      expect(typeof call![1].error).toBe("string");
    } finally {
      ws.close();
    }
  });
});
