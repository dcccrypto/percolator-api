import { describe, it, expect, vi, beforeEach } from "vitest";
import { tradeRoutes } from "../../src/routes/trades.js";

// Mock @percolator/shared
vi.mock("@percolator/shared", () => ({
  getSupabase: vi.fn(),
  getConnection: vi.fn(),
  getRecentTrades: vi.fn(),
  get24hVolume: vi.fn(),
  getGlobalRecentTrades: vi.fn(),
  getPriceHistory: vi.fn(),
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
  sanitizeSlabAddress: vi.fn((addr: string) => {
    // Replicate real sanitizeSlabAddress: validate length and base58 format
    if (typeof addr !== "string") return null;
    const trimmed = addr.trim();
    if (trimmed.length < 32 || trimmed.length > 44) return null;
    if (!/^[1-9A-HJ-NP-Za-km-z]+$/.test(trimmed)) return null;
    return trimmed;
  }),
  sanitizePagination: vi.fn((limit?: any, _offset?: any) => {
    // Replicate real sanitizePagination logic
    const DEFAULT_LIMIT = 50;
    const MAX_LIMIT = 500;
    let safeLimit = DEFAULT_LIMIT;
    if (typeof limit === "number") {
      safeLimit = Math.floor(limit);
    } else if (typeof limit === "string") {
      const parsed = parseInt(limit, 10);
      if (!isNaN(parsed)) safeLimit = parsed;
    }
    safeLimit = Math.max(1, Math.min(safeLimit, MAX_LIMIT));
    return { limit: safeLimit, offset: 0 };
  }),
  sanitizeString: vi.fn((s: string) => s),
  sanitizeNumber: vi.fn((input: any, min?: number, max?: number) => {
    // Replicate real sanitizeNumber logic
    let num: number;
    if (typeof input === "number") {
      num = input;
    } else if (typeof input === "string") {
      const parsed = parseFloat(input);
      if (isNaN(parsed)) return null;
      num = parsed;
    } else {
      return null;
    }
    if (!isFinite(num)) return null;
    if (min !== undefined && num < min) return null;
    if (max !== undefined && num > max) return null;
    return num;
  }),
  sendInfoAlert: vi.fn(),
  sendCriticalAlert: vi.fn(),
  sendWarningAlert: vi.fn(),
  eventBus: { on: vi.fn(), emit: vi.fn(), off: vi.fn() },
  config: { supabaseUrl: "http://test", supabaseKey: "test", rpcUrl: "http://test" },
}));

const { getRecentTrades, get24hVolume, getGlobalRecentTrades, getPriceHistory } = 
  await import("@percolator/shared");

