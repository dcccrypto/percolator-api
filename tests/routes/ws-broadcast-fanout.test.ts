/**
 * Regression for BUG-002: the price/trade/funding broadcast loops in ws.ts
 * must not abort mid-fan-out when one client's ws.send() throws. Before the
 * fix, each loop called client.ws.send() directly with only one outer
 * try/catch around the entire listener — a throw from an earlier client's
 * send aborted delivery to every later client in that broadcast cycle. The
 * fix routes all three loops through the same per-client guarded sender
 * (sendSerialized) that safeSend() already used for the message-handler
 * reply path.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import http from "node:http";
import { EventEmitter } from "node:events";
import type { WebSocket as WS } from "ws";

const sharedEventBus = new EventEmitter();

vi.mock("@percolator/shared", () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
  eventBus: sharedEventBus,
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
  WebSocketCtor: typeof WS;
}

async function startServer(): Promise<TestServer> {
  Object.assign(process.env, { NODE_ENV: "test", WS_AUTH_REQUIRED: "false" });
  vi.resetModules();
  const { setupWebSocket } = await import("../../src/routes/ws.js");
  // Import "ws" only AFTER ws.ts has resolved it, so both the test's client
  // sockets and the server's internal sockets share the same module
  // instance — required for prototype.send spying below to reach both.
  const { WebSocket: WebSocketCtor } = await import("ws");
  const server = http.createServer((_req, res) => {
    res.writeHead(200);
    res.end("ok");
  });
  setupWebSocket(server as unknown as import("node:http").Server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return { server, port, WebSocketCtor };
}

function stopServer(ts: TestServer): Promise<void> {
  return new Promise((resolve, reject) =>
    ts.server.close((err) => (err ? reject(err) : resolve())),
  );
}

function waitForOpen(ws: WS): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ws.readyState === ws.OPEN) return resolve();
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
}

function waitForClose(ws: WS): Promise<void> {
  return new Promise((resolve) => {
    if (ws.readyState === ws.CLOSED) return resolve();
    ws.once("close", () => resolve());
  });
}

function waitForSubscribed(ws: WS): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout waiting for subscribed ack")), 1500);
    const onMsg = (raw: unknown) => {
      const parsed = JSON.parse(String(raw));
      if (parsed.type === "subscribed") {
        clearTimeout(timer);
        ws.off("message", onMsg);
        resolve(parsed);
      }
    };
    ws.on("message", onMsg);
  });
}

describe("WS broadcast fan-out — safeSend hardening (BUG-002)", () => {
  let ts: TestServer;
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
    sharedEventBus.removeAllListeners();
  });

  it("delivers a price broadcast to a later client even when an earlier client's send throws", async () => {
    ts = await startServer();
    const { WebSocketCtor } = ts;

    const clientA = new WebSocketCtor(`ws://127.0.0.1:${ts.port}/`);
    const clientB = new WebSocketCtor(`ws://127.0.0.1:${ts.port}/`);
    await Promise.all([waitForOpen(clientA), waitForOpen(clientB)]);

    clientA.send(JSON.stringify({ type: "subscribe", channels: ["price:SLAB-FANOUT"] }));
    clientB.send(JSON.stringify({ type: "subscribe", channels: ["price:SLAB-FANOUT"] }));
    await Promise.all([waitForSubscribed(clientA), waitForSubscribed(clientB)]);

    // From this point on, force the FIRST ws.send() call to throw
    // synchronously — simulating a client whose send fails for any reason
    // (TOCTOU readyState race, internal ws library error, etc.) — then
    // restore normal behaviour for every subsequent call. Client sockets
    // were created from the same module instance as the server's internal
    // sockets (see startServer), so this reaches both.
    const originalSend = WebSocketCtor.prototype.send;
    let sendCalls = 0;
    const sendSpy = vi
      .spyOn(WebSocketCtor.prototype, "send")
      .mockImplementation(function (this: WS, ...args: unknown[]) {
        sendCalls++;
        if (sendCalls === 1) {
          throw new Error("simulated send failure on first client");
        }
        return (originalSend as (...a: unknown[]) => void).apply(this, args);
      });

    const clientBMessage = new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("clientB never received the broadcast")), 2000);
      clientB.once("message", (raw) => {
        clearTimeout(timer);
        resolve(JSON.parse(String(raw)));
      });
    });

    sharedEventBus.emit("price.updated", {
      slabAddress: "SLAB-FANOUT",
      data: { priceE6: 1_500_000 },
      timestamp: Date.now(),
    });

    const received = await clientBMessage;
    expect(received.type).toBe("price");
    expect(received.slab).toBe("SLAB-FANOUT");
    // The spy must actually have been exercised at least twice: once for the
    // simulated failure, once for the successful delivery to clientB.
    expect(sendCalls).toBeGreaterThanOrEqual(2);
    expect(uncaughtErrors).toEqual([]);

    sendSpy.mockRestore();
    clientA.terminate();
    clientB.terminate();
    await Promise.all([waitForClose(clientA), waitForClose(clientB)]);
  });
});
