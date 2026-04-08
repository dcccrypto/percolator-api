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

// Re-import the module fresh per test so the in-memory cache is empty.
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
