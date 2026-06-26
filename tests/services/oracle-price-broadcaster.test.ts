/**
 * Regression for BUG-101: oracle_prices carries only a single push price per
 * row — there is no separate mark/index price in this event source. The
 * broadcaster must not fabricate markPriceE6/indexPriceE6 values equal to the
 * oracle price; doing so caused every live WS price tick to report
 * markPrice === indexPrice === oracle price, contradicting the genuinely
 * distinct values the same channel sends on initial subscribe.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

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
import { OraclePriceBroadcaster } from "../../src/services/OraclePriceBroadcaster.js";

describe("OraclePriceBroadcaster", () => {
  let insertHandler: (payload: { new: unknown }) => void;
  let mockChannel: any;
  let mockSupabase: any;

  beforeEach(() => {
    publishSpy.mockClear();
    mockChannel = {
      on: vi.fn((_event: string, _filter: unknown, handler: typeof insertHandler) => {
        insertHandler = handler;
        return mockChannel;
      }),
      subscribe: vi.fn((cb?: (status: string) => void) => {
        cb?.("SUBSCRIBED");
        return mockChannel;
      }),
    };
    mockSupabase = {
      channel: vi.fn(() => mockChannel),
      removeChannel: vi.fn(),
    };
    vi.mocked(getSupabase).mockReturnValue(mockSupabase);
  });

  it("publishes price.updated WITHOUT fabricated markPriceE6/indexPriceE6 fields", async () => {
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
    expect(data).not.toHaveProperty("markPriceE6");
    expect(data).not.toHaveProperty("indexPriceE6");
  });

  it("ignores a row with a non-positive or non-finite price", async () => {
    const broadcaster = new OraclePriceBroadcaster();
    await broadcaster.start();

    insertHandler({ new: { slab_address: "SLAB1", price_e6: "0", timestamp: Date.now(), tx_signature: null, network: "devnet" } });
    insertHandler({ new: { slab_address: "SLAB1", price_e6: "not-a-number", timestamp: Date.now(), tx_signature: null, network: "devnet" } });

    expect(publishSpy).not.toHaveBeenCalled();
  });
});
