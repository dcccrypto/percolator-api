/**
 * Regression for BUG-005: MAX_WS_CONNECTIONS and MAX_GLOBAL_SUBSCRIPTIONS
 * must be enforced via the SharedStore so they hold fleet-wide across
 * replicas, not just against this process's own (possibly empty) local
 * `clients` Set / subscription counter.
 *
 * These tests simulate "other replicas already at the cap" by bumping the
 * shared store directly, then prove THIS replica — whose own local state is
 * empty — still rejects new connections/subscriptions, which would not have
 * been true before this fix.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
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
          single: vi.fn(() => Promise.resolve({ data: null, error: null })),
        })),
      })),
    })),
  })),
  sanitizeSlabAddress: vi.fn((s: string) => s),
  sendInfoAlert: vi.fn(),
}));

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.OPEN) return resolve();
    ws.once("open", resolve);
    ws.once("error", reject);
  });
}

function waitForClose(ws: WebSocket): Promise<number> {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
      return resolve(ws.readyState);
    }
    ws.once("close", (code) => resolve(code));
  });
}

function waitForMessage(ws: WebSocket, predicate: (msg: any) => boolean, timeoutMs = 1500): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout waiting for message")), timeoutMs);
    const onMsg = (raw: unknown) => {
      const parsed = JSON.parse(String(raw));
      if (predicate(parsed)) {
        clearTimeout(timer);
        ws.off("message", onMsg);
        resolve(parsed);
      }
    };
    ws.on("message", onMsg);
  });
}

interface TestServer {
  server: http.Server;
  port: number;
  sharedStoreModule: typeof import("../../src/middleware/shared-store.js");
}

async function startServer(env: Record<string, string>): Promise<TestServer> {
  Object.assign(process.env, env);
  vi.resetModules();
  const { setupWebSocket } = await import("../../src/routes/ws.js");
  // Import shared-store AFTER ws.js has resolved it, so this test gets the
  // same module instance (and same _store singleton) ws.ts uses internally —
  // required to seed/inspect the global counters it reads from.
  const sharedStoreModule = await import("../../src/middleware/shared-store.js");
  const server = http.createServer((_req, res) => {
    res.writeHead(200);
    res.end("ok");
  });
  setupWebSocket(server as unknown as import("node:http").Server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return { server, port, sharedStoreModule };
}

async function stopServer(ts: TestServer): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    ts.server.close((err) => (err ? reject(err) : resolve())),
  );
}

describe("WS global connection cap is shared across replicas (BUG-005)", () => {
  let ts: TestServer;

  afterEach(async () => {
    if (ts) await stopServer(ts);
    delete process.env.MAX_WS_CONNECTIONS;
    delete process.env.WS_AUTH_REQUIRED;
  });

  it("rejects a new connection once the global count is at the cap, even though this replica's own local client set is empty", async () => {
    ts = await startServer({
      NODE_ENV: "test",
      WS_AUTH_REQUIRED: "false",
      MAX_WS_CONNECTIONS: "2",
    });

    // Simulate 2 connections already established on OTHER replicas by
    // bumping the shared store directly — this replica's own `clients` Set
    // is still empty, so the pre-fix (local-only) check would have allowed
    // a new connection here.
    const store = ts.sharedStoreModule.getSharedStore();
    await store.incrementConnectionCount("ws:global-connections");
    await store.incrementConnectionCount("ws:global-connections");

    const ws = new WebSocket(`ws://127.0.0.1:${ts.port}/`);
    const code = await waitForClose(ws);
    expect(code).toBe(1008);
  });

  it("allows a connection when under the global cap", async () => {
    ts = await startServer({
      NODE_ENV: "test",
      WS_AUTH_REQUIRED: "false",
      MAX_WS_CONNECTIONS: "2",
    });

    const ws = new WebSocket(`ws://127.0.0.1:${ts.port}/`);
    await waitForOpen(ws);
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
    await waitForClose(ws);
  });
});

describe("WS global subscription cap is shared across replicas (BUG-005)", () => {
  let ts: TestServer;

  afterEach(async () => {
    if (ts) await stopServer(ts);
    delete process.env.WS_AUTH_REQUIRED;
  });

  it("rejects a new subscription once the global subscription count is at the cap (MAX_GLOBAL_SUBSCRIPTIONS = 1000, not env-overridable)", async () => {
    ts = await startServer({
      NODE_ENV: "test",
      WS_AUTH_REQUIRED: "false",
    });

    // Simulate 1000 subscriptions already held across OTHER replicas.
    const store = ts.sharedStoreModule.getSharedStore();
    await store.addConnectionCount("ws:global-subscriptions", 1000);

    const ws = new WebSocket(`ws://127.0.0.1:${ts.port}/`);
    await waitForOpen(ws);

    ws.send(JSON.stringify({ type: "subscribe", channels: ["price:SLAB-GLOBAL-CAP"] }));
    const errorMsg = await waitForMessage(ws, (m) => m.type === "error");
    expect(errorMsg.message).toMatch(/server subscription limit reached/i);

    ws.close();
    await waitForClose(ws);
  });

  it("allows a subscription when under the global cap", async () => {
    ts = await startServer({
      NODE_ENV: "test",
      WS_AUTH_REQUIRED: "false",
    });

    const ws = new WebSocket(`ws://127.0.0.1:${ts.port}/`);
    await waitForOpen(ws);

    ws.send(JSON.stringify({ type: "subscribe", channels: ["price:SLAB-UNDER-CAP"] }));
    const subscribedMsg = await waitForMessage(ws, (m) => m.type === "subscribed");
    expect(subscribedMsg.channels).toContain("price:SLAB-UNDER-CAP");

    ws.close();
    await waitForClose(ws);
  });
});

describe("getWebSocketMetrics reports the global (shared-store) count, not just this replica's local count (BUG-005)", () => {
  let ts: TestServer;

  afterEach(async () => {
    if (ts) await stopServer(ts);
    delete process.env.WS_AUTH_REQUIRED;
  });

  it("totalConnections reflects connections established on other replicas, not seen locally", async () => {
    ts = await startServer({
      NODE_ENV: "test",
      WS_AUTH_REQUIRED: "false",
    });

    const { getWebSocketMetrics } = await import("../../src/routes/ws.js");
    const store = ts.sharedStoreModule.getSharedStore();

    // Simulate 7 connections established on other replicas — this replica's
    // own `clients` Set is still empty.
    for (let i = 0; i < 7; i++) {
      await store.incrementConnectionCount("ws:global-connections");
    }

    const metrics = await getWebSocketMetrics();
    expect(metrics.totalConnections).toBe(7);
  });
});
