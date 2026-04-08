import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

// Mock @percolatorct/sdk so we control resolvePrice
vi.mock("@percolatorct/sdk", () => ({
  resolvePrice: vi.fn(),
}));

// Mock @percolator/shared (only createLogger is used by oracle-router)
vi.mock("@percolator/shared", () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

// Mock PublicKey to accept any non-empty string so tests don't need real base58
vi.mock("@solana/web3.js", () => ({
  PublicKey: class {
    constructor(s: string) {
      if (!s) throw new Error("invalid");
    }
  },
}));

const FRESH_RESULT = {
  mint: "TEST_MINT",
  sources: [{ name: "pyth", price: 100 }],
  primary: "pyth",
} as any;

// Re-import the module fresh per test so the in-memory cache and inflight map are empty.
async function loadApp() {
  vi.resetModules();
  const sdk = await import("@percolatorct/sdk");
  const { oracleRouterRoutes } = await import("../../src/routes/oracle-router.js");
  const app = new Hono();
  app.route("/", oracleRouterRoutes());
  return { app, resolvePrice: vi.mocked(sdk.resolvePrice) };
}

function makeRequest(mint: string) {
  return new Request(`http://localhost/oracle/resolve/${mint}`);
}

describe("oracle-router in-flight request dedup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("coalesces N concurrent requests for the same mint into a single resolvePrice call", async () => {
    const { app, resolvePrice } = await loadApp();

    // resolvePrice is slow — gives the test time to fire all 10 requests
    // before the first call settles.
    let release: (v: any) => void = () => {};
    const slow = new Promise((r) => {
      release = r;
    });
    resolvePrice.mockImplementation(() => slow as any);

    // Fire 10 concurrent requests for the same uncached mint.
    const inflight = Array.from({ length: 10 }, () => app.request(makeRequest("TEST_MINT")));

    // Let microtasks settle so all 10 handlers reach the inflight check.
    await new Promise((r) => setImmediate(r));

    // Only ONE upstream call should have been made.
    expect(resolvePrice).toHaveBeenCalledTimes(1);

    // Release the upstream and let everything settle.
    release(FRESH_RESULT);
    const responses = await Promise.all(inflight);

    // All 10 should succeed with the same data.
    for (const res of responses) {
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({ ...FRESH_RESULT, cached: false });
    }

    // Still only one upstream call after settlement.
    expect(resolvePrice).toHaveBeenCalledTimes(1);
  });

  it("does not coalesce requests for different mints", async () => {
    const { app, resolvePrice } = await loadApp();
    resolvePrice.mockResolvedValue(FRESH_RESULT);

    await Promise.all([
      app.request(makeRequest("MINT_A")),
      app.request(makeRequest("MINT_B")),
      app.request(makeRequest("MINT_C")),
    ]);

    expect(resolvePrice).toHaveBeenCalledTimes(3);
  });

  it("clears the in-flight entry after success so a later request hits cache (no second upstream call)", async () => {
    const { app, resolvePrice } = await loadApp();
    resolvePrice.mockResolvedValueOnce(FRESH_RESULT);

    const first = await app.request(makeRequest("TEST_MINT"));
    expect(first.status).toBe(200);
    expect(resolvePrice).toHaveBeenCalledTimes(1);

    // Subsequent request should hit the cache, not the upstream.
    const second = await app.request(makeRequest("TEST_MINT"));
    expect(second.status).toBe(200);
    const body = await second.json();
    expect(body.cached).toBe(true);
    expect(resolvePrice).toHaveBeenCalledTimes(1);
  });

  it("clears the in-flight entry after failure so a retry triggers a fresh upstream call", async () => {
    const { app, resolvePrice } = await loadApp();
    resolvePrice
      .mockRejectedValueOnce(new Error("oracle down"))
      .mockResolvedValueOnce(FRESH_RESULT);

    const first = await app.request(makeRequest("TEST_MINT"));
    expect(first.status).toBe(500);
    expect(resolvePrice).toHaveBeenCalledTimes(1);

    // Retry should not be deduped against the failed promise — it should
    // trigger a new upstream call.
    const second = await app.request(makeRequest("TEST_MINT"));
    expect(second.status).toBe(200);
    expect(resolvePrice).toHaveBeenCalledTimes(2);
  });

  it("propagates upstream errors to all concurrent waiters", async () => {
    const { app, resolvePrice } = await loadApp();

    let reject: (e: any) => void = () => {};
    const slow = new Promise((_, rej) => {
      reject = rej;
    });
    resolvePrice.mockImplementation(() => slow as any);

    const inflight = Array.from({ length: 5 }, () => app.request(makeRequest("TEST_MINT")));
    await new Promise((r) => setImmediate(r));
    expect(resolvePrice).toHaveBeenCalledTimes(1);

    reject(new Error("oracle down"));
    const responses = await Promise.all(inflight);
    for (const res of responses) {
      expect(res.status).toBe(500);
    }
    expect(resolvePrice).toHaveBeenCalledTimes(1);
  });
});

