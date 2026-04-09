import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { eventBus } from "@percolator/shared";
import { setupWebSocket, cleanupEventBusListeners } from "../../src/routes/ws.js";

// Track baseline listener counts so the assertions are independent of any
// listeners that might be registered by other parts of the system.
let baseline: Record<string, number>;

const TRACKED_EVENTS = ["price.updated", "trade.executed", "funding.updated"] as const;

function snapshot(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of TRACKED_EVENTS) {
    out[e] = eventBus.listenerCount(e);
  }
  return out;
}

describe("ws.ts eventBus listener lifecycle", () => {
  let server: Server;

  beforeEach(() => {
    cleanupEventBusListeners();
    baseline = snapshot();
    server = createServer();
  });

  afterEach(() => {
    cleanupEventBusListeners();
    server.close();
  });

  it("registers exactly one listener per tracked event after setupWebSocket", () => {
    setupWebSocket(server);
    const after = snapshot();
    for (const e of TRACKED_EVENTS) {
      expect(after[e]).toBe(baseline[e] + 1);
    }
  });

  it("does not accumulate listeners across repeated setupWebSocket calls", () => {
    setupWebSocket(server);
    setupWebSocket(server);
    setupWebSocket(server);
    const after = snapshot();
    for (const e of TRACKED_EVENTS) {
      // Still only one listener per event regardless of how many times setup ran.
      expect(after[e]).toBe(baseline[e] + 1);
    }
  });

  it("cleanupEventBusListeners removes all registered listeners", () => {
    setupWebSocket(server);
    cleanupEventBusListeners();
    const after = snapshot();
    for (const e of TRACKED_EVENTS) {
      expect(after[e]).toBe(baseline[e]);
    }
  });

  it("cleanupEventBusListeners is safe to call when no listeners are registered", () => {
    cleanupEventBusListeners();
    cleanupEventBusListeners();
    const after = snapshot();
    for (const e of TRACKED_EVENTS) {
      expect(after[e]).toBe(baseline[e]);
    }
  });
});
