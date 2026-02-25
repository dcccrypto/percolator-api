import { describe, it, expect, vi, beforeEach } from "vitest";
import { priceRoutes } from "../../src/routes/prices.js";

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

describe("prices routes", () => {
  let mockSupabase: any;

  beforeEach(() => {
    vi.clearAllMocks();

    mockSupabase = {
      from: vi.fn(() => mockSupabase),
      select: vi.fn(() => mockSupabase),
      eq: vi.fn(() => mockSupabase),
      order: vi.fn(() => mockSupabase),
      limit: vi.fn(() => mockSupabase),
    };

    vi.mocked(getSupabase).mockReturnValue(mockSupabase);
  });

  describe("GET /prices/markets", () => {
    it("should return all market prices", async () => {
      const mockMarkets = [
        {
          slab_address: "11111111111111111111111111111111",
          last_price: 50000000000,
          mark_price: 50000000000,
          index_price: 50000000000,
          updated_at: "2025-01-01T00:00:00Z",
        },
        {
          slab_address: "22222222222222222222222222222222",
          last_price: 3000000000,
          mark_price: 3000000000,
          index_price: 3000000000,
          updated_at: "2025-01-01T00:00:00Z",
        },
      ];

      mockSupabase.select.mockResolvedValue({ data: mockMarkets, error: null });

      const app = priceRoutes();
      const res = await app.request("/prices/markets");

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.markets).toHaveLength(2);
      expect(data.markets[0].slab_address).toBe("11111111111111111111111111111111");
    });

    it("should handle database errors", async () => {
      mockSupabase.select.mockResolvedValue({ 
        data: null, 
        error: new Error("Database error") 
      });

      const app = priceRoutes();
      const res = await app.request("/prices/markets");

      expect(res.status).toBe(500);
      const data = await res.json();
      expect(data.error).toBe("Failed to fetch prices");
    });

    it("should handle empty markets list", async () => {
      mockSupabase.select.mockResolvedValue({ data: [], error: null });

      const app = priceRoutes();
      const res = await app.request("/prices/markets");

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.markets).toHaveLength(0);
    });
  });

  describe("GET /prices/:slab", () => {
    it("should return price history for a market", async () => {
      const mockPrices = [
        {
          slab_address: "11111111111111111111111111111111",
          price_e6: 50000000000,
          timestamp: "2025-01-01T02:00:00Z",
        },
        {
          slab_address: "11111111111111111111111111111111",
          price_e6: 50100000000,
          timestamp: "2025-01-01T01:00:00Z",
        },
      ];

      mockSupabase.limit.mockResolvedValue({ data: mockPrices, error: null });

      const app = priceRoutes();
      const res = await app.request("/prices/11111111111111111111111111111111");

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.prices).toHaveLength(2);
      expect(mockSupabase.order).toHaveBeenCalledWith("timestamp", { ascending: false });
      expect(mockSupabase.limit).toHaveBeenCalledWith(100);
    });

    it("should return 400 for invalid slab", async () => {
      const app = priceRoutes();
      const res = await app.request("/prices/invalid-slab");

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toBe("Invalid slab address");
    });

    it("should handle database errors", async () => {
      mockSupabase.limit.mockResolvedValue({ 
        data: null, 
        error: new Error("Database error") 
      });

      const app = priceRoutes();
      const res = await app.request("/prices/11111111111111111111111111111111");

      expect(res.status).toBe(500);
      const data = await res.json();
      expect(data.error).toBe("Failed to fetch price history");
    });

    it("should handle empty price history", async () => {
      mockSupabase.limit.mockResolvedValue({ data: [], error: null });

      const app = priceRoutes();
      const res = await app.request("/prices/11111111111111111111111111111111");

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.prices).toHaveLength(0);
    });
  });
});
