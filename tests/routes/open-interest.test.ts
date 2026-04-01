import { describe, it, expect, vi, beforeEach } from "vitest";
import { openInterestRoutes } from "../../src/routes/open-interest.js";
import { clearCache } from "../../src/middleware/cache.js";

// Mock @percolator/shared
vi.mock("@percolator/shared", () => ({
  getSupabase: vi.fn(),
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

describe("open-interest routes", () => {
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
      order: vi.fn(() => mockSupabase),
      limit: vi.fn(() => mockSupabase),
    };

    vi.mocked(getSupabase).mockReturnValue(mockSupabase);
  });

  describe("GET /open-interest/:slab", () => {
    it("should return OI data and history", async () => {
      const mockStats = {
        total_open_interest: "5000000000",
        net_lp_pos: "1500000",
        lp_sum_abs: "2000000",
        lp_max_abs: "500000",
      };

      const mockHistory = [
        {
          timestamp: "2025-01-01T00:00:00Z",
          total_oi: "4800000000",
          net_lp_pos: "1400000",
        },
        {
          timestamp: "2025-01-01T01:00:00Z",
          total_oi: "5000000000",
          net_lp_pos: "1500000",
        },
      ];

      mockSupabase.from.mockImplementation((table: string) => {
        if (table === "market_stats") {
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => ({
                single: vi.fn().mockResolvedValue({ data: mockStats, error: null }),
              })),
            })),
          };
        } else if (table === "oi_history") {
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => ({
                order: vi.fn(() => ({
                  limit: vi.fn().mockResolvedValue({ data: mockHistory, error: null }),
                })),
              })),
            })),
          };
        }
        return mockSupabase;
      });

      const app = openInterestRoutes();
      const res = await app.request("/open-interest/11111111111111111111111111111111");

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.slabAddress).toBe("11111111111111111111111111111111");
      expect(data.totalOpenInterest).toBe("5000000000");
      expect(data.netLpPos).toBe("1500000");
      expect(data.lpSumAbs).toBe("2000000");
      expect(data.lpMaxAbs).toBe("500000");
      expect(data.history).toHaveLength(2);
    });

    it("should return 404 when market not found", async () => {
      mockSupabase.from.mockImplementation((table: string) => {
        if (table === "market_stats") {
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => ({
                single: vi.fn().mockResolvedValue({ 
                  data: null, 
                  error: { code: "PGRST116" } 
                }),
              })),
            })),
          };
        }
        return mockSupabase;
      });

      const app = openInterestRoutes();
      const res = await app.request("/open-interest/11111111111111111111111111111111");

      expect(res.status).toBe(404);
      const data = await res.json();
      expect(data.error).toBe("Market stats not found");
    });

    it("should return 400 for invalid slab", async () => {
      const app = openInterestRoutes();
      const res = await app.request("/open-interest/invalid-slab");

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toBe("Invalid slab address");
    });

    it("should handle null values gracefully", async () => {
      const mockStats = {
        total_open_interest: null,
        net_lp_pos: null,
        lp_sum_abs: null,
        lp_max_abs: null,
      };

      mockSupabase.from.mockImplementation((table: string) => {
        if (table === "market_stats") {
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => ({
                single: vi.fn().mockResolvedValue({ data: mockStats, error: null }),
              })),
            })),
          };
        } else if (table === "oi_history") {
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => ({
                order: vi.fn(() => ({
                  limit: vi.fn().mockResolvedValue({ data: [], error: null }),
                })),
              })),
            })),
          };
        }
        return mockSupabase;
      });

      const app = openInterestRoutes();
      const res = await app.request("/open-interest/11111111111111111111111111111111");

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.totalOpenInterest).toBe("0");
      expect(data.netLpPos).toBe("0");
      expect(data.lpSumAbs).toBe("0");
      expect(data.lpMaxAbs).toBe("0");
    });

    it("should handle database errors", async () => {
      mockSupabase.from.mockImplementation((table: string) => {
        if (table === "market_stats") {
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => ({
                single: vi.fn().mockResolvedValue({ 
                  data: null, 
                  error: new Error("Database error") 
                }),
              })),
            })),
          };
        }
        return mockSupabase;
      });

      const app = openInterestRoutes();
      const res = await app.request("/open-interest/11111111111111111111111111111111");

      expect(res.status).toBe(500);
      const data = await res.json();
      expect(data.error).toBe("Failed to fetch open interest data");
    });

    it("should limit history to 100 records", async () => {
      const mockStats = {
        total_open_interest: "5000000000",
        net_lp_pos: "1500000",
        lp_sum_abs: "2000000",
        lp_max_abs: "500000",
      };

      let limitCalled = false;
      mockSupabase.from.mockImplementation((table: string) => {
        if (table === "market_stats") {
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => ({
                single: vi.fn().mockResolvedValue({ data: mockStats, error: null }),
              })),
            })),
          };
        } else if (table === "oi_history") {
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => ({
                order: vi.fn(() => ({
                  limit: vi.fn((n: number) => {
                    expect(n).toBe(100);
                    limitCalled = true;
                    return Promise.resolve({ data: [], error: null });
                  }),
                })),
              })),
            })),
          };
        }
        return mockSupabase;
      });

      const app = openInterestRoutes();
      await app.request("/open-interest/11111111111111111111111111111111");

      expect(limitCalled).toBe(true);
    });

    it("should handle empty history", async () => {
      const mockStats = {
        total_open_interest: "5000000000",
        net_lp_pos: "1500000",
        lp_sum_abs: "2000000",
        lp_max_abs: "500000",
      };

      mockSupabase.from.mockImplementation((table: string) => {
        if (table === "market_stats") {
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => ({
                single: vi.fn().mockResolvedValue({ data: mockStats, error: null }),
              })),
            })),
          };
        } else if (table === "oi_history") {
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => ({
                order: vi.fn(() => ({
                  limit: vi.fn().mockResolvedValue({ data: [], error: null }),
                })),
              })),
            })),
          };
        }
        return mockSupabase;
      });

      const app = openInterestRoutes();
      const res = await app.request("/open-interest/11111111111111111111111111111111");

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.history).toHaveLength(0);
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
        it(`returns 404 for blocked slab ${addr.slice(0, 8)}... on /open-interest`, async () => {
          const app = openInterestRoutes();
          const res = await app.request(`/open-interest/${addr}`);
          expect(res.status).toBe(404);
          const data = await res.json();
          expect(data).toEqual({ error: "Market not found" });
          // DB should never be queried for blocked slabs
          expect(mockSupabase.from).not.toHaveBeenCalled();
        });
      }

      it("allows valid non-blocked slabs through to DB layer", async () => {
        mockSupabase.from.mockImplementation((table: string) => {
          if (table === "market_stats") {
            return {
              select: vi.fn(() => ({
                eq: vi.fn(() => ({
                  single: vi.fn().mockResolvedValue({
                    data: {
                      total_open_interest: "1000",
                      net_lp_pos: "100",
                      lp_sum_abs: "200",
                      lp_max_abs: "50",
                    },
                    error: null,
                  }),
                })),
              })),
            };
          } else if (table === "oi_history") {
            return {
              select: vi.fn(() => ({
                eq: vi.fn(() => ({
                  order: vi.fn(() => ({
                    limit: vi.fn().mockResolvedValue({ data: [], error: null }),
                  })),
                })),
              })),
            };
          }
          return mockSupabase;
        });

        const app = openInterestRoutes();
        const res = await app.request("/open-interest/11111111111111111111111111111111");
        expect(res.status).toBe(200);
      });
    });

    describe("GH#1458: phantom OI history filter — pre-migration values (9.87e+34) excluded", () => {
      // usdEkK5G (11111111...) and MOLTBOT (22222222...) oi_history contained rows
      // with total_oi = 9.87e+34 from uninitialized on-chain state. These must be
      // stripped before the chart data is returned.

      const PHANTOM_OI = "987000000000000000000000000000000000"; // ~9.87e+35
      const VALID_OI_1 = "5000000000";
      const VALID_OI_2 = "4800000000";

      function mockSupabaseWithHistory(history: Array<{ timestamp: string; total_oi: string; net_lp_pos: string }>) {
        return (table: string) => {
          if (table === "market_stats") {
            return {
              select: vi.fn(() => ({
                eq: vi.fn(() => ({
                  single: vi.fn().mockResolvedValue({
                    data: {
                      total_open_interest: VALID_OI_1,
                      net_lp_pos: "1500000",
                      lp_sum_abs: "2000000",
                      lp_max_abs: "500000",
                    },
                    error: null,
                  }),
                })),
              })),
            };
          } else if (table === "oi_history") {
            return {
              select: vi.fn(() => ({
                eq: vi.fn(() => ({
                  order: vi.fn(() => ({
                    limit: vi.fn().mockResolvedValue({ data: history, error: null }),
                  })),
                })),
              })),
            };
          }
          return mockSupabase;
        };
      }

      it("strips phantom history records (total_oi >= 1e18) from response", async () => {
        const history = [
          { timestamp: "2026-01-01T00:00:00Z", total_oi: PHANTOM_OI, net_lp_pos: "0" },         // phantom — must be excluded
          { timestamp: "2026-01-02T00:00:00Z", total_oi: VALID_OI_1, net_lp_pos: "1500000" },   // real — included
          { timestamp: "2026-01-03T00:00:00Z", total_oi: VALID_OI_2, net_lp_pos: "1400000" },   // real — included
        ];

        mockSupabase.from.mockImplementation(mockSupabaseWithHistory(history));

        const app = openInterestRoutes();
        const res = await app.request("/open-interest/11111111111111111111111111111111");

        expect(res.status).toBe(200);
        const data = await res.json();
        // Only 2 valid records; phantom stripped
        expect(data.history).toHaveLength(2);
        expect(data.history.map((h: { totalOi: string }) => h.totalOi)).not.toContain(PHANTOM_OI);
        expect(data.history[0].totalOi).toBe(VALID_OI_1);
        expect(data.history[1].totalOi).toBe(VALID_OI_2);
      });

      it("strips records with phantom net_lp_pos (>= 1e18)", async () => {
        const PHANTOM_LP = "12345678901234567890"; // > 1e18
        const history = [
          { timestamp: "2026-01-01T00:00:00Z", total_oi: VALID_OI_1, net_lp_pos: PHANTOM_LP }, // phantom LP — excluded
          { timestamp: "2026-01-02T00:00:00Z", total_oi: VALID_OI_2, net_lp_pos: "1500000" },  // real — included
        ];

        mockSupabase.from.mockImplementation(mockSupabaseWithHistory(history));

        const app = openInterestRoutes();
        const res = await app.request("/open-interest/11111111111111111111111111111111");

        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.history).toHaveLength(1);
        expect(data.history[0].totalOi).toBe(VALID_OI_2);
      });

      it("returns all records when no phantom values present", async () => {
        const history = [
          { timestamp: "2026-01-01T00:00:00Z", total_oi: VALID_OI_1, net_lp_pos: "1500000" },
          { timestamp: "2026-01-02T00:00:00Z", total_oi: VALID_OI_2, net_lp_pos: "1400000" },
        ];

        mockSupabase.from.mockImplementation(mockSupabaseWithHistory(history));

        const app = openInterestRoutes();
        const res = await app.request("/open-interest/11111111111111111111111111111111");

        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.history).toHaveLength(2);
      });

      it("returns empty history if all records are phantom", async () => {
        const history = [
          { timestamp: "2026-01-01T00:00:00Z", total_oi: PHANTOM_OI, net_lp_pos: "0" },
          { timestamp: "2026-01-02T00:00:00Z", total_oi: PHANTOM_OI, net_lp_pos: "0" },
        ];

        mockSupabase.from.mockImplementation(mockSupabaseWithHistory(history));

        const app = openInterestRoutes();
        const res = await app.request("/open-interest/11111111111111111111111111111111");

        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.history).toHaveLength(0);
        // Current OI data (from market_stats) should still be valid
        expect(data.totalOpenInterest).toBe(VALID_OI_1);
      });

      it("GH#1458 regression: handles the specific 9.87e+34 value reported in the bug", async () => {
        // Exact phantom value observed on usdEkK5G and MOLTBOT markets
        const PHANTOM_9_87E34 = "98700000000000000000000000000000000"; // 9.87e+34
        const history = [
          { timestamp: "2026-01-01T00:00:00Z", total_oi: PHANTOM_9_87E34, net_lp_pos: "0" },
          { timestamp: "2026-01-02T00:00:00Z", total_oi: VALID_OI_1, net_lp_pos: "1500000" },
        ];

        mockSupabase.from.mockImplementation(mockSupabaseWithHistory(history));

        const app = openInterestRoutes();
        const res = await app.request("/open-interest/11111111111111111111111111111111");

        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.history).toHaveLength(1);
        expect(data.history[0].totalOi).toBe(VALID_OI_1);
      });
    });
  });
});
