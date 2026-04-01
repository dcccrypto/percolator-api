/**
 * Tests for ADL rankings route — PERC-8293 (T11)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { adlRoutes, __resetAdlCache } from "../../src/routes/adl.js";

// ── mocks ──────────────────────────────────────────────────────────────────

vi.mock("@percolator/shared", () => ({
  getConnection: vi.fn(),
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
  sanitizeSlabAddress: vi.fn((addr: string) => addr),
}));

vi.mock("@percolator/sdk", () => ({
  fetchSlab: vi.fn(),
  parseEngine: vi.fn(),
  parseConfig: vi.fn(),
  parseAllAccounts: vi.fn(),
}));

const { getConnection } = await import("@percolator/shared");
const { fetchSlab, parseEngine, parseConfig, parseAllAccounts } =
  await import("@percolator/sdk");

// ── helpers ────────────────────────────────────────────────────────────────

const VALID_SLAB = "5Q7pGG6sQLMTHx5gBXGdEBTpD5nCRuagE8DyWs5WBqrd";

function makeEngine(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    pnlPosTot: 0n,
    insuranceFund: {
      balance: 1_000_000_000n,
      feeRevenue: 1_000_000_000n,
    },
    ...overrides,
  };
}

function makeConfig(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    oracleAuthority: { equals: () => false },
    indexFeedId: { toBytes: () => new Uint8Array(32) },
    maxPnlCap: 500_000_000n,
    ...overrides,
  };
}

async function makeRequest(queryString: string) {
  const app = adlRoutes();
  const req = new Request(`http://localhost/api/adl/rankings${queryString}`);
  return app.fetch(req);
}

// ── tests ──────────────────────────────────────────────────────────────────

describe("GET /api/adl/rankings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetAdlCache();
    vi.mocked(getConnection).mockReturnValue({} as any);
    vi.mocked(fetchSlab).mockResolvedValue(new Uint8Array(32));
    vi.mocked(parseEngine).mockReturnValue(makeEngine() as any);
    vi.mocked(parseConfig).mockReturnValue(makeConfig() as any);
    vi.mocked(parseAllAccounts).mockReturnValue([]);
  });

  it("returns 400 when slab param is missing", async () => {
    const res = await makeRequest("");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/slab query parameter/i);
  });

  it("returns 400 for invalid slab address", async () => {
    const { sanitizeSlabAddress } = await import("@percolator/shared");
    vi.mocked(sanitizeSlabAddress).mockReturnValueOnce(null as any);
    const res = await makeRequest("?slab=not-a-pubkey");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/invalid slab/i);
  });

  it("returns 404 when slab account not found", async () => {
    vi.mocked(fetchSlab).mockRejectedValueOnce(new Error("Slab account not found: abc"));
    const res = await makeRequest(`?slab=${VALID_SLAB}`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toMatch(/not found/i);
  });

  it("returns adlNeeded=false when pnlPosTot ≤ maxPnlCap and utilization ok", async () => {
    vi.mocked(parseEngine).mockReturnValue(
      makeEngine({ pnlPosTot: 100n }) as any
    );
    vi.mocked(parseConfig).mockReturnValue(
      makeConfig({ maxPnlCap: 1_000_000n }) as any
    );
    const res = await makeRequest(`?slab=${VALID_SLAB}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.adlNeeded).toBe(false);
    expect(body.capExceeded).toBe(false);
    expect(body.rankings).toEqual([]);
  });

  it("returns adlNeeded=true and rankings when pnlPosTot > maxPnlCap", async () => {
    vi.mocked(parseEngine).mockReturnValue(
      makeEngine({ pnlPosTot: 900_000_000n }) as any
    );
    vi.mocked(parseConfig).mockReturnValue(
      makeConfig({ maxPnlCap: 500_000_000n }) as any
    );
    vi.mocked(parseAllAccounts).mockReturnValue([
      {
        idx: 7,
        account: {
          positionSize: 100n,
          pnl: 200_000_000n,
          capital: 400_000_000n,
        } as any,
      },
      {
        idx: 3,
        account: {
          positionSize: 50n,
          pnl: 100_000_000n,
          capital: 100_000_000n,
        } as any,
      },
    ]);

    const res = await makeRequest(`?slab=${VALID_SLAB}`);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.adlNeeded).toBe(true);
    expect(body.capExceeded).toBe(true);
    expect(body.rankings).toHaveLength(2);
    // idx=3 has 100% PnL (1_000_000 millionths) — ranked first
    expect(body.rankings[0].idx).toBe(3);
    expect(body.rankings[0].rank).toBe(1);
    // idx=7 has 50% PnL (500_000 millionths) — ranked second
    expect(body.rankings[1].idx).toBe(7);
    expect(body.rankings[1].rank).toBe(2);
  });

  it("returns utilizationTriggered=true when insurance utilization exceeds threshold", async () => {
    // balance=0, feeRevenue=1_000_000_000 → utilization = 10_000 bps = 100%
    vi.mocked(parseEngine).mockReturnValue(
      makeEngine({
        pnlPosTot: 0n,
        insuranceFund: {
          balance: 0n,
          feeRevenue: 1_000_000_000n,
        },
      }) as any
    );
    vi.mocked(parseConfig).mockReturnValue(
      makeConfig({ maxPnlCap: 500_000_000n }) as any
    );

    const res = await makeRequest(`?slab=${VALID_SLAB}`);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.utilizationTriggered).toBe(true);
    expect(body.adlNeeded).toBe(true);
    expect(body.insuranceUtilizationBps).toBe(10000);
  });

  it("returns zero utilization for fresh market with zero fee revenue", async () => {
    vi.mocked(parseEngine).mockReturnValue(
      makeEngine({
        pnlPosTot: 0n,
        insuranceFund: {
          balance: 0n,
          feeRevenue: 0n,
        },
      }) as any
    );
    vi.mocked(parseConfig).mockReturnValue(
      makeConfig({ maxPnlCap: 0n }) as any
    );

    const res = await makeRequest(`?slab=${VALID_SLAB}`);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.insuranceUtilizationBps).toBe(0);
    expect(body.utilizationTriggered).toBe(false);
    expect(body.adlNeeded).toBe(false);
  });

  it("excludes positions with zero positionSize from rankings", async () => {
    vi.mocked(parseEngine).mockReturnValue(
      makeEngine({ pnlPosTot: 999_999_999n }) as any
    );
    vi.mocked(parseConfig).mockReturnValue(
      makeConfig({ maxPnlCap: 1n }) as any
    );
    vi.mocked(parseAllAccounts).mockReturnValue([
      {
        idx: 1,
        account: {
          positionSize: 0n, // no position — should be excluded
          pnl: 500_000n,
          capital: 100_000n,
        } as any,
      },
      {
        idx: 2,
        account: {
          positionSize: 100n,
          pnl: -100n, // negative PnL — excluded
          capital: 100_000n,
        } as any,
      },
    ]);

    const res = await makeRequest(`?slab=${VALID_SLAB}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rankings).toEqual([]);
  });

  it("returns all required response fields", async () => {
    const res = await makeRequest(`?slab=${VALID_SLAB}`);
    expect(res.status).toBe(200);
    const body = await res.json();

    const requiredFields = [
      "slabAddress",
      "pnlPosTot",
      "maxPnlCap",
      "insuranceFundBalance",
      "insuranceFundFeeRevenue",
      "insuranceUtilizationBps",
      "capExceeded",
      "insuranceDepleted",
      "utilizationTriggered",
      "adlNeeded",
      "excess",
      "rankings",
    ];
    for (const field of requiredFields) {
      expect(body).toHaveProperty(field);
    }
  });
});
