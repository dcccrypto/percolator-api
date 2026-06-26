import { describe, it, expect, vi, beforeEach } from "vitest";
import { healthRoutes, __resetHealthCache } from "../../src/routes/health.js";

// Mock ws module
vi.mock("../../src/routes/ws.js", () => ({
  getWebSocketMetrics: vi.fn(() => ({
    totalConnections: 0,
    limits: { maxGlobalConnections: 1000 },
  })),
}));

// Mock the oracle-price broadcaster singleton — defaults to healthy so
// existing tests' "ok"/"degraded" expectations (written before this check
// existed) don't need touching beyond the "down" test below, which must
// fail every check including this one to keep asserting 503.
vi.mock("../../src/services/OraclePriceBroadcaster.js", () => ({
  getOraclePriceBroadcaster: vi.fn(() => ({ isHealthy: vi.fn(() => true) })),
}));

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

const { getConnection, getSupabase } = await import("@percolator/shared");
const { getWebSocketMetrics } = await import("../../src/routes/ws.js");
const { getOraclePriceBroadcaster } = await import("../../src/services/OraclePriceBroadcaster.js");

describe("health routes", () => {
  let mockConnection: any;
  let mockSupabase: any;

  beforeEach(() => {
    vi.clearAllMocks();
    __resetHealthCache();

    mockConnection = {
      getSlot: vi.fn(),
    };

    mockSupabase = {
      from: vi.fn(() => mockSupabase),
      select: vi.fn(() => mockSupabase),
    };

    vi.mocked(getConnection).mockReturnValue(mockConnection);
    vi.mocked(getSupabase).mockReturnValue(mockSupabase);
  });

  it("should return 200 with ok status when RPC and DB work", async () => {
    mockConnection.getSlot.mockResolvedValue(123456789);
    mockSupabase.select.mockResolvedValue({ count: 5, error: null });

    const app = healthRoutes();
    const res = await app.request("/health");

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe("ok");
    expect(data.checks.rpc).toBe(true);
    expect(data.checks.db).toBe(true);
    expect(data.checks.ws).toBe(true);
    expect(typeof data.uptime).toBe("number");
  });

  it("should return 200 with degraded status when RPC fails", async () => {
    mockConnection.getSlot.mockRejectedValue(new Error("RPC connection failed"));
    mockSupabase.select.mockResolvedValue({ count: 5, error: null });

    const app = healthRoutes();
    const res = await app.request("/health");

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe("degraded");
    expect(data.checks.rpc).toBe(false);
    expect(data.checks.db).toBe(true);
  });

  it("should return 200 with degraded status when DB fails", async () => {
    mockConnection.getSlot.mockResolvedValue(123456789);
    mockSupabase.select.mockRejectedValue(new Error("DB error"));

    const app = healthRoutes();
    const res = await app.request("/health");

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe("degraded");
    expect(data.checks.rpc).toBe(true);
    expect(data.checks.db).toBe(false);
  });

  it("should return 503 with down status when all checks fail", async () => {
    mockConnection.getSlot.mockRejectedValue(new Error("RPC error"));
    mockSupabase.select.mockRejectedValue(new Error("DB error"));
    vi.mocked(getWebSocketMetrics).mockImplementation(() => { throw new Error("WS unavailable"); });
    vi.mocked(getOraclePriceBroadcaster).mockReturnValue({ isHealthy: () => false } as any);

    const app = healthRoutes();
    const res = await app.request("/health");

    expect(res.status).toBe(503);
    const data = await res.json();
    expect(data.status).toBe("down");
    expect(data.checks.rpc).toBe(false);
    expect(data.checks.db).toBe(false);
    expect(data.checks.ws).toBe(false);
    expect(data.checks.priceBroadcaster).toBe(false);
  });

  describe("priceBroadcaster check (BUG-103)", () => {
    it("reports degraded (not down) when only the oracle-price broadcaster is unhealthy", async () => {
      mockConnection.getSlot.mockResolvedValue(123456789);
      mockSupabase.select.mockResolvedValue({ count: 5, error: null });
      vi.mocked(getOraclePriceBroadcaster).mockReturnValue({ isHealthy: () => false } as any);

      const app = healthRoutes();
      const res = await app.request("/health");

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.status).toBe("degraded");
      expect(data.checks.priceBroadcaster).toBe(false);
      expect(data.checks.rpc).toBe(true);
      expect(data.checks.db).toBe(true);
    });

    it("treats a thrown error from the broadcaster as unhealthy rather than crashing the health check", async () => {
      mockConnection.getSlot.mockResolvedValue(123456789);
      mockSupabase.select.mockResolvedValue({ count: 5, error: null });
      vi.mocked(getOraclePriceBroadcaster).mockImplementation(() => {
        throw new Error("broadcaster unavailable");
      });

      const app = healthRoutes();
      const res = await app.request("/health");

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.checks.priceBroadcaster).toBe(false);
    });
  });

  it("should include uptime in response", async () => {
    mockConnection.getSlot.mockResolvedValue(100);
    mockSupabase.select.mockResolvedValue({ count: 0, error: null });

    const app = healthRoutes();
    const res = await app.request("/health");

    const data = await res.json();
    expect(typeof data.uptime).toBe("number");
    expect(data.uptime).toBeGreaterThanOrEqual(0);
  });

  it("should not include service field (checks boolean values only)", async () => {
    mockConnection.getSlot.mockResolvedValue(123456789);
    mockSupabase.select.mockResolvedValue({ count: 0, error: null });

    const app = healthRoutes();
    const res = await app.request("/health");

    expect(res.status).toBe(200);
    const data = await res.json();
    // Implementation returns boolean checks, not string descriptions
    expect(data.checks.rpc).toBe(true);
    expect(data.checks.db).toBe(true);
    // No service field in current implementation
    expect(data.service).toBeUndefined();
  });
});
