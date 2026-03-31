/**
 * ADL Rankings API Route — PERC-8293 (T11)
 *
 * GET /api/adl/rankings?slab=<address>
 *
 * Fetches on-chain slab data, checks ADL trigger conditions, and returns a
 * ranked list of profitable positions eligible for auto-deleveraging.
 *
 * This is a read-only endpoint — it does NOT dispatch any on-chain transactions.
 * It is designed for frontend observability and keeper health checks.
 *
 * Response format:
 * {
 *   "slabAddress": "...",
 *   "pnlPosTot": "1234567890",
 *   "maxPnlCap": "1000000000",
 *   "insuranceFundBalance": "500000000",
 *   "insuranceFundFeeRevenue": "800000000",
 *   "insuranceUtilizationBps": 3750,
 *   "capExceeded": true,
 *   "insuranceDepleted": false,
 *   "utilizationTriggered": false,
 *   "adlNeeded": true,
 *   "excess": "234567890",
 *   "rankings": [
 *     {
 *       "rank": 1,
 *       "idx": 42,
 *       "pnlAbs": "120000000",
 *       "capital": "500000000",
 *       "pnlPctMillionths": "240000"
 *     }
 *   ]
 * }
 *
 * If ADL is not needed (adlNeeded=false), rankings will be empty [].
 * If the slab is not found or malformed, returns 404 or 400.
 */

import { Hono } from "hono";
import { PublicKey } from "@solana/web3.js";
import {
  fetchSlab,
  parseEngine,
  parseConfig,
  parseAllAccounts,
} from "@percolator/sdk";
import {
  getConnection,
  createLogger,
  sanitizeSlabAddress,
} from "@percolator/shared";

const logger = createLogger("api:adl");

// ─── ADL result cache (prevents RPC amplification) ────────────────────────
const ADL_CACHE_TTL_MS = 15_000; // 15 seconds
const ADL_CACHE_MAX_ENTRIES = 100;
const adlCache = new Map<string, { data: any; fetchedAt: number }>();

// ─── constants / tunables ─────────────────────────────────────────────────

/**
 * Insurance fund utilization BPS threshold above which ADL is considered active.
 * Mirrors ADL_INSURANCE_UTIL_THRESHOLD_BPS in percolator-keeper.
 * Default 8000 BPS = 80%.
 */
const INSURANCE_UTIL_THRESHOLD_BPS =
  Number(process.env.ADL_INSURANCE_UTIL_THRESHOLD_BPS ?? "8000");

// ─── helpers ─────────────────────────────────────────────────────────────

function computeInsuranceUtilizationBps(
  balance: bigint,
  feeRevenue: bigint
): number {
  if (feeRevenue === 0n) return 0;
  const consumed = feeRevenue > balance ? feeRevenue - balance : 0n;
  const bps = (consumed * 10_000n) / feeRevenue;
  return Number(bps > 10_000n ? 10_000n : bps);
}

interface RankedPosition {
  rank: number;
  idx: number;
  pnlAbs: string;
  capital: string;
  pnlPctMillionths: string;
}

function rankProfitablePositions(data: Uint8Array): RankedPosition[] {
  const allAccounts = parseAllAccounts(data);
  const profitable: Array<{
    idx: number;
    pnlPct: bigint;
    pnlAbs: bigint;
    capital: bigint;
  }> = [];

  for (const { idx, account } of allAccounts) {
    if (account.positionSize === 0n) continue;
    if (account.pnl <= 0n) continue;

    const capital = account.capital > 0n ? account.capital : 1n;
    const pnlAbs = account.pnl;
    const pnlPct = (pnlAbs * 1_000_000n) / capital;

    profitable.push({ idx, pnlPct, pnlAbs, capital });
  }

  // Sort descending by PnL%; tie-break by absolute PnL descending
  profitable.sort((a, b) => {
    if (b.pnlPct !== a.pnlPct) return b.pnlPct > a.pnlPct ? 1 : -1;
    return b.pnlAbs > a.pnlAbs ? 1 : -1;
  });

  return profitable.map((p, i) => ({
    rank: i + 1,
    idx: p.idx,
    pnlAbs: p.pnlAbs.toString(),
    capital: p.capital.toString(),
    pnlPctMillionths: p.pnlPct.toString(),
  }));
}

// ─── route ────────────────────────────────────────────────────────────────

