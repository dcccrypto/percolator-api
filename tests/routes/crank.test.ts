import { describe, it, expect, vi, beforeEach } from "vitest";
import { crankStatusRoutes } from "../../src/routes/crank.js";

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

describe("crank routes", () => {
  let mockSupabase: any;

  beforeEach(() => {
    vi.clearAllMocks();

    mockSupabase = {
      from: vi.fn(() => mockSupabase),
      select: vi.fn(() => mockSupabase),
    };

    vi.mocked(getSupabase).mockReturnValue(mockSupabase);
  });

  describe("GET /crank/status", () => {
    it("should return market crank data", async () => {
      const mockMarkets = [
        {
          slab_address: "11111111111111111111111111111111",
          last_crank_slot: 123456789,
          updated_at: "2025-01-01T00:00:00Z",
        },
        {
          slab_address: "22222222222222222222222222222222",
          last_crank_slot: 123456790,
          updated_at: "2025-01-01T00:01:00Z",
        },
      ];

      mockSupabase.select.mockResolvedValue({ data: mockMarkets, error: null });

      const app = crankStatusRoutes();
      const res = await app.request("/crank/status");

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.markets).toHaveLength(2);
      expect(data.markets[0].slab_address).toBe("11111111111111111111111111111111");
      expect(data.markets[0].last_crank_slot).toBe(123456789);
    });

    it("should handle empty markets list", async () => {
      mockSupabase.select.mockResolvedValue({ data: [], error: null });

      const app = crankStatusRoutes();
      const res = await app.request("/crank/status");

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.markets).toHaveLength(0);
    });

    it("should handle null values", async () => {
      const mockMarkets = [
        {
          slab_address: "11111111111111111111111111111111",
          last_crank_slot: null,
          updated_at: null,
        },
      ];

      mockSupabase.select.mockResolvedValue({ data: mockMarkets, error: null });

      const app = crankStatusRoutes();
      const res = await app.request("/crank/status");

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.markets).toHaveLength(1);
      expect(data.markets[0].last_crank_slot).toBeNull();
      expect(data.markets[0].updated_at).toBeNull();
    });

    it("should handle database errors", async () => {
      mockSupabase.select.mockResolvedValue({ 
        data: null, 
        error: new Error("Database error") 
      });

      const app = crankStatusRoutes();
      const res = await app.request("/crank/status");

      expect(res.status).toBe(500);
      const data = await res.json();
      expect(data.error).toBe("Failed to fetch crank status");
    });

    it("should return all market stats fields", async () => {
      const mockMarkets = [
        {
          slab_address: "11111111111111111111111111111111",
          last_crank_slot: 123456789,
          updated_at: "2025-01-01T00:00:00Z",
        },
      ];

      mockSupabase.select.mockResolvedValue({ data: mockMarkets, error: null });

      const app = crankStatusRoutes();
      const res = await app.request("/crank/status");

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.markets[0]).toHaveProperty("slab_address");
      expect(data.markets[0]).toHaveProperty("last_crank_slot");
      expect(data.markets[0]).toHaveProperty("updated_at");
    });

    it("should handle large slot numbers", async () => {
      const mockMarkets = [
        {
          slab_address: "11111111111111111111111111111111",
          last_crank_slot: 999999999999,
          updated_at: "2025-01-01T00:00:00Z",
        },
      ];

      mockSupabase.select.mockResolvedValue({ data: mockMarkets, error: null });

      const app = crankStatusRoutes();
      const res = await app.request("/crank/status");

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.markets[0].last_crank_slot).toBe(999999999999);
    });

    it("should preserve order from database", async () => {
      const mockMarkets = [
        {
          slab_address: "33333333333333333333333333333333",
          last_crank_slot: 3,
          updated_at: "2025-01-01T02:00:00Z",
        },
        {
          slab_address: "11111111111111111111111111111111",
          last_crank_slot: 1,
          updated_at: "2025-01-01T00:00:00Z",
        },
        {
          slab_address: "22222222222222222222222222222222",
          last_crank_slot: 2,
          updated_at: "2025-01-01T01:00:00Z",
        },
      ];

      mockSupabase.select.mockResolvedValue({ data: mockMarkets, error: null });

      const app = crankStatusRoutes();
      const res = await app.request("/crank/status");

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.markets).toHaveLength(3);
      expect(data.markets[0].slab_address).toBe("33333333333333333333333333333333");
      expect(data.markets[1].slab_address).toBe("11111111111111111111111111111111");
      expect(data.markets[2].slab_address).toBe("22222222222222222222222222222222");
    });
  });
});
