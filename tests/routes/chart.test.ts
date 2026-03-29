import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import { chartRoutes } from "../../src/routes/chart.js";

// ── Mocks ──────────────────────────────────────────────────────────────────
vi.mock("@percolator/shared", () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// ── Helpers ────────────────────────────────────────────────────────────────
// Valid Solana PublicKey (SOL mint)
const VALID_MINT = "So11111111111111111111111111111111111111112";
const INVALID_MINT = "not-a-pubkey";

const MOCK_POOL_RES = {
  data: [{ id: "solana_PoolAddress1111111111111111111111111111" }],
};

// GeckoTerminal OHLCV response (3 candles)
const MOCK_OHLCV_RES = {
  data: {
    attributes: {
      ohlcv_list: [
        [1700000000, 100, 110, 90, 105, 5000],
        [1700003600, 105, 115, 100, 112, 6000],
        [1700007200, 112, 120, 108, 118, 7000],
      ],
    },
  },
};

function makeApp() {
  return chartRoutes();
}

function makeJsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ── Tests ──────────────────────────────────────────────────────────────────
describe("GET /chart/:mint", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it("returns 400 for invalid mint address", async () => {
    const app = makeApp();
    const res = await app.request(
      new Request(`http://localhost/chart/${INVALID_MINT}`)
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("Invalid mint");
  });

  it("returns empty candles when no pool found", async () => {
    // Pools endpoint returns empty list
    mockFetch.mockResolvedValueOnce(
      makeJsonRes({ data: [] })
    );

    const app = makeApp();
    const res = await app.request(
      new Request(`http://localhost/chart/${VALID_MINT}`)
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.candles).toEqual([]);
    expect(body.poolAddress).toBeNull();
    expect(body.cached).toBe(false);
  });

  it("returns empty candles when pool fetch fails (non-ok response)", async () => {
    mockFetch.mockResolvedValueOnce(new Response("", { status: 503 }));

    const app = makeApp();
    const res = await app.request(
      new Request(`http://localhost/chart/${VALID_MINT}`)
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.candles).toEqual([]);
    expect(body.poolAddress).toBeNull();
  });

  it("returns OHLCV candles on success", async () => {
    mockFetch
      .mockResolvedValueOnce(makeJsonRes(MOCK_POOL_RES))
      .mockResolvedValueOnce(makeJsonRes(MOCK_OHLCV_RES));

    const app = makeApp();
    const res = await app.request(
      new Request(`http://localhost/chart/${VALID_MINT}?timeframe=hour&limit=3`)
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.candles).toHaveLength(3);
    expect(body.poolAddress).toBe("PoolAddress1111111111111111111111111111");
    expect(body.cached).toBe(false);
    // Verify candle shape
    const c = body.candles[0];
    expect(c).toHaveProperty("timestamp");
    expect(c).toHaveProperty("open");
    expect(c).toHaveProperty("high");
    expect(c).toHaveProperty("low");
    expect(c).toHaveProperty("close");
    expect(c).toHaveProperty("volume");
    // Timestamps converted to ms
    expect(c.timestamp).toBe(1700000000 * 1000);
  });

  it("sets Cache-Control header on successful response", async () => {
    mockFetch
      .mockResolvedValueOnce(makeJsonRes(MOCK_POOL_RES))
      .mockResolvedValueOnce(makeJsonRes(MOCK_OHLCV_RES));

    const app = makeApp();
    const res = await app.request(
      new Request(`http://localhost/chart/${VALID_MINT}?timeframe=hour&limit=3&_nocache=a`)
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toContain("max-age=60");
  });

  it("filters out zero-close candles", async () => {
    const ohlcvWithZero = {
      data: {
        attributes: {
          ohlcv_list: [
            [1700000000, 100, 110, 90, 105, 5000],
            [1700003600, 0, 0, 0, 0, 0], // zero-close — should be filtered
          ],
        },
      },
    };
    mockFetch
      .mockResolvedValueOnce(makeJsonRes(MOCK_POOL_RES))
      .mockResolvedValueOnce(makeJsonRes(ohlcvWithZero));

    const app = makeApp();
    const res = await app.request(
      new Request(`http://localhost/chart/${VALID_MINT}?timeframe=hour&limit=5&_nocache=b`)
    );
    const body = await res.json();
    expect(body.candles).toHaveLength(1);
    expect(body.candles[0].close).toBe(105);
  });

  it("respects limit cap of 500", async () => {
    mockFetch
      .mockResolvedValueOnce(makeJsonRes(MOCK_POOL_RES))
      .mockResolvedValueOnce(makeJsonRes(MOCK_OHLCV_RES));

    const app = makeApp();
    await app.request(
      new Request(`http://localhost/chart/${VALID_MINT}?limit=9999&_nocache=c`)
    );
    // Second fetch (OHLCV) should have limit=500 in URL
    const ohlcvUrl = mockFetch.mock.calls[1]?.[0] as string;
    expect(ohlcvUrl).toContain("limit=500");
  });

  it("uses aggregate=5 as default for minute timeframe", async () => {
    mockFetch
      .mockResolvedValueOnce(makeJsonRes(MOCK_POOL_RES))
      .mockResolvedValueOnce(makeJsonRes(MOCK_OHLCV_RES));

    const app = makeApp();
    await app.request(
      new Request(
        `http://localhost/chart/${VALID_MINT}?timeframe=minute&_nocache=d`
      )
    );
    const ohlcvUrl = mockFetch.mock.calls[1]?.[0] as string;
    expect(ohlcvUrl).toContain("aggregate=5");
  });

  it("returns empty candles when OHLCV fetch returns non-ok", async () => {
    mockFetch
      .mockResolvedValueOnce(makeJsonRes(MOCK_POOL_RES))
      .mockResolvedValueOnce(new Response("", { status: 429 }));

    const app = makeApp();
    const res = await app.request(
      new Request(`http://localhost/chart/${VALID_MINT}?_nocache=e`)
    );
    const body = await res.json();
    expect(body.candles).toEqual([]);
  });

  it("falls back to 'hour' for an invalid timeframe value", async () => {
    mockFetch
      .mockResolvedValueOnce(makeJsonRes(MOCK_POOL_RES))
      .mockResolvedValueOnce(makeJsonRes(MOCK_OHLCV_RES));

    const app = makeApp();
    // Use limit=97 to get a unique cache key not used by any other test
    await app.request(
      new Request(
        `http://localhost/chart/${VALID_MINT}?timeframe=hour/../../../evil&limit=97`
      )
    );
    // OHLCV URL must use 'hour', not the injected value
    const ohlcvUrl = mockFetch.mock.calls[1]?.[0] as string;
    expect(ohlcvUrl).toContain("/ohlcv/hour");
    expect(ohlcvUrl).not.toContain("evil");
  });

  it("accepts all valid timeframe values", async () => {
    // Use unique limit values (98, 99, 101) to avoid collisions with other tests
    const cases: Array<[string, number]> = [
      ["minute", 98],
      ["hour", 99],
      ["day", 101],
    ];
    for (const [tf, limit] of cases) {
      vi.resetAllMocks();
      mockFetch
        .mockResolvedValueOnce(makeJsonRes(MOCK_POOL_RES))
        .mockResolvedValueOnce(makeJsonRes(MOCK_OHLCV_RES));

      const app = makeApp();
      const res = await app.request(
        new Request(
          `http://localhost/chart/${VALID_MINT}?timeframe=${tf}&limit=${limit}`
        )
      );
      expect(res.status).toBe(200);
      const ohlcvUrl = mockFetch.mock.calls[1]?.[0] as string;
      expect(ohlcvUrl).toContain(`/ohlcv/${tf}`);
    }
  });
});