export function adlRoutes(): Hono {
  const app = new Hono();

  /**
   * GET /api/adl/rankings
   *
   * Query params:
   *   slab  — slab address (base58 pubkey)
   *
   * Returns ADL trigger state and ranked position list for the given slab.
   */
  app.get("/api/adl/rankings", async (c) => {
    const rawSlab = c.req.query("slab");
    if (!rawSlab) {
      return c.json({ error: "slab query parameter is required" }, 400);
    }

    // Validate as base58 pubkey
    const slab = sanitizeSlabAddress(rawSlab);
    if (!slab) {
      return c.json({ error: "Invalid slab address" }, 400);
    }

    // Check cache to avoid redundant expensive RPC calls
    const cached = adlCache.get(slab);
    if (cached && Date.now() - cached.fetchedAt < ADL_CACHE_TTL_MS) {
      return c.json(cached.data, 200, { "X-Cache": "HIT" });
    }

    try {
      new PublicKey(slab); // throws if invalid
    } catch {
      return c.json({ error: "Invalid slab address" }, 400);
    }

    const connection = getConnection();
    let data: Uint8Array;
    try {
      data = await fetchSlab(connection, new PublicKey(slab));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("not found")) {
        return c.json({ error: "Slab account not found", slab }, 404);
      }
      logger.error("fetchSlab failed", { slab, error: msg });
      return c.json({ error: "Failed to fetch slab data" }, 500);
    }

    let engine: ReturnType<typeof parseEngine>;
    let cfg: ReturnType<typeof parseConfig> & { maxPnlCap?: bigint };
    try {
      engine = parseEngine(data);
      // NOTE: parseConfig returns MarketConfig. The `maxPnlCap` field was added in a
      // later SDK version. We cast to `any` to read it where available, falling back
      // to 0n on older SDK builds. When the API SDK is bumped to ≥47e3799, remove the cast.
      cfg = parseConfig(data) as ReturnType<typeof parseConfig> & { maxPnlCap?: bigint };
    } catch (err) {
      logger.error("parseEngine/parseConfig failed", { slab, error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: "Slab data could not be parsed — may be uninitialized or corrupted" }, 400);
    }

    const pnlPosTot = engine.pnlPosTot;
    // maxPnlCap is available in SDK ≥47e3799; fallback to 0n disables cap-exceeded trigger
    const maxPnlCap: bigint = (cfg as any).maxPnlCap ?? 0n;
    const insBalance = engine.insuranceFund.balance;
    const insFeeRevenue = engine.insuranceFund.feeRevenue;

    const capExceeded = maxPnlCap > 0n && pnlPosTot > maxPnlCap;
    const utilizationBps = computeInsuranceUtilizationBps(insBalance, insFeeRevenue);
    const utilizationTriggered =
      INSURANCE_UTIL_THRESHOLD_BPS > 0 &&
      utilizationBps >= INSURANCE_UTIL_THRESHOLD_BPS;

    // insuranceDepleted gate matches keeper (ADL_INSURANCE_THRESHOLD_LAMPORTS)
    // Not configurable from API — treated as false here (keeper manages this gate).
    const insuranceDepleted = false;

    const adlNeeded = capExceeded || utilizationTriggered;
    const excess = capExceeded && maxPnlCap > 0n
      ? (pnlPosTot - maxPnlCap).toString()
      : pnlPosTot.toString();

    let rankings: RankedPosition[] = [];
    if (adlNeeded) {
      try {
        rankings = rankProfitablePositions(data);
      } catch (err) {
        logger.warn("rankProfitablePositions failed", {
          slab,
          error: err instanceof Error ? err.message : String(err),
        });
        // Return trigger state even if ranking fails
      }
    }

    const result = {
      slabAddress: slab,
      pnlPosTot: pnlPosTot.toString(),
      maxPnlCap: maxPnlCap.toString(),
      insuranceFundBalance: insBalance.toString(),
      insuranceFundFeeRevenue: insFeeRevenue.toString(),
      insuranceUtilizationBps: utilizationBps,
      capExceeded,
      insuranceDepleted,
      utilizationTriggered,
      adlNeeded,
      excess,
      rankings,
    };

    // Cache the result
    if (adlCache.size >= ADL_CACHE_MAX_ENTRIES) {
      const oldestKey = adlCache.keys().next().value;
      if (oldestKey !== undefined) adlCache.delete(oldestKey);
    }
    adlCache.set(slab, { data: result, fetchedAt: Date.now() });

    return c.json(result, 200, { "X-Cache": "MISS" });
  });

  return app;
}
