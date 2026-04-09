import { describe, it, expect, vi, beforeEach } from "vitest";
import { statsRoutes } from "../../src/routes/stats.js";
import { clearDbCache } from "../../src/middleware/db-cache-fallback.js";

// Mock @percolator/shared
vi.mock("@percolator/shared", () => ({
  getSupabase: vi.fn(),
  getConnection: vi.fn(),
  getNetwork: vi.fn(() => "devnet" as const),
  truncateErrorMessage: vi.fn((msg: unknown, _limit?: number) => String(msg ?? "")),
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

/**
 * Create a chainable Supabase query-builder mock that resolves to `resolvedValue`.
 * All filter methods (eq, gte, not, etc.) return the same chainable object so
 * the test doesn't need to know the exact chain the production code uses.
 */
function chainable(resolvedValue: any): any {
  const obj: any = {};
  const methods = ["select", "eq", "neq", "gte", "lte", "not", "order", "limit", "single", "maybeSingle", "head"];
  for (const m of methods) {
    obj[m] = vi.fn(() => obj);
  }
  // Make the object thenable so awaiting it returns resolvedValue
  obj.then = (resolve: any) => Promise.resolve(resolvedValue).then(resolve);
  obj.catch = (reject: any) => Promise.resolve(resolvedValue).catch(reject);
  obj.finally = (fn: any) => Promise.resolve(resolvedValue).finally(fn);
  return obj;
}

describe("stats routes", () => {
  let mockSupabase: any;

  beforeEach(() => {
    vi.clearAllMocks();
    clearDbCache();

    // Create a chainable mock that supports the full Supabase query builder pattern.
    // All filter/modifier methods return `mockSupabase` to allow arbitrary chaining.
    mockSupabase = {
      from: vi.fn(() => mockSupabase),
      select: vi.fn(() => mockSupabase),
      eq: vi.fn(() => mockSupabase),
      gte: vi.fn(() => mockSupabase),
    };

    vi.mocked(getSupabase).mockReturnValue(mockSupabase);
  });

  describe("GET /stats", () => {
    it("should return aggregated platform stats", async () => {
      mockSupabase.from.mockImplementation((table: string) => {
        if (table === "markets") {
          return chainable({ count: 10, error: null });
        } else if (table === "markets_with_stats") {
          return chainable({
              data: [
                { volume_24h: "1000000000", total_open_interest: "5000000000" },
                { volume_24h: "500000000", total_open_interest: "3000000000" },
              ],
              error: null,
            });
        } else if (table === "trades") {
          return chainable({ count: 1250, error: null });
        }
        return mockSupabase;
      });

      // Mock for deployers query (second call to markets table)
      let marketsCalls = 0;
      mockSupabase.from.mockImplementation((table: string) => {
        if (table === "markets") {
          marketsCalls++;
          if (marketsCalls === 1) {
            return chainable({ count: 10, error: null });
          } else {
            return chainable({
              data: [
                { deployer: "Deployer11111111111111111111111111" },
                { deployer: "Deployer22222222222222222222222222" },
                { deployer: "Deployer11111111111111111111111111" }, // Duplicate
              ],
              error: null,
            });
          }
        } else if (table === "markets_with_stats") {
          return chainable({
              data: [
                { volume_24h: "1000000000", total_open_interest: "5000000000" },
                { volume_24h: "500000000", total_open_interest: "3000000000" },
              ],
              error: null,
            });
        } else if (table === "trades") {
          return chainable({ count: 1250, error: null });
        }
        return mockSupabase;
      });

      const app = statsRoutes();
      const res = await app.request("/stats");

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.totalMarkets).toBe(10);
      expect(data.volume24h).toBe("1500000000");
      expect(data.totalOpenInterest).toBe("8000000000");
      expect(data.uniqueDeployers).toBe(2);
      expect(data.trades24h).toBe(1250);
    });

    it("should handle BigInt aggregation correctly", async () => {
      mockSupabase.from.mockImplementation((table: string) => {
        if (table === "markets") {
          return chainable({ count: 3, error: null });
        } else if (table === "markets_with_stats") {
          return chainable({
              data: [
                { volume_24h: "999999999999999999", total_open_interest: "999999999999999999" },
                { volume_24h: "1", total_open_interest: "1" },
              ],
              error: null,
            });
        } else if (table === "trades") {
          return chainable({ count: 0, error: null });
        }
        return mockSupabase;
      });

      let marketsCalls = 0;
      mockSupabase.from.mockImplementation((table: string) => {
        if (table === "markets") {
          marketsCalls++;
          if (marketsCalls === 1) {
            return chainable({ count: 3, error: null });
          } else {
            return chainable({
              data: [{ deployer: "Deployer11111111111111111111111111" }],
              error: null,
            });
          }
        } else if (table === "markets_with_stats") {
          return chainable({
              data: [
                { volume_24h: "999999999999999999", total_open_interest: "999999999999999999" },
                { volume_24h: "1", total_open_interest: "1" },
              ],
              error: null,
            });
        } else if (table === "trades") {
          return chainable({ count: 0, error: null });
        }
        return mockSupabase;
      });

      const app = statsRoutes();
      const res = await app.request("/stats");

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.volume24h).toBe("1000000000000000000");
      expect(data.totalOpenInterest).toBe("1000000000000000000");
    });

    it("should handle zero values", async () => {
      mockSupabase.from.mockImplementation((table: string) => {
        if (table === "markets") {
          return chainable({ count: 0, error: null });
        } else if (table === "markets_with_stats") {
          return chainable({
              data: [],
              error: null,
            });
        } else if (table === "trades") {
          return chainable({ count: 0, error: null });
        }
        return mockSupabase;
      });

      let marketsCalls = 0;
      mockSupabase.from.mockImplementation((table: string) => {
        if (table === "markets") {
          marketsCalls++;
          if (marketsCalls === 1) {
            return chainable({ count: 0, error: null });
          } else {
            return chainable({
              data: [],
              error: null,
            });
          }
        } else if (table === "markets_with_stats") {
          return chainable({
              data: [],
              error: null,
            });
        } else if (table === "trades") {
          return chainable({ count: 0, error: null });
        }
        return mockSupabase;
      });

      const app = statsRoutes();
      const res = await app.request("/stats");

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.totalMarkets).toBe(0);
      expect(data.volume24h).toBe("0");
      expect(data.totalOpenInterest).toBe("0");
      expect(data.uniqueDeployers).toBe(0);
      expect(data.trades24h).toBe(0);
    });

    it("should handle null values in stats", async () => {
      mockSupabase.from.mockImplementation((table: string) => {
        if (table === "markets") {
          return chainable({ count: 2, error: null });
        } else if (table === "markets_with_stats") {
          return chainable({
              data: [
                { volume_24h: null, total_open_interest: null },
                { volume_24h: "1000000000", total_open_interest: "5000000000" },
              ],
              error: null,
            });
        } else if (table === "trades") {
          return chainable({ count: 100, error: null });
        }
        return mockSupabase;
      });

      let marketsCalls = 0;
      mockSupabase.from.mockImplementation((table: string) => {
        if (table === "markets") {
          marketsCalls++;
          if (marketsCalls === 1) {
            return chainable({ count: 2, error: null });
          } else {
            return chainable({
              data: [{ deployer: "Deployer11111111111111111111111111" }],
              error: null,
            });
          }
        } else if (table === "markets_with_stats") {
          return chainable({
              data: [
                { volume_24h: null, total_open_interest: null },
                { volume_24h: "1000000000", total_open_interest: "5000000000" },
              ],
              error: null,
            });
        } else if (table === "trades") {
          return chainable({ count: 100, error: null });
        }
        return mockSupabase;
      });

      const app = statsRoutes();
      const res = await app.request("/stats");

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.volume24h).toBe("1000000000");
      expect(data.totalOpenInterest).toBe("5000000000");
    });

    it("should return response with all expected shape fields", async () => {
      // Explicitly verify the response contract includes all required fields.
      // (This first mockImplementation is immediately overridden below.)

      // Override with proper multi-call behavior
      let marketsCalls = 0;
      mockSupabase.from.mockImplementation((table: string) => {
        if (table === "markets") {
          marketsCalls++;
          if (marketsCalls === 1) {
            return chainable({ count: 5, error: null });
          }
          return chainable({ data: [{ deployer: "D1" }], error: null });
        } else if (table === "markets_with_stats") {
          return chainable({
              data: [{ volume_24h: "100000", total_open_interest: "500000" }],
              error: null,
            });
        } else if (table === "trades") {
          return chainable({ count: 10, error: null });
        }
        return mockSupabase;
      });

      const app = statsRoutes();
      const res = await app.request("/stats");

      expect(res.status).toBe(200);
      const data = await res.json();

      // All required top-level fields must be present
      expect(data).toHaveProperty("totalMarkets");
      expect(data).toHaveProperty("volume24h");          // "volume" field
      expect(data).toHaveProperty("totalOpenInterest");  // "open_interest" field
      expect(data).toHaveProperty("uniqueDeployers");
      expect(data).toHaveProperty("trades24h");

      // Types should be correct
      expect(typeof data.totalMarkets).toBe("number");
      expect(typeof data.volume24h).toBe("string");          // BigInt serialized as string
      expect(typeof data.totalOpenInterest).toBe("string");  // BigInt serialized as string
      expect(typeof data.uniqueDeployers).toBe("number");
      expect(typeof data.trades24h).toBe("number");
    });

    it("should handle database errors with 503 (no stale cache)", async () => {
      mockSupabase.from.mockImplementation((_table: string) => {
        return chainable({ count: null, data: null, error: new Error("Database error") });
      });

      const app = statsRoutes();
      const res = await app.request("/stats");

      // withDbCacheFallback returns 503 when DB fails and no stale cache is available
      expect(res.status).toBe(503);
      const data = await res.json();
      expect(data.error).toBe("Database temporarily unavailable");
    });
  });
});
