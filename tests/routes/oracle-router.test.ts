import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

// Mock @percolatorct/sdk so we control resolvePrice
vi.mock("@percolatorct/sdk", () => ({
  resolvePrice: vi.fn(),
}));

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
