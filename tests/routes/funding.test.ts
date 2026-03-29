import { describe, it, expect, vi, beforeEach } from "vitest";
import { fundingRoutes } from "../../src/routes/funding.js";
import { clearCache } from "../../src/middleware/cache.js";

// Mock @percolator/shared
vi.mock("@percolator/shared", () => ({
  getSupabase: vi.fn(),
  getConnection: vi.fn(),
  getFundingHistory: vi.fn(),
  getFundingHistorySince: vi.fn(),
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
  sanitizeSlabAddress: vi.fn((addr: string) => addr),
  sanitizePagination: vi.fn((p: any) => p),
  sanitizeString: vi.fn((s: string) => s),
  sendInfoAlert: vi.fn(),
  sendCriticalAlert: vi.fn(),
  sendWarningAlert: vi.fn(),
  eventBus: { on: vi.fn(), emit: vi.fn(), off: vi.fn() },
  config: { supabaseUrl: "http://test", supabaseKey: "test", rpcUrl: "http://test" },
}));

const { getFundingHistory, getFundingHistorySince, getSupabase } = 
  await import("@percolator/shared");

describe("funding routes", () => {
  let mockSupabase: any;

  beforeEach(() => {
    vi.clearAllMocks();
    // Clear the in-memory response cache so tests don't get cached responses
    clearCache();

    mockSupabase = {
      from: vi.fn(() => mockSupabase),
      select: vi.fn(() => mockSupabase),
      eq: vi.fn(() => mockSupabase),
      single: vi.fn(() => mockSupabase),
    };

    vi.mocked(getSupabase).mockReturnValue(mockSupabase);
  });

  describe("GET /funding/:slab", () => {
    it("should return current funding rate and 24h history", async () => {
      const mockStats = {
        funding_rate: 10,
        net_lp_pos: "1000000",
        symbol: null,
        last_price: null,
      };

      const mockHistory = [
        {
          timestamp: "2025-01-01T00:00:00Z",
          slot: 123456789,
          rate_bps_per_slot: 10,
          net_lp_pos: "1000000",
          price_e6: 50000000000,
          funding_index_qpb_e6: "123456789",
        },
      ];

      mockSupabase.single.mockResolvedValue({ data: mockStats, error: null });
      vi.mocked(getFundingHistorySince).mockResolvedValue(mockHistory);

      const app = fundingRoutes();
      const res = await app.request("/funding/11111111111111111111111111111111");

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.slabAddress).toBe("11111111111111111111111111111111");
      expect(data.currentRateBpsPerSlot).toBe(10);
      expect(data.netLpPosition).toBe("1000000");
      expect(data.last24hHistory).toHaveLength(1);
    });

    it("should calculate rates correctly (hourly/daily/annual from bps/slot)", async () => {
      const mockStats = {
        funding_rate: 100, // 100 bps per slot = 1% per slot
        net_lp_pos: "0",
        symbol: null,
        last_price: null,
      };

      mockSupabase.single.mockResolvedValue({ data: mockStats, error: null });
      vi.mocked(getFundingHistorySince).mockResolvedValue([]);

      const app = fundingRoutes();
      const res = await app.request("/funding/11111111111111111111111111111111");

      expect(res.status).toBe(200);
      const data = await res.json();
      
      // 100 bps/slot = 0.01/slot
      // Hourly: 0.01 * 9000 = 90%
      // Daily: 0.01 * 216000 = 2160%
      // Annual: 0.01 * 78840000 = 788400%
      expect(data.hourlyRatePercent).toBe(90);
      expect(data.dailyRatePercent).toBe(2160);
      expect(data.annualizedPercent).toBe(788400);
    });

    it("should return 404 when market not found", async () => {
      mockSupabase.single.mockResolvedValue({ 
        data: null, 
        error: { code: "PGRST116" } 
      });

      const app = fundingRoutes();
      const res = await app.request("/funding/11111111111111111111111111111111");

      expect(res.status).toBe(404);
      const data = await res.json();
      expect(data.error).toBe("Market stats not found");
    });

    it("should return 400 for invalid slab", async () => {
      const app = fundingRoutes();
      const res = await app.request("/funding/invalid-slab");

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toBe("Invalid slab address");
    });

    it("should handle zero funding rate", async () => {
      const mockStats = {
        funding_rate: 0,
        net_lp_pos: "0",
        symbol: null,
        last_price: null,
      };

      mockSupabase.single.mockResolvedValue({ data: mockStats, error: null });
      vi.mocked(getFundingHistorySince).mockResolvedValue([]);

      const app = fundingRoutes();
      const res = await app.request("/funding/11111111111111111111111111111111");

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.currentRateBpsPerSlot).toBe(0);
      expect(data.hourlyRatePercent).toBe(0);
      expect(data.dailyRatePercent).toBe(0);
      expect(data.annualizedPercent).toBe(0);
    });

    it("should handle negative funding rate", async () => {
      const mockStats = {
        funding_rate: -50,
        net_lp_pos: "-500000",
        symbol: null,
        last_price: null,
      };

      mockSupabase.single.mockResolvedValue({ data: mockStats, error: null });
      vi.mocked(getFundingHistorySince).mockResolvedValue([]);

      const app = fundingRoutes();
      const res = await app.request("/funding/11111111111111111111111111111111");

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.currentRateBpsPerSlot).toBe(-50);
      expect(data.hourlyRatePercent).toBe(-45);
      expect(data.dailyRatePercent).toBe(-1080);
    });

    describe("GH#1511: metadata.symbol and metadata.last_price must be populated", () => {
      it("returns symbol and last_price when market has data", async () => {
        const mockStats = {
          funding_rate: 5,
          net_lp_pos: "1000000",
          symbol: "WENDYS",
          last_price: 0.000099,
        };

        mockSupabase.single.mockResolvedValue({ data: mockStats, error: null });
        vi.mocked(getFundingHistorySince).mockResolvedValue([]);

        const app = fundingRoutes();
        const res = await app.request("/funding/11111111111111111111111111111111");

        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.metadata.symbol).toBe("WENDYS");
        expect(data.metadata.last_price).toBeCloseTo(0.000099);
      });

      it("returns null symbol when market row has no symbol", async () => {
        const mockStats = {
          funding_rate: 5,
          net_lp_pos: "0",
          symbol: null,
          last_price: 45000,
        };

        mockSupabase.single.mockResolvedValue({ data: mockStats, error: null });
        vi.mocked(getFundingHistorySince).mockResolvedValue([]);

        const app = fundingRoutes();
        const res = await app.request("/funding/11111111111111111111111111111111");

        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.metadata.symbol).toBeNull();
        expect(data.metadata.last_price).toBe(45000);
      });

      it("sanitizes last_price above $1M to null (corrupt admin-set price)", async () => {
        const mockStats = {
          funding_rate: 5,
          net_lp_pos: "0",
          symbol: "CORRUPT",
          last_price: 7_902_953_782_213.77,
        };

        mockSupabase.single.mockResolvedValue({ data: mockStats, error: null });
        vi.mocked(getFundingHistorySince).mockResolvedValue([]);

        const app = fundingRoutes();
        const res = await app.request("/funding/11111111111111111111111111111111");

        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.metadata.symbol).toBe("CORRUPT");
        expect(data.metadata.last_price).toBeNull();
      });

      it("sanitizes zero last_price to null", async () => {
        const mockStats = {
          funding_rate: 0,
          net_lp_pos: "0",
          symbol: "ZERO",
          last_price: 0,
        };

        mockSupabase.single.mockResolvedValue({ data: mockStats, error: null });
        vi.mocked(getFundingHistorySince).mockResolvedValue([]);

        const app = fundingRoutes();
        const res = await app.request("/funding/11111111111111111111111111111111");

        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.metadata.last_price).toBeNull();
      });

      it("metadata always contains dataPoints24h and explanation fields", async () => {
        const mockStats = {
          funding_rate: 1,
          net_lp_pos: "0",
          symbol: "TEST",
          last_price: 100,
        };

        mockSupabase.single.mockResolvedValue({ data: mockStats, error: null });
        vi.mocked(getFundingHistorySince).mockResolvedValue([]);

        const app = fundingRoutes();
        const res = await app.request("/funding/11111111111111111111111111111111");

        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.metadata).toHaveProperty("dataPoints24h");
        expect(data.metadata).toHaveProperty("explanation");
        expect(data.metadata).toHaveProperty("symbol");
        expect(data.metadata).toHaveProperty("last_price");
      });
    });
  });

  describe("GET /funding/:slab/history", () => {
    it("should return funding history with default limit", async () => {
      const mockHistory = [
        {
          timestamp: "2025-01-01T00:00:00Z",
          slot: 123456789,
          rate_bps_per_slot: 10,
          net_lp_pos: "1000000",
          price_e6: 50000000000,
          funding_index_qpb_e6: "123456789",
        },
      ];

      vi.mocked(getFundingHistory).mockResolvedValue(mockHistory);

      const app = fundingRoutes();
      const res = await app.request("/funding/11111111111111111111111111111111/history");

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.slabAddress).toBe("11111111111111111111111111111111");
      expect(data.count).toBe(1);
      expect(data.history).toHaveLength(1);
      expect(getFundingHistory).toHaveBeenCalledWith("11111111111111111111111111111111", 100);
    });

    it("should respect limit parameter", async () => {
      vi.mocked(getFundingHistory).mockResolvedValue([]);

      const app = fundingRoutes();
      await app.request("/funding/11111111111111111111111111111111/history?limit=500");

      expect(getFundingHistory).toHaveBeenCalledWith("11111111111111111111111111111111", 500);
    });

    it("should clamp limit to max 500 (PERC-8178)", async () => {
      vi.mocked(getFundingHistory).mockResolvedValue([]);

      const app = fundingRoutes();
      await app.request("/funding/11111111111111111111111111111111/history?limit=5000");

      expect(getFundingHistory).toHaveBeenCalledWith("11111111111111111111111111111111", 500);
    });

    it("should use since parameter when provided (ISO 8601)", async () => {
      vi.mocked(getFundingHistorySince).mockResolvedValue([]);

      const app = fundingRoutes();
      await app.request("/funding/11111111111111111111111111111111/history?since=2025-01-01T00:00:00Z");

      expect(getFundingHistorySince).toHaveBeenCalledWith("11111111111111111111111111111111", "2025-01-01T00:00:00.000Z");
    });

    it("should accept unix epoch seconds as since param (PERC-8178)", async () => {
      vi.mocked(getFundingHistorySince).mockResolvedValue([]);

      const app = fundingRoutes();
      // 1704067200 = 2024-01-01T00:00:00Z
      await app.request("/funding/11111111111111111111111111111111/history?since=1704067200");

      expect(getFundingHistorySince).toHaveBeenCalledWith("11111111111111111111111111111111", "2024-01-01T00:00:00.000Z");
    });

    it("should accept unix epoch milliseconds as since param (PERC-8178)", async () => {
      vi.mocked(getFundingHistorySince).mockResolvedValue([]);

      const app = fundingRoutes();
      // 1704067200000 = 2024-01-01T00:00:00Z
      await app.request("/funding/11111111111111111111111111111111/history?since=1704067200000");

      expect(getFundingHistorySince).toHaveBeenCalledWith("11111111111111111111111111111111", "2024-01-01T00:00:00.000Z");
    });

    it("should return 400 for invalid since param (PERC-8178)", async () => {
      const app = fundingRoutes();
      const res = await app.request("/funding/11111111111111111111111111111111/history?since=not-a-date");

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain("Invalid since parameter");
    });

    it("should return 400 for since param with year out of range (PERC-8178)", async () => {
      const app = fundingRoutes();
      const res = await app.request("/funding/11111111111111111111111111111111/history?since=1900-01-01T00:00:00Z");

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain("Invalid since parameter");
    });

    it("should cap results at 500 rows when using since (PERC-8178)", async () => {
      // Return 600 rows from the DB
      const bigHistory = Array.from({ length: 600 }, (_, i) => ({
        timestamp: `2025-01-01T00:${String(i).padStart(2, "0")}:00Z`,
        slot: 100000 + i,
        rate_bps_per_slot: 5,
        net_lp_pos: "0",
        price_e6: 50000000000,
        funding_index_qpb_e6: "0",
      }));
      vi.mocked(getFundingHistorySince).mockResolvedValue(bigHistory);

      const app = fundingRoutes();
      const res = await app.request("/funding/11111111111111111111111111111111/history?since=2025-01-01T00:00:00Z");

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.count).toBe(500);
      expect(data.history).toHaveLength(500);
    });

    it("should return 400 for invalid slab", async () => {
      const app = fundingRoutes();
      const res = await app.request("/funding/invalid/history");

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toBe("Invalid slab address");
    });
  });

  describe("GET /funding/global", () => {
    it("should return funding rates for all markets", async () => {
      const mockStats = [
        {
          slab_address: "11111111111111111111111111111111",
          funding_rate: 10,
          net_lp_pos: "1000000",
        },
        {
          slab_address: "22222222222222222222222222222222",
          funding_rate: -5,
          net_lp_pos: "-500000",
        },
      ];

      // The route will be matched, need to make sure Supabase returns properly
      mockSupabase.from.mockReturnValue({
        select: vi.fn().mockResolvedValue({ data: mockStats, error: null }),
      });

      const app = fundingRoutes();
      const res = await app.request("/funding/global");

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.count).toBe(2);
      expect(data.markets).toHaveLength(2);
      expect(data.markets[0].slabAddress).toBe("11111111111111111111111111111111");
      expect(data.markets[0].currentRateBpsPerSlot).toBe(10);
      expect(data.markets[1].currentRateBpsPerSlot).toBe(-5);
    });

    it("should calculate rates for all markets", async () => {
      const mockStats = [
        {
          slab_address: "11111111111111111111111111111111",
          funding_rate: 100,
          net_lp_pos: "0",
        },
      ];

      mockSupabase.from.mockReturnValue({
        select: vi.fn().mockResolvedValue({ data: mockStats, error: null }),
      });

      const app = fundingRoutes();
      const res = await app.request("/funding/global");

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.markets[0].hourlyRatePercent).toBe(90);
      expect(data.markets[0].dailyRatePercent).toBe(2160);
    });

    it("should handle empty markets list", async () => {
      mockSupabase.from.mockReturnValue({
        select: vi.fn().mockResolvedValue({ data: [], error: null }),
      });

      const app = fundingRoutes();
      const res = await app.request("/funding/global");

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.count).toBe(0);
      expect(data.markets).toHaveLength(0);
    });

    describe("GH#1459: blocklist bypass — blocked slabs must not appear in /funding/global", () => {
      // These four addresses are on the backend HARDCODED_BLOCKED_SLABS list.
      // Individual /funding/:slab 404s via validateSlab, but /funding/global was
      // querying all market_stats rows without filtering, exposing phantom netLpPosition.
      const BLOCKED_SLABS = [
        "8eFFEFBY3HHbBgzxJJP5hyxdzMNMAumnYNhkWXErBM4c", // DfLoAzny/USD — GH#1413
        "3bmCyPee8GWJR5aPGTyN5EyyQJLzYyD8Wkg9m1Afd1SD", // SEX/USD — migration 048
        "3YDqCJGz88xGiPBiRvx4vrM51mWTiTZPZ95hxYDZqKpJ", // phantom-OI — migration 048
        "3ZKKwsKoo5UP28cYmMpvGpwoFpWLVgEWLQJCejJnECQn", // phantom-OI — no liquidity
      ];

      it("filters out all 4 blocked slabs from /funding/global response", async () => {
        const mockStats = [
          // 1 real market
          { slab_address: "11111111111111111111111111111111", funding_rate: 5, net_lp_pos: "1000000" },
          // 4 blocked slabs with phantom netLpPosition
          ...BLOCKED_SLABS.map((addr) => ({
            slab_address: addr,
            funding_rate: 0,
            net_lp_pos: "987000000000000000000000000000000000", // phantom value
          })),
        ];

        mockSupabase.from.mockReturnValue({
          select: vi.fn().mockResolvedValue({ data: mockStats, error: null }),
        });

        const app = fundingRoutes();
        const res = await app.request("/funding/global");

        expect(res.status).toBe(200);
        const data = await res.json();
        // Only the real market should appear
        expect(data.count).toBe(1);
        expect(data.markets).toHaveLength(1);
        expect(data.markets[0].slabAddress).toBe("11111111111111111111111111111111");

        // None of the blocked slabs should be in the response
        const returnedAddrs = data.markets.map((m: { slabAddress: string }) => m.slabAddress);
        for (const blocked of BLOCKED_SLABS) {
          expect(returnedAddrs).not.toContain(blocked);
        }
      });

      it("count in response reflects only unblocked markets", async () => {
        const mockStats = BLOCKED_SLABS.map((addr) => ({
          slab_address: addr,
          funding_rate: 0,
          net_lp_pos: "987000000000000000000000000000000000",
        }));

        mockSupabase.from.mockReturnValue({
          select: vi.fn().mockResolvedValue({ data: mockStats, error: null }),
        });

        const app = fundingRoutes();
        const res = await app.request("/funding/global");

        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.count).toBe(0);
        expect(data.markets).toHaveLength(0);
      });

      it("allows real (non-blocked) slabs through to the response", async () => {
        const mockStats = [
          { slab_address: "11111111111111111111111111111111", funding_rate: 10, net_lp_pos: "0" },
          { slab_address: "22222222222222222222222222222222", funding_rate: -3, net_lp_pos: "500000" },
        ];

        mockSupabase.from.mockReturnValue({
          select: vi.fn().mockResolvedValue({ data: mockStats, error: null }),
        });

        const app = fundingRoutes();
        const res = await app.request("/funding/global");

        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.count).toBe(2);
        expect(data.markets).toHaveLength(2);
      });
    });
  });
});
