import { describe, it, expect, vi, beforeEach } from "vitest";
import { bucketCandles, candleRoutes } from "../../src/routes/candles.js";

vi.mock("@percolator/shared", () => ({
  getSupabase: vi.fn(),
  getNetwork: vi.fn(() => "devnet"),
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
  truncateErrorMessage: vi.fn((msg: string) => msg),
  sanitizeSlabAddress: vi.fn((addr: string) => addr),
}));

const { getSupabase } = await import("@percolator/shared");

describe("bucketCandles", () => {
  it("returns no_data on empty input", () => {
    expect(bucketCandles([], 60)).toMatchObject({ s: "no_data", t: [] });
  });

  it("buckets trades into 1-minute OHLCV", () => {
    const trades = [
      { price: 100, size: 10, created_at: "2026-04-20T12:00:15Z" }, // bucket 12:00
      { price: 105, size: 5, created_at: "2026-04-20T12:00:45Z" },  // bucket 12:00
      { price: 102, size: 20, created_at: "2026-04-20T12:01:10Z" }, // bucket 12:01
    ];
    const bars = bucketCandles(trades, 60);
    expect(bars.s).toBe("ok");
    expect(bars.t).toHaveLength(2);
    // first bucket: o=100, h=105, l=100, c=105, v=15
    expect(bars.o[0]).toBe(100);
    expect(bars.h[0]).toBe(105);
    expect(bars.l[0]).toBe(100);
    expect(bars.c[0]).toBe(105);
    expect(bars.v[0]).toBe(15);
    // second bucket: o=102, h=102, l=102, c=102, v=20
    expect(bars.o[1]).toBe(102);
    expect(bars.v[1]).toBe(20);
  });

  it("keeps high/low across many trades in one bucket", () => {
    const trades = [
      { price: 100, size: 1, created_at: "2026-04-20T12:00:00Z" },
      { price: 110, size: 1, created_at: "2026-04-20T12:00:10Z" },
      { price: 95, size: 1, created_at: "2026-04-20T12:00:20Z" },
      { price: 105, size: 1, created_at: "2026-04-20T12:00:30Z" },
    ];
    const bars = bucketCandles(trades, 60);
    expect(bars.h[0]).toBe(110);
    expect(bars.l[0]).toBe(95);
    expect(bars.c[0]).toBe(105);
    expect(bars.v[0]).toBe(4);
  });

  it("skips trades with non-finite price/size", () => {
    const trades = [
      { price: NaN, size: 1, created_at: "2026-04-20T12:00:00Z" },
      { price: 100, size: Infinity, created_at: "2026-04-20T12:00:05Z" },
      { price: 101, size: 5, created_at: "2026-04-20T12:00:10Z" },
    ];
    const bars = bucketCandles(trades, 60);
    expect(bars.t).toHaveLength(1);
    expect(bars.o[0]).toBe(101);
  });

  it("sorts buckets ascending even when input is shuffled", () => {
    const trades = [
      { price: 200, size: 1, created_at: "2026-04-20T12:02:00Z" },
      { price: 100, size: 1, created_at: "2026-04-20T12:00:00Z" },
      { price: 150, size: 1, created_at: "2026-04-20T12:01:00Z" },
    ];
    const bars = bucketCandles(trades, 60);
    expect(bars.t[0] < bars.t[1] && bars.t[1] < bars.t[2]).toBe(true);
  });
});

describe("GET /candles/:slab", () => {
  let mockSupabase: any;
  const SLAB = "GGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG";

  beforeEach(() => {
    vi.clearAllMocks();
    mockSupabase = {
      from: vi.fn(() => mockSupabase),
      select: vi.fn(() => mockSupabase),
      eq: vi.fn(() => mockSupabase),
      gte: vi.fn(() => mockSupabase),
      lte: vi.fn(() => mockSupabase),
      order: vi.fn(() => mockSupabase),
      limit: vi.fn().mockResolvedValue({ data: [], error: null }),
    };
    vi.mocked(getSupabase).mockReturnValue(mockSupabase);
  });

  it("returns no_data when trades table is empty", async () => {
    const app = candleRoutes();
    const res = await app.request(`/candles/${SLAB}?resolution=1&from=0&to=9999999999`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.s).toBe("no_data");
  });

  it("returns ok with bars when trades exist", async () => {
    mockSupabase.limit.mockResolvedValueOnce({
      data: [
        { price: 100, size: 10, created_at: "2026-04-20T12:00:00Z" },
        { price: 101, size: 5, created_at: "2026-04-20T12:00:30Z" },
      ],
      error: null,
    });
    const app = candleRoutes();
    const res = await app.request(`/candles/${SLAB}?resolution=1&from=0&to=9999999999`);
    const body = await res.json() as any;
    expect(body.s).toBe("ok");
    expect(body.t).toHaveLength(1);
    expect(body.h[0]).toBe(101);
    expect(body.v[0]).toBe(15);
  });

  it("rejects unsupported resolution", async () => {
    const app = candleRoutes();
    const res = await app.request(`/candles/${SLAB}?resolution=99&from=0&to=9999999999`);
    expect(res.status).toBe(400);
  });

  it("rejects invalid from/to", async () => {
    const app = candleRoutes();
    const res = await app.request(`/candles/${SLAB}?resolution=1&from=1000&to=500`);
    expect(res.status).toBe(400);
  });
});
