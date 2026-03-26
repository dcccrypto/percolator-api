/**
 * WebSocket per-IP connection limits and IP blocklist enforcement.
 *
 * These tests spin up a real HTTP + WebSocket server against the ws.ts module
 * so that the in-process Maps (connectionsPerIp, unauthenticatedConnectionsPerIp)
 * are properly exercised.
 *
 * Env vars used:
 *   NODE_ENV=test         — disables production-only guards
 *   WS_AUTH_REQUIRED=false — lets unauthenticated clients connect freely
 *                            (unless we want to test the unauth limit)
 *   IP_BLOCKLIST          — controls which IPs are hard-blocked
 *   MAX_UNAUTH_WS_CONNECTIONS_PER_IP — overrides the 3-connection default
 */
import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import http from "node:http";
import WebSocket from "ws";

// ---------------------------------------------------------------------------
// Shared mocks — must be hoisted before any dynamic imports of ws.ts
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.OPEN) return resolve();
    ws.once("open", resolve);
    ws.once("error", reject);
  });
}

function waitForClose(ws: WebSocket): Promise<number> {
  return new Promise((resolve) => {
    if (
      ws.readyState === WebSocket.CLOSED ||
      ws.readyState === WebSocket.CLOSING
    ) {
      return resolve(ws.readyState);
    }
    ws.once("close", (code) => resolve(code));
  });
}

/** Connect a WS client with a spoofed X-Forwarded-For header. */
function connect(port: number, ip: string, token?: string): WebSocket {
  const url = token
    ? `ws://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`
    : `ws://127.0.0.1:${port}/`;
  return new WebSocket(url, { headers: { "x-forwarded-for": ip } });
}

/** Close all WebSocket clients and wait for their close events. */
async function closeAll(sockets: WebSocket[]): Promise<void> {
  await Promise.all(
    sockets.map((ws) => {
      ws.close();
      return waitForClose(ws);
    })
  );
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

interface TestServer {
  server: http.Server;
  port: number;
}

async function startServer(env: Record<string, string>): Promise<TestServer> {
  // Apply env overrides
  Object.assign(process.env, env);

  // Force-reload ws.ts + ip-blocklist.ts so module-level constants pick up
  // the new env values.
  vi.resetModules();
  const { setupWebSocket } = await import("../../src/routes/ws.js");

  const server = http.createServer((_req, res) => {
    res.writeHead(200);
    res.end("ok");
  });

  setupWebSocket(server as unknown as import("node:http").Server);

  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", resolve)
  );
  const { port } = server.address() as { port: number };

  return { server, port };
}

async function stopServer(ts: TestServer): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    ts.server.close((err) => (err ? reject(err) : resolve()))
  );
}

// ---------------------------------------------------------------------------
// Test suites
// ---------------------------------------------------------------------------

describe("WS IP blocklist (isClientIpBlocked integrated)", () => {
  let ts: TestServer;

  afterEach(async () => {
    await stopServer(ts);
    delete process.env.IP_BLOCKLIST;
    delete process.env.WS_AUTH_REQUIRED;
    delete process.env.TRUSTED_PROXY_DEPTH;
  });

  it("rejects a connection from a blocklisted IP with close code 1008", async () => {
    ts = await startServer({
      NODE_ENV: "test",
      WS_AUTH_REQUIRED: "false",
      IP_BLOCKLIST: "88.97.223.158",
      TRUSTED_PROXY_DEPTH: "1",
    });

    const ws = connect(ts.port, "88.97.223.158");
    const code = await waitForClose(ws);
    expect(code).toBe(1008);
  });

  it("allows a non-blocklisted IP when blocklist is set", async () => {
    ts = await startServer({
      NODE_ENV: "test",
      WS_AUTH_REQUIRED: "false",
      IP_BLOCKLIST: "88.97.223.158",
      TRUSTED_PROXY_DEPTH: "1",
    });

    const ws = connect(ts.port, "1.2.3.4");
    await waitForOpen(ws);
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
    await waitForClose(ws);
  });
});

