import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { healthRoutes, __resetHealthCache } from "../../src/routes/health.js";

// Mock ws module
vi.mock("../../src/routes/ws.js", () => ({
  getWebSocketMetrics: vi.fn(() => ({
    totalConnections: 0,
    limits: { maxGlobalConnections: 1000 },
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

  describe("RPC staleness detection (BUG-109)", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("detects a stale/lagging RPC node whose slot stops advancing", async () => {
      vi.useFakeTimers();
      mockConnection.getSlot.mockResolvedValue(100);
      mockSupabase.select.mockResolvedValue({ count: 5, error: null });

      const app = healthRoutes();

      // First check establishes the baseline reading — no prior reading
      // exists yet, so this is healthy regardless of the slot value.
      const res1 = await app.request("/health");
      const data1 = await res1.json();
      expect(data1.checks.rpc).toBe(true);

      // Advance past both the 5s health-response cache and the 30s
      // staleness threshold, with the node still returning the SAME slot —
      // a genuinely live node would have advanced by many slots by now.
      await vi.advanceTimersByTimeAsync(35_000);

      const res2 = await app.request("/health");
      const data2 = await res2.json();
      expect(data2.checks.rpc).toBe(false);
      expect(data2.status).not.toBe("ok");
    });

    it("does not flag staleness when the slot has genuinely advanced", async () => {
      vi.useFakeTimers();
      mockConnection.getSlot.mockResolvedValueOnce(100).mockResolvedValueOnce(200);
      mockSupabase.select.mockResolvedValue({ count: 5, error: null });

      const app = healthRoutes();
      await app.request("/health");
      await vi.advanceTimersByTimeAsync(35_000);
      const res2 = await app.request("/health");
      const data2 = await res2.json();
      expect(data2.checks.rpc).toBe(true);
    });

    it("does not flag staleness on rapid successive checks within the threshold window", async () => {
      vi.useFakeTimers();
      mockConnection.getSlot.mockResolvedValue(100);
      mockSupabase.select.mockResolvedValue({ count: 5, error: null });

      const app = healthRoutes();
      await app.request("/health");
      // Past the 5s response cache, but well under the 30s staleness threshold.
      await vi.advanceTimersByTimeAsync(10_000);
      const res2 = await app.request("/health");
      const data2 = await res2.json();
      expect(data2.checks.rpc).toBe(true);
    });
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

    const app = healthRoutes();
    const res = await app.request("/health");

    expect(res.status).toBe(503);
    const data = await res.json();
    expect(data.status).toBe("down");
    expect(data.checks.rpc).toBe(false);
    expect(data.checks.db).toBe(false);
    expect(data.checks.ws).toBe(false);
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
