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
      maybeSingle: vi.fn(() => mockSupabase),
    };

    vi.mocked(getSupabase).mockReturnValue(mockSupabase);
  });

  describe("GET /funding/:slab", () => {
    it("should return current funding rate and 24h history", async () => {
      const mockStats = {
        funding_rate: 10,
        net_lp_pos: "1000000",
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

      mockSupabase.maybeSingle.mockResolvedValue({ data: mockStats, error: null });
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
      };

      mockSupabase.maybeSingle.mockResolvedValue({ data: mockStats, error: null });
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

    it("should return 200 with default zeroed data when market not found", async () => {
      // maybeSingle() returns { data: null, error: null } for zero rows (no PGRST116 error).
      mockSupabase.maybeSingle.mockResolvedValue({ 
        data: null, 
        error: null,
      });

      const app = fundingRoutes();
      const res = await app.request("/funding/11111111111111111111111111111111");

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.slabAddress).toBe("11111111111111111111111111111111");
      expect(data.currentRateBpsPerSlot).toBe(0);
      expect(data.dailyRatePercent).toBe(0);
      expect(data.annualizedPercent).toBe(0);
      expect(data.metadata.note).toContain("not been cranked yet");
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
      };

      mockSupabase.maybeSingle.mockResolvedValue({ data: mockStats, error: null });
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
      };

      mockSupabase.maybeSingle.mockResolvedValue({ data: mockStats, error: null });
      vi.mocked(getFundingHistorySince).mockResolvedValue([]);

      const app = fundingRoutes();
      const res = await app.request("/funding/11111111111111111111111111111111");

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.currentRateBpsPerSlot).toBe(-50);
      expect(data.hourlyRatePercent).toBe(-45);
      expect(data.dailyRatePercent).toBe(-1080);
    });

    it("should sanitize garbage funding_rate values above 10_000 bps/slot", async () => {
      // This is the bug value reported by the designer — stored in DB from old uninitialized slabs
      const mockStats = {
        funding_rate: 1595987084267292,
        net_lp_pos: "0",
      };

      mockSupabase.maybeSingle.mockResolvedValue({ data: mockStats, error: null });
      vi.mocked(getFundingHistorySince).mockResolvedValue([]);

      const app = fundingRoutes();
      const res = await app.request("/funding/11111111111111111111111111111111");

      expect(res.status).toBe(200);
      const data = await res.json();
      // Must be clamped to 0 — the on-chain engine rejects |rate| > 10_000
      expect(data.currentRateBpsPerSlot).toBe(0);
      expect(data.hourlyRatePercent).toBe(0);
      expect(data.dailyRatePercent).toBe(0);
      expect(data.annualizedPercent).toBe(0);
    });

    it("should sanitize garbage negative funding_rate values below -10_000 bps/slot", async () => {
      const mockStats = {
        funding_rate: -1595987084267292,
        net_lp_pos: "0",
      };

      mockSupabase.maybeSingle.mockResolvedValue({ data: mockStats, error: null });
      vi.mocked(getFundingHistorySince).mockResolvedValue([]);

      const app = fundingRoutes();
      const res = await app.request("/funding/11111111111111111111111111111111");

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.currentRateBpsPerSlot).toBe(0);
      expect(data.hourlyRatePercent).toBe(0);
    });

    it("should pass through valid boundary value of exactly 10_000 bps/slot", async () => {
      const mockStats = {
        funding_rate: 10000,
        net_lp_pos: "0",
      };

      mockSupabase.maybeSingle.mockResolvedValue({ data: mockStats, error: null });
      vi.mocked(getFundingHistorySince).mockResolvedValue([]);

      const app = fundingRoutes();
      const res = await app.request("/funding/11111111111111111111111111111111");

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.currentRateBpsPerSlot).toBe(10000);
      // 10000 bps/slot = 1/slot → hourly = 1 * 9000 = 9000%
      expect(data.hourlyRatePercent).toBe(9000);
    });

    it("should return 200 with defaults when market_stats DB query errors (non-fatal)", async () => {
      // Simulates a transient PostgREST error (e.g. schema-cache reload after migration NOTIFY).
      // Previously this would throw and return 500 — now it degrades to default zeroed response.
      mockSupabase.maybeSingle.mockResolvedValue({
        data: null,
        error: { code: "PGRST500", message: "schema cache reload" },
      });

      const app = fundingRoutes();
      const res = await app.request("/funding/11111111111111111111111111111111");

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.slabAddress).toBe("11111111111111111111111111111111");
      expect(data.currentRateBpsPerSlot).toBe(0);
      expect(data.hourlyRatePercent).toBe(0);
      expect(data.last24hHistory).toEqual([]);
    });

    it("should return 200 with current rate but empty history when getFundingHistorySince throws", async () => {
      // Simulates the exact Sentry BACKEND-1/2/3 scenario: market_stats fetch succeeds
      // but the funding_history query errors out. Previously this returned 500.
      const mockStats = { funding_rate: 25, net_lp_pos: "500000" };
      mockSupabase.maybeSingle.mockResolvedValue({ data: mockStats, error: null });
      vi.mocked(getFundingHistorySince).mockRejectedValue(new Error("funding_history unavailable"));

      const app = fundingRoutes();
      const res = await app.request("/funding/11111111111111111111111111111111");

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.slabAddress).toBe("11111111111111111111111111111111");
      expect(data.currentRateBpsPerSlot).toBe(25);
      // Rates still computed from the stats data
      expect(data.hourlyRatePercent).toBeCloseTo(22.5, 4);
      // History falls back to empty array — no 500
      expect(data.last24hHistory).toEqual([]);
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

    it("should clamp limit to max 1000", async () => {
      vi.mocked(getFundingHistory).mockResolvedValue([]);

      const app = fundingRoutes();
      await app.request("/funding/11111111111111111111111111111111/history?limit=5000");

      expect(getFundingHistory).toHaveBeenCalledWith("11111111111111111111111111111111", 1000);
    });

    it("should use since parameter when provided", async () => {
      vi.mocked(getFundingHistorySince).mockResolvedValue([]);

      const app = fundingRoutes();
      await app.request("/funding/11111111111111111111111111111111/history?since=2025-01-01T00:00:00Z");

      expect(getFundingHistorySince).toHaveBeenCalledWith("11111111111111111111111111111111", "2025-01-01T00:00:00Z");
    });

    it("should return 400 for invalid slab", async () => {
      const app = fundingRoutes();
      const res = await app.request("/funding/invalid/history");

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toBe("Invalid slab address");
    });

    it("should return 200 with empty history when getFundingHistory throws (Sentry PERC-568 regression)", async () => {
      // Simulates a transient DB error on the /history endpoint.
      // Previously this would propagate to the outer catch and return 500.
      vi.mocked(getFundingHistory).mockRejectedValue(new Error("funding_history DB unavailable"));

      const app = fundingRoutes();
      const res = await app.request("/funding/11111111111111111111111111111111/history");

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.slabAddress).toBe("11111111111111111111111111111111");
      expect(data.count).toBe(0);
      expect(data.history).toEqual([]);
      expect(data.degraded).toBe(true);
    });

    it("should return 200 with empty history when getFundingHistorySince throws (since param)", async () => {
      vi.mocked(getFundingHistorySince).mockRejectedValue(new Error("funding_history schema reload"));

      const app = fundingRoutes();
      const res = await app.request(
        "/funding/11111111111111111111111111111111/history?since=2025-01-01T00:00:00Z"
      );

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.count).toBe(0);
      expect(data.history).toEqual([]);
      expect(data.degraded).toBe(true);
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

    it("should return 200 with empty markets on DB error (Sentry PERC-568 regression)", async () => {
      // Simulates a transient PostgREST schema-cache reload error on /funding/global.
      // Previously: if (error) throw error → outer catch → 500.
      // Now: logs warn and returns { count: 0, markets: [], degraded: true }.
      mockSupabase.from.mockReturnValue({
        select: vi.fn().mockResolvedValue({
          data: null,
          error: { code: "PGRST500", message: "schema cache reload" },
        }),
      });

      const app = fundingRoutes();
      const res = await app.request("/funding/global");

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.count).toBe(0);
      expect(data.markets).toEqual([]);
      expect(data.degraded).toBe(true);
    });
  });
});
