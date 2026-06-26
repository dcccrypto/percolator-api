/**
 * Tests for OraclePriceBroadcaster, including BUG-103: the broadcaster must
 * reconnect with backoff after Supabase Realtime reports CHANNEL_ERROR/
 * TIMED_OUT/CLOSED (Realtime does not retry on its own), and must expose its
 * status so /health can detect a dead channel instead of reporting "ok"
 * while no live prices are flowing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { publishSpy } = vi.hoisted(() => ({ publishSpy: vi.fn() }));

vi.mock("@percolator/shared", () => ({
  eventBus: { publish: publishSpy },
  getSupabase: vi.fn(),
  getNetwork: vi.fn(() => "devnet"),
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

import { getSupabase } from "@percolator/shared";
import { OraclePriceBroadcaster, getOraclePriceBroadcaster } from "../../src/services/OraclePriceBroadcaster.js";

type StatusCallback = (status: string, err?: unknown) => void;

describe("OraclePriceBroadcaster", () => {
  let insertHandler: (payload: { new: unknown }) => void;
  let statusCallback: StatusCallback | undefined;
  let subscribeCallCount: number;
  let mockChannel: any;
  let mockSupabase: any;

  beforeEach(() => {
    publishSpy.mockClear();
    subscribeCallCount = 0;
    mockChannel = {
      on: vi.fn((_event: string, _filter: unknown, handler: typeof insertHandler) => {
        insertHandler = handler;
        return mockChannel;
      }),
      subscribe: vi.fn((cb?: StatusCallback) => {
        subscribeCallCount++;
        statusCallback = cb;
        return mockChannel;
      }),
    };
    mockSupabase = {
      channel: vi.fn(() => mockChannel),
      removeChannel: vi.fn(),
    };
    vi.mocked(getSupabase).mockReturnValue(mockSupabase);
  });

  describe("price publishing", () => {
    it("publishes price.updated with the slab and priceE6 from the row", async () => {
      const broadcaster = new OraclePriceBroadcaster();
      await broadcaster.start();

      insertHandler({
        new: {
          slab_address: "SLAB1",
          price_e6: "1500000",
          timestamp: Date.now(),
          tx_signature: "sig123",
          network: "devnet",
        },
      });

      expect(publishSpy).toHaveBeenCalledTimes(1);
      const [event, slab, data] = publishSpy.mock.calls[0];
      expect(event).toBe("price.updated");
      expect(slab).toBe("SLAB1");
      expect(data.priceE6).toBe(1500000);
    });

    it("ignores a row with a non-positive or non-finite price", async () => {
      const broadcaster = new OraclePriceBroadcaster();
      await broadcaster.start();

      insertHandler({ new: { slab_address: "SLAB1", price_e6: "0", timestamp: Date.now(), tx_signature: null, network: "devnet" } });
      insertHandler({ new: { slab_address: "SLAB1", price_e6: "not-a-number", timestamp: Date.now(), tx_signature: null, network: "devnet" } });

      expect(publishSpy).not.toHaveBeenCalled();
    });
  });

  describe("status tracking and reconnect (BUG-103)", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("starts as not_started/unhealthy, becomes healthy once SUBSCRIBED", async () => {
      const broadcaster = new OraclePriceBroadcaster();
      expect(broadcaster.getStatus()).toBe("not_started");
      expect(broadcaster.isHealthy()).toBe(false);

      await broadcaster.start();
      statusCallback!("SUBSCRIBED");

      expect(broadcaster.getStatus()).toBe("SUBSCRIBED");
      expect(broadcaster.isHealthy()).toBe(true);
    });

    it("reconnects after a channel error instead of staying dead until restart", async () => {
      const broadcaster = new OraclePriceBroadcaster();
      await broadcaster.start();
      expect(subscribeCallCount).toBe(1);

      statusCallback!("CHANNEL_ERROR");
      expect(broadcaster.isHealthy()).toBe(false);

      // First backoff attempt: 1000ms. Without the fix, nothing would ever
      // re-subscribe here — the channel would stay dead until process restart.
      await vi.advanceTimersByTimeAsync(999);
      expect(subscribeCallCount).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(subscribeCallCount).toBe(2);

      statusCallback!("SUBSCRIBED");
      expect(broadcaster.isHealthy()).toBe(true);
    });

    it("increases backoff delay on repeated failures and resets it after a successful reconnect", async () => {
      const broadcaster = new OraclePriceBroadcaster();
      await broadcaster.start();

      statusCallback!("CHANNEL_ERROR"); // attempt 1 -> 1000ms
      await vi.advanceTimersByTimeAsync(1000);
      expect(subscribeCallCount).toBe(2);

      statusCallback!("TIMED_OUT"); // attempt 2 -> 2000ms
      await vi.advanceTimersByTimeAsync(1999);
      expect(subscribeCallCount).toBe(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(subscribeCallCount).toBe(3);

      statusCallback!("SUBSCRIBED"); // success resets the backoff counter
      statusCallback!("CLOSED"); // attempt 1 again -> 1000ms, not 4000ms
      await vi.advanceTimersByTimeAsync(1000);
      expect(subscribeCallCount).toBe(4);
    });

    it("stop() prevents any pending or future reconnect from firing", async () => {
      const broadcaster = new OraclePriceBroadcaster();
      await broadcaster.start();
      statusCallback!("CHANNEL_ERROR");

      await broadcaster.stop();
      await vi.advanceTimersByTimeAsync(60_000);

      expect(subscribeCallCount).toBe(1);
      expect(broadcaster.getStatus()).toBe("stopped");
      expect(broadcaster.isHealthy()).toBe(false);
    });
  });

  describe("getOraclePriceBroadcaster singleton", () => {
    it("returns the same instance across calls", () => {
      const a = getOraclePriceBroadcaster();
      const b = getOraclePriceBroadcaster();
      expect(a).toBe(b);
    });
  });
});