describe("oracle-router stale-while-error fallback", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("returns fresh data on a successful resolve", async () => {
    const { app, resolvePrice } = await loadApp();
    resolvePrice.mockResolvedValueOnce(FRESH_RESULT);

    const res = await app.request(makeRequest("TEST_MINT"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ...FRESH_RESULT, cached: false });
    expect(body.stale).toBeUndefined();
  });

  it("returns 500 when resolvePrice fails and the cache is empty", async () => {
    const { app, resolvePrice } = await loadApp();
    resolvePrice.mockRejectedValueOnce(new Error("oracle down"));

    const res = await app.request(makeRequest("TEST_MINT"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Failed to resolve oracle sources");
  });

  it("falls back to stale cached data when resolvePrice fails within the stale window", async () => {
    const { app, resolvePrice } = await loadApp();

    // First call: success — populates the cache.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));
    resolvePrice.mockResolvedValueOnce(FRESH_RESULT);
    const ok = await app.request(makeRequest("TEST_MINT"));
    expect(ok.status).toBe(200);

    // Advance past the 5min TTL but stay within the 15min stale window.
    vi.setSystemTime(new Date("2025-01-01T00:10:00Z"));
    resolvePrice.mockRejectedValueOnce(new Error("oracle down"));

    const res = await app.request(makeRequest("TEST_MINT"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ...FRESH_RESULT, cached: true, stale: true });
  });

  it("returns 500 when the stale entry is older than MAX_STALE_AGE_MS", async () => {
    const { app, resolvePrice } = await loadApp();

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));
    resolvePrice.mockResolvedValueOnce(FRESH_RESULT);
    const ok = await app.request(makeRequest("TEST_MINT"));
    expect(ok.status).toBe(200);

    // Advance well past TTL + MAX_STALE_AGE (5 + 15 = 20 minutes).
    vi.setSystemTime(new Date("2025-01-01T00:30:00Z"));
    resolvePrice.mockRejectedValueOnce(new Error("oracle down"));

    const res = await app.request(makeRequest("TEST_MINT"));
    expect(res.status).toBe(500);
  });

  it("prefers a fresh resolve over a stale cache entry", async () => {
    const { app, resolvePrice } = await loadApp();

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));
    resolvePrice.mockResolvedValueOnce(FRESH_RESULT);
    await app.request(makeRequest("TEST_MINT"));

    // Advance past TTL but the next resolve succeeds — should NOT mark stale.
    vi.setSystemTime(new Date("2025-01-01T00:10:00Z"));
    const NEW_RESULT = { ...FRESH_RESULT, sources: [{ name: "pyth", price: 200 }] };
    resolvePrice.mockResolvedValueOnce(NEW_RESULT);

    const res = await app.request(makeRequest("TEST_MINT"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ...NEW_RESULT, cached: false });
    expect(body.stale).toBeUndefined();
  });
});
