/**
 * Regression: every ws.send() inside the WS message handler must be wrapped
 * by safeSend(), so a synchronous "WebSocket is not open" throw cannot escape
 * the async handler when the client disconnects mid-iteration.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import http from "node:http";
import WebSocket from "ws";

vi.mock("@percolator/shared", () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
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

function waitForClose(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) return resolve();
    ws.once("close", () => resolve());
  });
}

describe("WS message handler — safeSend hardening", () => {
  let ts: TestServer;
  // Capture any uncaught exceptions during the test so we can fail loudly if
  // an unguarded ws.send() throw escapes the handler.
  let uncaughtErrors: unknown[] = [];
  const onUncaught = (err: unknown) => uncaughtErrors.push(err);

  beforeEach(() => {
    uncaughtErrors = [];
    process.on("uncaughtException", onUncaught);
    process.on("unhandledRejection", onUncaught);
  });

  afterEach(async () => {
    process.off("uncaughtException", onUncaught);
    process.off("unhandledRejection", onUncaught);
    if (ts) await stopServer(ts);
    delete process.env.WS_AUTH_REQUIRED;
  });

  it("does not crash the handler when the client closes immediately after sending an oversized message", async () => {
    ts = await startServer();
    const ws = new WebSocket(`ws://127.0.0.1:${ts.port}/`);
    await waitForOpen(ws);

    // Build a payload larger than MAX_PAYLOAD (currently 1024) to trip the
    // "Message too large" path that previously did an unguarded ws.send().
    // Use the raw WS frame so the send isn't pre-validated by ws library.
    const huge = "x".repeat(2048);
    ws.send(huge);
    // Close the socket immediately so by the time the server's "Message too
    // large" send fires, the readyState may not be OPEN any more.
    ws.terminate();
    await waitForClose(ws);

    // Give the handler a moment to settle.
    await new Promise((r) => setTimeout(r, 50));

    expect(uncaughtErrors).toEqual([]);
  });

  it("does not crash the handler when the client disconnects immediately after subscribe", async () => {
    ts = await startServer();
    const ws = new WebSocket(`ws://127.0.0.1:${ts.port}/`);
    await waitForOpen(ws);

    ws.send(JSON.stringify({ type: "subscribe", channels: ["price:SLAB1"] }));
    // Don't wait for the "subscribed" reply — terminate so by the time the
    // server tries to write to us we are closed.
    ws.terminate();
    await waitForClose(ws);

    await new Promise((r) => setTimeout(r, 100));
    expect(uncaughtErrors).toEqual([]);
  });

  it("delivers normal subscribe responses to a connected client", async () => {
    ts = await startServer();
    const ws = new WebSocket(`ws://127.0.0.1:${ts.port}/`);
    await waitForOpen(ws);

    const msgPromise = new Promise<any>((resolve, reject) => {
      ws.on("message", (raw) => {
        try {
          const parsed = JSON.parse(String(raw));
          if (parsed.type === "subscribed") resolve(parsed);
        } catch (err) {
          reject(err);
        }
      });
      setTimeout(() => reject(new Error("timeout")), 1500);
    });

    ws.send(JSON.stringify({ type: "subscribe", channels: ["price:SLAB1"] }));
    const msg = await msgPromise;
    expect(msg.type).toBe("subscribed");
    expect(msg.channels).toContain("price:SLAB1");

    ws.close();
    await waitForClose(ws);
    expect(uncaughtErrors).toEqual([]);
  });
});