describe("trades routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("GET /markets/:slab/trades", () => {
    it("should return recent trades for a market", async () => {
      const mockTrades = [
        {
          tx_signature: "sig1abc111111111111111111111111111111111111111111111",
          side: "buy",
          size: 100,
          price: 50000,
          timestamp: "2025-01-01T00:00:00Z",
        },
        {
          tx_signature: "sig2abc222222222222222222222222222222222222222222222",
          side: "sell",
          size: 200,
          price: 50100,
          timestamp: "2025-01-01T00:01:00Z",
        },
      ];

      vi.mocked(getRecentTrades).mockResolvedValue(mockTrades);

      const app = tradeRoutes();
      const res = await app.request("/markets/11111111111111111111111111111111/trades");

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.trades).toHaveLength(2);
      expect(getRecentTrades).toHaveBeenCalledWith("11111111111111111111111111111111", 50);
    });

    it("should return trade objects with all required fields", async () => {
      const mockTrades = [
        {
          tx_signature: "sigABC111111111111111111111111111111111111111111111",
          side: "buy",
          size: 500,
          price: 48000,
          timestamp: "2025-03-01T12:00:00Z",
        },
      ];

      vi.mocked(getRecentTrades).mockResolvedValue(mockTrades);

      const app = tradeRoutes();
      const res = await app.request("/markets/11111111111111111111111111111111/trades");

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.trades).toHaveLength(1);

      const trade = data.trades[0];
      expect(trade).toHaveProperty("tx_signature");
      expect(trade).toHaveProperty("side");
      expect(trade).toHaveProperty("size");
      expect(trade).toHaveProperty("price");
      expect(trade).toHaveProperty("timestamp");
      expect(typeof trade.tx_signature).toBe("string");
      expect(["buy", "sell"]).toContain(trade.side);
      expect(typeof trade.size).toBe("number");
      expect(typeof trade.price).toBe("number");
    });

    it("should return empty array (not null) when no trades exist", async () => {
      vi.mocked(getRecentTrades).mockResolvedValue([]);

      const app = tradeRoutes();
      const res = await app.request("/markets/11111111111111111111111111111111/trades");

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.trades).toBeDefined();
      expect(Array.isArray(data.trades)).toBe(true);
      expect(data.trades).toHaveLength(0);
      expect(data.trades).not.toBeNull();
    });

    it("should respect limit parameter", async () => {
      vi.mocked(getRecentTrades).mockResolvedValue([]);

      const app = tradeRoutes();
      await app.request("/markets/11111111111111111111111111111111/trades?limit=100");

      expect(getRecentTrades).toHaveBeenCalledWith("11111111111111111111111111111111", 100);
    });

    it("should clamp limit to 1-200 range", async () => {
      vi.mocked(getRecentTrades).mockResolvedValue([]);

      const app = tradeRoutes();
      
      // Test upper bound: sanitizePagination returns 500 (MAX_LIMIT), then Math.min(500, 200) = 200
      await app.request("/markets/11111111111111111111111111111111/trades?limit=500");
      expect(getRecentTrades).toHaveBeenCalledWith("11111111111111111111111111111111", 200);

      // Test lower bound: sanitizePagination clamps to 1, then Math.min(1, 200) = 1
      await app.request("/markets/11111111111111111111111111111111/trades?limit=0");
      expect(getRecentTrades).toHaveBeenCalledWith("11111111111111111111111111111111", 1);
    });

    it("should return 400 for invalid slab format", async () => {
      const app = tradeRoutes();
      const res = await app.request("/markets/invalid-address/trades");

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toBe("Invalid slab address");
    });

    it("should handle errors from getRecentTrades", async () => {
      vi.mocked(getRecentTrades).mockRejectedValue(new Error("Database error"));

      const app = tradeRoutes();
      const res = await app.request("/markets/11111111111111111111111111111111/trades");

      expect(res.status).toBe(500);
      const data = await res.json();
      expect(data.error).toBe("Failed to fetch trades");
    });
  });

  describe("GET /markets/:slab/volume", () => {
    it("should return 24h volume for a market", async () => {
      vi.mocked(get24hVolume).mockResolvedValue({
        volume: "10000000000",
        tradeCount: 150,
      });

      const app = tradeRoutes();
      const res = await app.request("/markets/11111111111111111111111111111111/volume");

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.slab_address).toBe("11111111111111111111111111111111");
      expect(data.volume_24h).toBe("10000000000");
      expect(data.trade_count_24h).toBe(150);
    });

    it("should return 400 for invalid slab format", async () => {
      const app = tradeRoutes();
      const res = await app.request("/markets/invalid/volume");

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toBe("Invalid slab address");
    });
  });

  describe("GET /markets/:slab/prices", () => {
    it("should return price history for a market", async () => {
      const mockPrices = [
        { price_e6: 50000000000, timestamp: "2025-01-01T00:00:00Z" },
        { price_e6: 50100000000, timestamp: "2025-01-01T01:00:00Z" },
      ];

      vi.mocked(getPriceHistory).mockResolvedValue(mockPrices);

      const app = tradeRoutes();
      const res = await app.request("/markets/11111111111111111111111111111111/prices");

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.slab_address).toBe("11111111111111111111111111111111");
      expect(data.prices).toHaveLength(2);
      expect(data.prices[0].price).toBe(50000);
      expect(data.prices[0].price_e6).toBe(50000000000);
    });

    it("should handle hours parameter", async () => {
      vi.mocked(getPriceHistory).mockResolvedValue([]);

      const app = tradeRoutes();
      await app.request("/markets/11111111111111111111111111111111/prices?hours=48");

      // Check that getPriceHistory was called with a timestamp ~48 hours ago
      expect(getPriceHistory).toHaveBeenCalled();
      const call = vi.mocked(getPriceHistory).mock.calls[0];
      const sinceEpoch = call[1];
      const expectedEpoch = Math.floor((Date.now() - 48 * 60 * 60 * 1000) / 1000);
      expect(sinceEpoch).toBeCloseTo(expectedEpoch, -2); // Within ~100 seconds
    });

    it("should fall back to 24h when hours is out of range [1-720]", async () => {
      vi.mocked(getPriceHistory).mockResolvedValue([]);

      const app = tradeRoutes();

      // Test upper bound: 1000 > max 720, sanitizeNumber returns null, fallback to 24h
      await app.request("/markets/11111111111111111111111111111111/prices?hours=1000");
      const call1 = vi.mocked(getPriceHistory).mock.calls[0];
      const since1 = call1[1];
      const expected1 = Math.floor((Date.now() - 24 * 60 * 60 * 1000) / 1000);
      expect(since1).toBeCloseTo(expected1, -2);

      // Test lower bound: 0 < min 1, sanitizeNumber returns null, fallback to 24h
      await app.request("/markets/11111111111111111111111111111111/prices?hours=0");
      const call2 = vi.mocked(getPriceHistory).mock.calls[1];
      const since2 = call2[1];
      const expected2 = Math.floor((Date.now() - 24 * 60 * 60 * 1000) / 1000);
      expect(since2).toBeCloseTo(expected2, -2);
    });

    it("should return 400 for invalid slab format", async () => {
      const app = tradeRoutes();
      const res = await app.request("/markets/invalid/prices");

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toBe("Invalid slab address");
    });
  });

  describe("GET /trades/recent", () => {
    it("should return global recent trades", async () => {
      const mockTrades = [
        { id: "1", slab_address: "11111111111111111111111111111111", price: 50000 },
        { id: "2", slab_address: "22222222222222222222222222222222", price: 3000 },
      ];

      vi.mocked(getGlobalRecentTrades).mockResolvedValue(mockTrades);

      const app = tradeRoutes();
      const res = await app.request("/trades/recent");

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.trades).toHaveLength(2);
      expect(getGlobalRecentTrades).toHaveBeenCalledWith(50);
    });

    it("should respect limit parameter", async () => {
      vi.mocked(getGlobalRecentTrades).mockResolvedValue([]);

      const app = tradeRoutes();
      await app.request("/trades/recent?limit=100");

      expect(getGlobalRecentTrades).toHaveBeenCalledWith(100);
    });

    it("should clamp limit to 1-200 range", async () => {
      vi.mocked(getGlobalRecentTrades).mockResolvedValue([]);

      const app = tradeRoutes();
      
      // Test upper bound: sanitizePagination returns 300 (under MAX_LIMIT=500), Math.min(300, 200) = 200
      await app.request("/trades/recent?limit=300");
      expect(getGlobalRecentTrades).toHaveBeenCalledWith(200);

      // Test lower bound: sanitizePagination clamps -5 to 1, Math.min(1, 200) = 1
      await app.request("/trades/recent?limit=-5");
      expect(getGlobalRecentTrades).toHaveBeenCalledWith(1);
    });
  });
});
