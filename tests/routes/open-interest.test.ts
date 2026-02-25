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
  });
});
