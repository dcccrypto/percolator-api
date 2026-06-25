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
  isV17Account,
} from "@percolatorct/sdk";
import {
  getConnection,
  createLogger,
  sanitizeSlabAddress,
} from "@percolator/shared";
import { withRpcFallback } from "../utils/rpc-fallback.js";
import { RpcTimeoutError } from "../utils/rpc-timeout.js";
import { isBlockedSlab } from "../middleware/validateSlab.js";
import { getClientIp } from "../middleware/rate-limit.js";
import { getSharedStore } from "../middleware/shared-store.js";

const logger = createLogger("api:adl");

// ─── ADL result cache (prevents RPC amplification) ────────────────────────
const ADL_CACHE_TTL_MS = 15_000; // 15 seconds
const ADL_CACHE_MAX_ENTRIES = 100;
const adlCache = new Map<string, { data: any; fetchedAt: number }>();

// ─── per-IP RPC-fetch throttle ──────────────────────────────────────────────
// The cache above only de-dupes repeated lookups of the SAME slab. It does
// nothing to stop a caller from cycling through many distinct slab values
// (real or syntactically-valid-but-nonexistent) to force a fresh fetchSlab
// RPC call per request. This throttle counts only cache-miss-triggering
// fetches per IP, so normal polling of a handful of real markets within the
// cache TTL is unaffected, while distinct-slab cycling is capped.
const ADL_RPC_FETCH_WINDOW_MS = 60_000; // 1 minute
const ADL_RPC_FETCH_MAX_ENTRIES = 50_000; // same OOM-safety cap as rate-limit.ts
const ADL_RPC_FETCH_LIMIT = (() => {
  const parsed = Number(process.env.ADL_RPC_FETCH_LIMIT_PER_MIN ?? "20");
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    logger.warn("Invalid ADL_RPC_FETCH_LIMIT_PER_MIN, using default 20", {
      value: process.env.ADL_RPC_FETCH_LIMIT_PER_MIN,
    });
    return 20;
  }
  return parsed;
})();

/** @internal Reset cache — used by tests to ensure isolation */
export function __resetAdlCache(): void {
  adlCache.clear();
}

// ─── constants / tunables ─────────────────────────────────────────────────

/**
 * Insurance fund utilization BPS threshold above which ADL is considered active.
 * Mirrors ADL_INSURANCE_UTIL_THRESHOLD_BPS in percolator-keeper.
 * Default 8000 BPS = 80%. Valid range: 0–10000.
 */
const INSURANCE_UTIL_THRESHOLD_BPS = (() => {
  const parsed = Number(process.env.ADL_INSURANCE_UTIL_THRESHOLD_BPS ?? "8000");
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0 || parsed > 10000) {
    logger.warn("Invalid ADL_INSURANCE_UTIL_THRESHOLD_BPS, using default 8000", {
      value: process.env.ADL_INSURANCE_UTIL_THRESHOLD_BPS,
    });
    return 8000;
  }
  return parsed;
})();

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
  // v17 desync fix (PERC-DESYNC-1 / blocker): in v17 the market-group account
  // uses V17_MAGIC ("PERCV16\0") and does NOT embed portfolio accounts in the slab.
  // Portfolios are standalone on-chain accounts. parseAllAccounts() is v12-only
  // (bitmap-indexed embedded layout). Detect v17 and return empty — the ADL
  // trigger state (capExceeded / utilizationTriggered) is still surfaced; ranking
  // requires a separate portfolio-scan path not implemented at the API layer.
  if (isV17Account(data)) {
    logger.warn(
      "rankProfitablePositions: v17 market-group account detected — " +
      "portfolio positions are standalone accounts and cannot be ranked from slab bytes. " +
      "Returning empty rankings; ADL trigger state is still valid.",
    );
    return [];
  }
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
      // Promote to most-recently-used so the FIFO-by-insertion eviction
      // at lines below behaves as LRU. Without this, hot keys inserted
      // early get evicted while cold keys inserted later survive.
      adlCache.delete(slab);
      adlCache.set(slab, cached);
      return c.json(cached.data, 200, { "X-Cache": "HIT" });
    }

    try {
      new PublicKey(slab); // throws if invalid
    } catch {
      return c.json({ error: "Invalid slab address" }, 400);
    }

    if (isBlockedSlab(slab)) {
      return c.json({ error: "Market not found" }, 404);
    }

    // Throttle cache-miss-triggering RPC fetches per IP. This is what actually
    // bounds RPC-cost amplification from cycling distinct slab values; the
    // generic global rate limiter alone does not, since each distinct slab is
    // a fresh cache miss regardless of how many total requests remain in budget.
    const ip = getClientIp(c);
    if (ip) {
      const bucket = await getSharedStore().incrementRateBucket(
        `adl-rpc-fetch:${ip}`,
        ADL_RPC_FETCH_WINDOW_MS,
        ADL_RPC_FETCH_MAX_ENTRIES
      );
      if (bucket.count > ADL_RPC_FETCH_LIMIT) {
        const retryAfter = Math.max(1, Math.floor((bucket.resetAt - Date.now()) / 1000));
        c.header("Retry-After", retryAfter.toString());
        logger.warn("ADL RPC-fetch throttle exceeded", { ip, slab, limit: ADL_RPC_FETCH_LIMIT });
        return c.json({ error: "Too many distinct market lookups — try again shortly" }, 429);
      }
    }

    let data: Uint8Array;
    try {
      data = await withRpcFallback(
        (conn) => fetchSlab(conn, new PublicKey(slab)),
        getConnection(),
        `fetchSlab(${slab})`,
      );
    } catch (err) {
      if (err instanceof RpcTimeoutError) {
        logger.warn("RPC timeout fetching slab for ADL", { slab, timeoutMs: err.timeoutMs });
        return c.json({ error: "Upstream RPC timeout", slab }, 504);
      }
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("not found")) {
        return c.json({ error: "Slab account not found", slab }, 404);
      }
      logger.error("fetchSlab failed", { slab, error: msg });
      return c.json({ error: "Failed to fetch slab data" }, 500);
    }

    // v17 desync fix (PERC-DESYNC-1 / blocker): v17 market-group accounts have a
    // different magic ("PERCV16\0") and layout — parseEngine/parseConfig expect the
    // v12.x "PERCOLAT" slab magic and will throw on v17 data. Detect early and return
    // a clear actionable error instead of the generic "may be uninitialized" message.
    if (isV17Account(data)) {
      logger.warn("adl/rankings: v17 market-group account — portfolio positions are standalone accounts", { slab });
      return c.json(
        {
          error:
            "v17 market detected: portfolio positions are stored in standalone on-chain accounts " +
            "and cannot be read from the market-group account. ADL ranking is not available " +
            "via this endpoint for v17 markets.",
          slab,
        },
        400,
      );
    }

    let engine: ReturnType<typeof parseEngine>;
    let cfg: ReturnType<typeof parseConfig>;
    try {
      engine = parseEngine(data);
      cfg = parseConfig(data);
    } catch (err) {
      logger.error("parseEngine/parseConfig failed", { slab, error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: "Slab data could not be parsed — may be uninitialized or corrupted" }, 400);
    }

    const pnlPosTot = engine.pnlPosTot;
    const maxPnlCap: bigint = cfg.maxPnlCap;
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
      : "0";

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
