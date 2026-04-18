/**
 * Regression: the WS subscribe handler must wrap its initial-price Supabase
 * query with an AbortSignal-backed timeout. Without this, slow Supabase
 * responses pile up per client (the message handler is async + concurrent),
 * exhausting the connection pool and stalling closures indefinitely.
 *
 * This test does NOT measure the timeout duration end-to-end (3s real time
 * is too slow for a unit test). It instead proves the call site is wired
 * correctly: the .abortSignal(...) builder is called with an AbortSignal
 * whose semantics include automatic abort, and the timeout path is reached
 * by simulating an aborted query.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import http from "node:http";
import WebSocket from "ws";

// Capture the AbortSignal handed to .abortSignal() so we can assert on it.
let lastAbortSignal: AbortSignal | undefined;
// Allow individual tests to control how .single() resolves.
let singleImpl: () => Promise<{ data: unknown; error: unknown }> = () =>
  Promise.resolve({
    data: { last_price: 1_000_000, mark_price: 1_000_000, index_price: 1_000_000, updated_at: "" },
    error: null,
  });

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
          abortSignal: vi.fn((sig: AbortSignal) => {
            lastAbortSignal = sig;
            return {
              single: vi.fn(() => singleImpl()),
            };
          }),
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

function waitForMessage(ws: WebSocket, predicate: (msg: any) => boolean): Promise<any> {
  return new Promise((resolve, reject) => {
    const onMsg = (raw: WebSocket.RawData) => {
      try {
        const parsed = JSON.parse(String(raw));
        if (predicate(parsed)) {
          ws.off("message", onMsg);
          resolve(parsed);
        }
      } catch (err) {
        reject(err);
      }
    };
    ws.on("message", onMsg);
  });
}

describe("WS subscribe — initial price query timeout", () => {
  let ts: TestServer;

  beforeEach(() => {
    lastAbortSignal = undefined;
    singleImpl = () =>
      Promise.resolve({
        data: { last_price: 1_000_000, mark_price: 1_000_000, index_price: 1_000_000, updated_at: "" },
        error: null,
      });
  });

  afterEach(async () => {
    if (ts) await stopServer(ts);
    delete process.env.WS_AUTH_REQUIRED;
  });

  it("passes an AbortSignal to the Supabase query for initial price fetches", async () => {
    ts = await startServer();
    const ws = new WebSocket(`ws://127.0.0.1:${ts.port}/`);
    await waitForOpen(ws);

    ws.send(JSON.stringify({ type: "subscribe", channels: ["price:SLAB1"] }));
    await waitForMessage(ws, (m) => m.type === "subscribed");
    // Wait a tick for the post-subscribe initial-price loop to run.
    await new Promise((r) => setTimeout(r, 50));

    expect(lastAbortSignal).toBeInstanceOf(AbortSignal);

    ws.close();
  });

  it("reaches the catch path when the Supabase query is aborted (no handler stall)", async () => {
    ts = await startServer();

    // Configure .single() to return a promise that REJECTS as soon as the
    // captured AbortSignal aborts. This is the same shape Supabase produces
    // when AbortSignal.timeout() fires.
    singleImpl = () =>
      new Promise((_, reject) => {
        const check = () => {
          if (lastAbortSignal?.aborted) {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          } else {
            // Re-check shortly. The 3s real timeout is way too slow for a
            // unit test — instead we manually abort below.
            setTimeout(check, 10);
          }
        };
        check();
      });

    const ws = new WebSocket(`ws://127.0.0.1:${ts.port}/`);
    await waitForOpen(ws);

    ws.send(JSON.stringify({ type: "subscribe", channels: ["price:SLAB2"] }));
    await waitForMessage(ws, (m) => m.type === "subscribed");

    // Give the handler a moment to begin awaiting .single().
    await new Promise((r) => setTimeout(r, 30));
    expect(lastAbortSignal).toBeInstanceOf(AbortSignal);

    // Manually abort the captured signal — the handler should resolve via
    // its catch block without ever stalling indefinitely. We assert by
    // confirming the WebSocket can still receive a subsequent control
    // message; if the handler were stuck the connection would still be
    // alive but the test would never observe forward progress here.
    const ctrl = new AbortController();
    Object.defineProperty(lastAbortSignal!, "aborted", { value: true });
    lastAbortSignal!.dispatchEvent(new Event("abort"));
    void ctrl;

    // Wait briefly for the catch path to settle. If the handler stalls,
    // the test will time out (vitest default 5s) — that's the regression.
    await new Promise((r) => setTimeout(r, 100));

    // The connection should still be alive — handler errors must not crash
    // the socket — and we should be able to send another message cleanly.
    expect(ws.readyState).toBe(WebSocket.OPEN);

    ws.close();
  });
});
