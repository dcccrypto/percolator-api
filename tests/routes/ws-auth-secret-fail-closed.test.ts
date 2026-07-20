/**
 * #212: WS auth must fail closed when WS_AUTH_SECRET is unset.
 *
 * `WS_SECRET = WS_AUTH_SECRET || ""` fed the empty string to createHmac().
 * "" is a perfectly usable HMAC key, so an attacker who knows the secret is
 * unset can compute a valid signature themselves and authenticate.
 *
 * Production (NODE_ENV=production) and WS_AUTH_REQUIRED=true both process.exit
 * at module load, so the reachable case is a non-production deploy with
 * WS_AUTH_REQUIRED=false: the `auth` message handler calls verifyWsToken()
 * regardless of whether auth is required, so a forged token still granted
 * slab binding.
 *
 * These tests drive a real HTTP + WebSocket server (same harness style as
 * ws-ip-limits.test.ts) so the actual reachable path is exercised, rather than
 * adding a test-only export to production code.
 *
 * Env vars used:
 *   NODE_ENV=test          — disables the production-only startup guard
 *   WS_AUTH_REQUIRED=false — the reachable misconfiguration
 *   WS_AUTH_SECRET         — set/unset per test
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import http from "node:http";
import WebSocket from "ws";
import { createHmac } from "node:crypto";

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

const SLAB = "So11111111111111111111111111111111111111112";

/** Forge a token exactly as an attacker would, given a known/guessed secret. */
function forgeToken(slab: string, secret: string, timestamp = Date.now()): string {
  const payload = `${slab}:${timestamp}`;
  const sig = createHmac("sha256", secret).update(payload).digest("hex");
  return `${payload}:${sig}`;
}

interface TestServer {
  server: http.Server;
  port: number;
  generateWsToken: (slab: string) => string;
}

async function startServer(secret?: string): Promise<TestServer> {
  process.env.NODE_ENV = "test";
  process.env.WS_AUTH_REQUIRED = "false";
  if (secret === undefined) delete process.env.WS_AUTH_SECRET;
  else process.env.WS_AUTH_SECRET = secret;

  vi.resetModules();
  const { setupWebSocket, generateWsToken } = await import("../../src/routes/ws.js");

  const server = http.createServer((_req, res) => {
    res.writeHead(200);
    res.end("ok");
  });
  setupWebSocket(server as unknown as import("node:http").Server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return { server, port, generateWsToken };
}

async function stopServer(ts: TestServer): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    ts.server.close((err) => (err ? reject(err) : resolve()))
  );
}

/** Send an `auth` message with `token` and resolve the server's reply. */
function authAttempt(port: number, token: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("timed out waiting for auth reply"));
    }, 5_000);

    ws.once("open", () => ws.send(JSON.stringify({ type: "auth", token })));
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      // Ignore unrelated server chatter (e.g. a welcome frame).
      if (msg.type !== "authenticated" && msg.type !== "error") return;
      clearTimeout(timer);
      ws.close();
      resolve(msg);
    });
    ws.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

describe("#212 WS auth fails closed without WS_AUTH_SECRET", () => {
  let ts: TestServer | undefined;

  afterEach(async () => {
    if (ts) await stopServer(ts);
    ts = undefined;
    delete process.env.WS_AUTH_SECRET;
    delete process.env.WS_AUTH_REQUIRED;
    vi.resetModules();
  });

  it("rejects an empty-secret-forged token when the secret is unset", async () => {
    ts = await startServer(undefined);
    // The exact attack: sign with "" because that is what the server used.
    const reply = await authAttempt(ts.port, forgeToken(SLAB, ""));
    expect(reply.type).toBe("error");
    expect(reply.message).toMatch(/Invalid authentication token/);
  });

  it("refuses to mint a token when the secret is unset", async () => {
    ts = await startServer(undefined);
    expect(() => ts!.generateWsToken(SLAB)).toThrow(/WS_AUTH_SECRET is not set/);
  });

  it("accepts a legitimately signed token when a secret IS configured", async () => {
    const secret = "a-real-secret-value";
    ts = await startServer(secret);
    const reply = await authAttempt(ts.port, forgeToken(SLAB, secret));
    expect(reply.type).toBe("authenticated");
    expect(reply.slabBinding).toBe(SLAB);
  });

  it("rejects a token signed with the wrong secret when a secret IS configured", async () => {
    ts = await startServer("a-real-secret-value");
    const reply = await authAttempt(ts.port, forgeToken(SLAB, ""));
    expect(reply.type).toBe("error");
  });

  it("mints a usable token when a secret IS configured", async () => {
    ts = await startServer("a-real-secret-value");
    const token = ts.generateWsToken(SLAB);
    expect(token.split(":")).toHaveLength(3);
    const reply = await authAttempt(ts.port, token);
    expect(reply.type).toBe("authenticated");
  });
});
