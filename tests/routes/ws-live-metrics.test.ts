/**
 * WS live connection metrics (BUG-110).
 *
 * metrics.totalConnections is only incremented once a connection clears the
 * async IP-blocklist/auth-ban/rate-limit chain in the "connection" handler —
 * a socket that's open at the `ws` library level but still mid-handshake is
 * invisible to it. getWebSocketMetrics().liveConnections should instead
 * reflect wss.clients.size, the library's own real-time count, so health
 * checks built on it don't under-report true connection-slot pressure.
 *
 * This test stalls a connection inside the isAuthBanned() await (by mocking
 * the shared store to never resolve it) to deterministically reproduce the
 * gap between the two counters.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import http from "node:http";
import WebSocket from "ws";

let resolveAuthBanned: (() => void) | null = null;

vi.mock("../../src/middleware/shared-store.js", () => ({
  getSharedStore: () => ({
    isAuthBanned: () =>
      new Promise<boolean>((resolve) => {
        resolveAuthBanned = () => resolve(false);
      }),
    recordAuthFailure: vi.fn().mockResolvedValue({ count: 0, bannedUntil: 0 }),
    getConnectionCount: vi.fn().mockResolvedValue(0),
    incrementConnectionCount: vi.fn().mockResolvedValue(undefined),
    decrementConnectionCount: vi.fn().mockResolvedValue(undefined),
    evictExpiredAuthFailures: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock("@percolator/shared", () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
  eventBus: { on: vi.fn(), off: vi.fn() },
  getSupabase: vi.fn(),
  sanitizeSlabAddress: vi.fn((s: string) => s),
  sendInfoAlert: vi.fn(),
}));

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
}

function waitForClose(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) return resolve();
    ws.once("close", () => resolve());
  });
}

describe("WS live connection metrics (BUG-110)", () => {
  let server: http.Server;

  beforeEach(() => {
    vi.resetModules();
    resolveAuthBanned = null;
    process.env.NODE_ENV = "test";
    process.env.WS_AUTH_REQUIRED = "false";
  });

  afterEach(async () => {
    delete process.env.WS_AUTH_REQUIRED;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("reports liveConnections from the real wss instance while a connection is mid-handshake", async () => {
    const { setupWebSocket, getWebSocketMetrics } = await import(
      "../../src/routes/ws.js"
    );

    server = http.createServer();
    setupWebSocket(server as unknown as import("node:http").Server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };

    const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
    try {
      await waitForOpen(ws);

      // The socket is open at the ws-library level, but the server-side
      // handler is stuck awaiting isAuthBanned() — it never reached
      // clients.add().
      const metrics = getWebSocketMetrics();
      expect(metrics.totalConnections).toBe(0);
      expect(metrics.liveConnections).toBe(1);
    } finally {
      // Unblock the stalled handler (even on assertion failure) so the
      // connection can close and server.close() in afterEach doesn't hang.
      resolveAuthBanned?.();
      await new Promise((r) => setTimeout(r, 20));
      ws.close();
      await waitForClose(ws);
    }
  });

  it("falls back to totalConnections when no connection is mid-handshake", async () => {
    const { setupWebSocket, getWebSocketMetrics } = await import(
      "../../src/routes/ws.js"
    );

    server = http.createServer();
    setupWebSocket(server as unknown as import("node:http").Server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    const metrics = getWebSocketMetrics();
    expect(metrics.totalConnections).toBe(0);
    expect(metrics.liveConnections).toBe(0);
  });
});
