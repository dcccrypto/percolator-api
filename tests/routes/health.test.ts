import { describe, it, expect, vi, beforeEach } from "vitest";
import { healthRoutes, __resetHealthCache } from "../../src/routes/health.js";

// Mock ws module
vi.mock("../../src/routes/ws.js", () => ({
  getWebSocketMetrics: vi.fn(() => ({
    totalConnections: 0,
    limits: { maxGlobalConnections: 1000 },
  })),
}));

// Mock shared store
vi.mock("../../src/middleware/shared-store.js", () => ({
  getSharedStore: vi.fn(() => ({
    ping: vi.fn().mockResolvedValue(true),
  })),
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
const { getSharedStore } = await import("../../src/middleware/shared-store.js");

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
    vi.mocked(getSharedStore).mockReturnValue({ ping: vi.fn().mockResolvedValue(false) } as any);

    const app = healthRoutes();
    const res = await app.request("/health");

    expect(res.status).toBe(503);
    const data = await res.json();
    expect(data.status).toBe("down");
    expect(data.checks.rpc).toBe(false);
    expect(data.checks.db).toBe(false);
    expect(data.checks.ws).toBe(false);
    expect(data.checks.sharedStore).toBe(false);
  });

  describe("shared store health check (BUG-111)", () => {
    it("flags sharedStore as unhealthy when ping() resolves false", async () => {
      mockConnection.getSlot.mockResolvedValue(100);
      mockSupabase.select.mockResolvedValue({ count: 5, error: null });
      vi.mocked(getSharedStore).mockReturnValue({ ping: vi.fn().mockResolvedValue(false) } as any);

      const app = healthRoutes();
      const res = await app.request("/health");
      const data = await res.json();
      expect(data.checks.sharedStore).toBe(false);
      expect(data.status).not.toBe("ok");
    });

    it("flags sharedStore as unhealthy when ping() throws", async () => {
      mockConnection.getSlot.mockResolvedValue(100);
      mockSupabase.select.mockResolvedValue({ count: 5, error: null });
      vi.mocked(getSharedStore).mockReturnValue({
        ping: vi.fn().mockRejectedValue(new Error("Redis unreachable")),
      } as any);

      const app = healthRoutes();
      const res = await app.request("/health");
      const data = await res.json();
      expect(data.checks.sharedStore).toBe(false);
    });

    it("reports sharedStore healthy when ping() resolves true", async () => {
      mockConnection.getSlot.mockResolvedValue(100);
      mockSupabase.select.mockResolvedValue({ count: 5, error: null });
      // A prior test in this file overrides the ws mock's implementation;
      // clearAllMocks() doesn't undo that, so restore an explicit healthy
      // value here rather than depending on test execution order.
      vi.mocked(getWebSocketMetrics).mockReturnValue({
        totalConnections: 0,
        limits: { maxGlobalConnections: 1000 },
      } as any);
      vi.mocked(getSharedStore).mockReturnValue({ ping: vi.fn().mockResolvedValue(true) } as any);

      const app = healthRoutes();
      const res = await app.request("/health");
      const data = await res.json();
      expect(data.checks.sharedStore).toBe(true);
      expect(data.status).toBe("ok");
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
