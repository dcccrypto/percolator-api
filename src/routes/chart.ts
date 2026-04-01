/**
 * Chart OHLCV API Route (issue #13)
 *
 * Ported from percolator-launch /api/chart/[mint] to Hono.
 *
 * GET /chart/:mint?timeframe=hour&aggregate=1&limit=168
 *
 * Returns OHLCV candle data for a Solana SPL token by mint address.
 * Data source: GeckoTerminal (free, no API key required).
 *
 * Flow:
 *   1. Validate mint as a Solana PublicKey.
 *   2. Resolve top DEX pool via GeckoTerminal /tokens/:mint/pools.
 *   3. Fetch OHLCV from GeckoTerminal /pools/:pool/ohlcv/:timeframe.
 *   4. Return with 60-second in-memory cache + cache-control headers.
 *
 * Query params:
 *   timeframe  "minute" | "hour" | "day"  (default: "hour")
 *   aggregate  candle aggregation (default: 1 for hour, 5 for minute)
 *   limit      number of candles, max 500 (default: 168 = 7 days hourly)
 */
import { Hono } from "hono";
import { PublicKey } from "@solana/web3.js";
import { createLogger } from "@percolator/shared";

const logger = createLogger("api:chart");

// ── Types ──────────────────────────────────────────────────────────────────
export interface CandleData {
  timestamp: number; // Unix ms
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface CacheEntry {
  candles: CandleData[];
  poolAddress: string | null;
  fetchedAt: number;
}

// ── Cache ──────────────────────────────────────────────────────────────────
const CACHE_TTL_MS = 60 * 1_000; // 60 seconds
const CACHE_MAX_SIZE = 100;
const cache = new Map<string, CacheEntry>();

// ── GeckoTerminal helpers ──────────────────────────────────────────────────
const GECKO_BASE = "https://api.geckoterminal.com/api/v2";
const GECKO_HEADERS = { Accept: "application/json;version=20230302" };
const GECKO_TIMEOUT_MS = 5_000; // 5 second timeout for all upstream fetches

// ── Timeframe allowlist ────────────────────────────────────────────────────
const VALID_TIMEFRAMES = ["minute", "hour", "day"] as const;
type Timeframe = (typeof VALID_TIMEFRAMES)[number];

function parseTimeframe(raw: string | undefined): Timeframe {
  return VALID_TIMEFRAMES.includes(raw as Timeframe)
    ? (raw as Timeframe)
    : "hour";
}

async function getTopPool(mint: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GECKO_TIMEOUT_MS);
  try {
    const url = `${GECKO_BASE}/networks/solana/tokens/${mint}/pools?limit=1&sort=h24_volume_usd_liquidity_desc`;
    const res = await fetch(url, {
      headers: GECKO_HEADERS,
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      data?: Array<{ id?: string }>;
    };
    const pools = json?.data;
    if (!Array.isArray(pools) || pools.length === 0) return null;
    // GeckoTerminal pool ids are prefixed with "solana_"
    return pools[0]?.id?.replace("solana_", "") ?? null;
  } catch (err) {
    logger.warn("getTopPool fetch error", { mint, err });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchOhlcv(
  poolAddress: string,
  timeframe: Timeframe,
  aggregate: number,
  limit: number
): Promise<CandleData[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GECKO_TIMEOUT_MS);
  try {
    const url =
      `${GECKO_BASE}/networks/solana/pools/${poolAddress}/ohlcv/${timeframe}` +
      `?aggregate=${aggregate}&limit=${limit}&currency=usd&include_empty_intervals=false`;
    const res = await fetch(url, {
      headers: GECKO_HEADERS,
      signal: controller.signal,
    });
    if (!res.ok) return [];
    const json = (await res.json()) as {
      data?: { attributes?: { ohlcv_list?: number[][] } };
    };
    const ohlcvList = json?.data?.attributes?.ohlcv_list;
    if (!Array.isArray(ohlcvList)) return [];

    return (
      ohlcvList
        .map(([ts, o, h, l, c, v]) => ({
          timestamp: (ts ?? 0) * 1000, // sec → ms
          open: o ?? 0,
          high: h ?? 0,
          low: l ?? 0,
          close: c ?? 0,
          volume: v ?? 0,
        }))
        // Drop zero-close candles (usually padding)
        .filter((candle) => candle.close > 0)
        .sort((a, b) => a.timestamp - b.timestamp)
    );
  } catch (err) {
    logger.warn("fetchOhlcv error", { poolAddress, err });
    return [];
  } finally {
    clearTimeout(timer);
  }
}

// ── Route ──────────────────────────────────────────────────────────────────
export function chartRoutes(): Hono {
  const app = new Hono();

  /**
   * GET /chart/:mint
   *
   * Returns:
   *   { candles: CandleData[], poolAddress: string | null, cached: boolean }
   *
   * On no pool found: returns { candles: [], poolAddress: null, cached: false }
   * (caller falls back to oracle prices).
   */
  app.get("/chart/:mint", async (c) => {
    const mint = c.req.param("mint");

    // Validate: must be a valid Solana PublicKey
    try {
      if (!mint) throw new Error("missing mint");
      new PublicKey(mint);
    } catch {
      return c.json({ error: "Invalid mint address" }, 400);
    }

    // Parse query params — validate timeframe against explicit allowlist
    const timeframe = parseTimeframe(c.req.query("timeframe"));
    const defaultAggregate = timeframe === "minute" ? "5" : "1";
    const VALID_AGGREGATES: Record<Timeframe, number[]> = {
      minute: [1, 5, 15],
      hour: [1, 4, 12],
      day: [1],
    };
    const rawAggregate = parseInt(c.req.query("aggregate") ?? defaultAggregate, 10);
    const allowed = VALID_AGGREGATES[timeframe];
    const aggregate = allowed.includes(rawAggregate) ? rawAggregate : allowed[0];
    const rawLimit = parseInt(c.req.query("limit") ?? "168", 10);
    const limit = Math.min(500, Math.max(1, Number.isNaN(rawLimit) ? 168 : rawLimit));

    const cacheKey = `${mint}:${timeframe}:${aggregate}:${limit}`;
    const hit = cache.get(cacheKey);
    if (hit && Date.now() - hit.fetchedAt < CACHE_TTL_MS) {
      return c.json(
        { candles: hit.candles, poolAddress: hit.poolAddress, cached: true },
        200,
        { "Cache-Control": "public, max-age=60, stale-while-revalidate=120" }
      );
    }

    // Step 1: resolve top pool
    const poolAddress = await getTopPool(mint);
    if (!poolAddress) {
      return c.json({ candles: [], poolAddress: null, cached: false });
    }

    // Step 2: fetch OHLCV
    const candles = await fetchOhlcv(poolAddress, timeframe, aggregate, limit);

    // Only cache non-empty results to avoid persisting upstream failures
    if (candles.length > 0) {
      cache.set(cacheKey, { candles, poolAddress, fetchedAt: Date.now() });
    }

    // Evict oldest entries when over limit (Map iteration order = insertion order)
    while (cache.size > CACHE_MAX_SIZE) {
      const oldestKey = cache.keys().next().value;
      if (oldestKey) cache.delete(oldestKey);
      else break;
    }

    return c.json(
      { candles, poolAddress, cached: false },
      200,
      { "Cache-Control": "public, max-age=60, stale-while-revalidate=120" }
    );
  });

  return app;
}