describe("WS unauthenticated per-IP connection limit", () => {
  let ts: TestServer;
  const sockets: WebSocket[] = [];

  beforeEach(() => {
    sockets.length = 0;
  });

  afterEach(async () => {
    await closeAll(sockets);
    await stopServer(ts);
    delete process.env.IP_BLOCKLIST;
    delete process.env.WS_AUTH_REQUIRED;
    delete process.env.TRUSTED_PROXY_DEPTH;
    delete process.env.MAX_UNAUTH_WS_CONNECTIONS_PER_IP;
  });

  it("allows up to 3 unauthenticated connections from the same IP", async () => {
    ts = await startServer({
      NODE_ENV: "test",
      WS_AUTH_REQUIRED: "false",
      IP_BLOCKLIST: "",
      TRUSTED_PROXY_DEPTH: "1",
      // Force auth NOT required so connections are considered unauthenticated
      // NOTE: WS_AUTH_REQUIRED=false means `authenticated = true` in the code
      // (auto-authenticated). To test the *unauth* path we need to set
      // WS_AUTH_REQUIRED=true and not provide tokens.
    });

    // This sub-test just verifies that up to 3 unauthenticated connections
    // from the same IP are accepted when WS_AUTH_REQUIRED=true and no token
    // is supplied.  We restart the server with auth required.
    await stopServer(ts);
    ts = await startServer({
      NODE_ENV: "test",
      WS_AUTH_REQUIRED: "true",
      WS_AUTH_SECRET: "test-secret-for-vitest",
      IP_BLOCKLIST: "",
      TRUSTED_PROXY_DEPTH: "1",
      MAX_UNAUTH_WS_CONNECTIONS_PER_IP: "3",
    });

    // 3 unauthenticated connections from the same IP should succeed
    for (let i = 0; i < 3; i++) {
      const ws = connect(ts.port, "10.0.0.1");
      await waitForOpen(ws);
      expect(ws.readyState).toBe(WebSocket.OPEN);
      sockets.push(ws);
    }
  });

  it("rejects the 4th unauthenticated connection from the same IP", async () => {
    ts = await startServer({
      NODE_ENV: "test",
      WS_AUTH_REQUIRED: "true",
      WS_AUTH_SECRET: "test-secret-for-vitest",
      IP_BLOCKLIST: "",
      TRUSTED_PROXY_DEPTH: "1",
      MAX_UNAUTH_WS_CONNECTIONS_PER_IP: "3",
    });

    // Open 3 unauthenticated connections (should succeed)
    for (let i = 0; i < 3; i++) {
      const ws = connect(ts.port, "10.0.0.2");
      await waitForOpen(ws);
      sockets.push(ws);
    }

    // 4th should be rejected
    const ws4 = connect(ts.port, "10.0.0.2");
    const code = await waitForClose(ws4);
    expect(code).toBe(1008);
  });

  it("counts connections per-IP independently (different IPs)", async () => {
    ts = await startServer({
      NODE_ENV: "test",
      WS_AUTH_REQUIRED: "true",
      WS_AUTH_SECRET: "test-secret-for-vitest",
      IP_BLOCKLIST: "",
      TRUSTED_PROXY_DEPTH: "1",
      MAX_UNAUTH_WS_CONNECTIONS_PER_IP: "3",
    });

    // 3 from IP A
    for (let i = 0; i < 3; i++) {
      const ws = connect(ts.port, "10.1.1.1");
      await waitForOpen(ws);
      sockets.push(ws);
    }

    // 3 from IP B — should still succeed (different IP bucket)
    for (let i = 0; i < 3; i++) {
      const ws = connect(ts.port, "10.2.2.2");
      await waitForOpen(ws);
      expect(ws.readyState).toBe(WebSocket.OPEN);
      sockets.push(ws);
    }
  });
});
