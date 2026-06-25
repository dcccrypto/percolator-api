import { describe, it, expect, vi, beforeEach } from "vitest";
import { insuranceRoutes } from "../../src/routes/insurance.js";

// Mock @percolator/shared
vi.mock("@percolator/shared", () => ({
  getSupabase: vi.fn(),
  getNetwork: vi.fn(() => "devnet"),
  getConnection: vi.fn(),
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
  sanitizeSlabAddress: vi.fn((addr: string) => addr),
  sanitizePagination: vi.fn((p: any) => p),
  sanitizeString: vi.fn((s: string) => s),
  truncateErrorMessage: vi.fn((msg: unknown, _limit?: number) => String(msg ?? "")),
  sendInfoAlert: vi.fn(),
  sendCriticalAlert: vi.fn(),
  sendWarningAlert: vi.fn(),
  eventBus: { on: vi.fn(), emit: vi.fn(), off: vi.fn() },
  config: { supabaseUrl: "http://test", supabaseKey: "test", rpcUrl: "http://test" },
}));

const { getSupabase } = await import("@percolator/shared");

describe("insurance routes", () => {
  let mockSupabase: any;

  beforeEach(() => {
    vi.clearAllMocks();

    mockSupabase = {
      from: vi.fn(() => mockSupabase),
      select: vi.fn(() => mockSupabase),
      eq: vi.fn(() => mockSupabase),
      single: vi.fn(() => mockSupabase),
      order: vi.fn(() => mockSupabase),
      limit: vi.fn(() => mockSupabase),
    };

    vi.mocked(getSupabase).mockReturnValue(mockSupabase);
  });

  function mockInsuranceQueries(
    mockStats: unknown,
    mockHistory: unknown[] = [],
    statsError: unknown = null,
    historyError: unknown = null
  ) {
    const statsBuilder: any = {};
    statsBuilder.select = vi.fn(() => statsBuilder);
    statsBuilder.eq = vi.fn(() => statsBuilder);
    statsBuilder.single = vi.fn().mockResolvedValue({
      data: mockStats,
      error: statsError,
    });

    const historyBuilder: any = {};
    historyBuilder.select = vi.fn(() => historyBuilder);
    historyBuilder.eq = vi.fn(() => historyBuilder);
    historyBuilder.order = vi.fn(() => historyBuilder);
    historyBuilder.limit = vi.fn().mockResolvedValue({
      data: mockHistory,
      error: historyError,
    });

    mockSupabase.from.mockImplementation((table: string) => {
      if (table === "market_stats") return statsBuilder;
      if (table === "insurance_history") return historyBuilder;
      return mockSupabase;
    });
  }

  describe("GET /insurance/:slab", () => {
    it("should return current insurance balance and history", async () => {
      const mockStats = {
        insurance_balance: "1000000000",
        insurance_fee_revenue: "50000000",
        total_open_interest: "5000000000",
      };

      const mockHistory = [
        {
          timestamp: "2025-01-01T00:00:00Z",
          balance: "950000000",
          fee_revenue: "45000000",
        },
        {
          timestamp: "2025-01-01T01:00:00Z",
          balance: "1000000000",
          fee_revenue: "50000000",
        },
      ];

      mockInsuranceQueries(mockStats, mockHistory);

      const app = insuranceRoutes();
      const res = await app.request("/insurance/11111111111111111111111111111111");

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.slabAddress).toBe("11111111111111111111111111111111");
      expect(data.currentBalance).toBe("1000000000");
      expect(data.feeRevenue).toBe("50000000");
      expect(data.totalOpenInterest).toBe("5000000000");
      expect(data.history).toHaveLength(2);
    });

    it("should return 404 when market not found", async () => {
      mockInsuranceQueries(null, [], { code: "PGRST116" });
      const app = insuranceRoutes();
      const res = await app.request("/insurance/11111111111111111111111111111111");

      expect(res.status).toBe(404);
      const data = await res.json();
      expect(data.error).toBe("Market stats not found");
    });

    it("should return 400 for invalid slab", async () => {
      const app = insuranceRoutes();
      const res = await app.request("/insurance/invalid-slab");

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toBe("Invalid slab address");
    });

    it("should handle null values gracefully", async () => {
      const mockStats = {
        insurance_balance: null,
        insurance_fee_revenue: null,
        total_open_interest: null,
      };

      mockInsuranceQueries(mockStats, []);

      const app = insuranceRoutes();
      const res = await app.request("/insurance/11111111111111111111111111111111");

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.currentBalance).toBe("0");
      expect(data.feeRevenue).toBe("0");
      expect(data.totalOpenInterest).toBe("0");
    });

    it("should handle database errors", async () => {
      mockInsuranceQueries(null, [], new Error("Database error"));

      const app = insuranceRoutes();
      const res = await app.request("/insurance/11111111111111111111111111111111");

      expect(res.status).toBe(500);
      const data = await res.json();
      expect(data.error).toBe("Failed to fetch insurance data");
    });

    it("should limit history to 100 records", async () => {
      const mockStats = {
        insurance_balance: "1000000000",
        insurance_fee_revenue: "50000000",
        total_open_interest: "5000000000",
      };

      let limitCalled = false;

      const statsBuilder: any = {};
      statsBuilder.select = vi.fn(() => statsBuilder);
      statsBuilder.eq = vi.fn(() => statsBuilder);
      statsBuilder.single = vi.fn().mockResolvedValue({
        data: mockStats,
        error: null,
      });

      const historyBuilder: any = {};
      historyBuilder.select = vi.fn(() => historyBuilder);
      historyBuilder.eq = vi.fn(() => historyBuilder);
      historyBuilder.order = vi.fn(() => historyBuilder);
      historyBuilder.limit = vi.fn((n: number) => {
        expect(n).toBe(100);
        limitCalled = true;
        return Promise.resolve({
          data: [],
          error: null,
        });
      });

      mockSupabase.from.mockImplementation((table: string) => {
        if (table === "market_stats") return statsBuilder;
        if (table === "insurance_history") return historyBuilder;
        return mockSupabase;
      });

      const app = insuranceRoutes();
      await app.request("/insurance/11111111111111111111111111111111");

      expect(limitCalled).toBe(true);
    });

    describe("blocklist (GH#1388 / PR#1387)", () => {
      // These three phantom-OI / empty-vault slabs must return 404 even when queried
      // directly against the API, bypassing the Next.js proxy blocklist.
      const BLOCKED = [
        "3bmCyPee8GWJR5aPGTyN5EyyQJLzYyD8Wkg9m1Afd1SD",
        "3YDqCJGz88xGiPBiRvx4vrM51mWTiTZPZ95hxYDZqKpJ",
        "3ZKKwsKoo5UP28cYmMpvGpwoFpWLVgEWLQJCejJnECQn",
      ];

      for (const addr of BLOCKED) {
        it(`returns 404 for blocked slab ${addr.slice(0, 8)}... on /insurance`, async () => {
          const app = insuranceRoutes();
          const res = await app.request(`/insurance/${addr}`);
          expect(res.status).toBe(404);
          const data = await res.json();
          expect(data).toEqual({ error: "Market not found" });
          // DB should never be queried for blocked slabs
          expect(mockSupabase.from).not.toHaveBeenCalled();
        });
      }

      it("allows valid non-blocked slabs through to DB layer", async () => {
        mockInsuranceQueries(
          {
            insurance_balance: "1000000000",
            insurance_fee_revenue: "50000000",
            total_open_interest: "5000000000",
          },
          []
        );

        const app = insuranceRoutes();
        const res = await app.request("/insurance/11111111111111111111111111111111");

        expect(res.status).toBe(200);
      });
    });
  });
});
