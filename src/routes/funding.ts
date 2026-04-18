/**
 * Funding Rate API Routes
 * 
 * Exposes funding rate data for markets:
 * - Current funding rate (bps/slot)
 * - Annualized/hourly/daily rates
 * - Net LP position (inventory)
 * - Funding index (cumulative)
 * - 24h historical funding data
 */
import { Hono } from "hono";
import { validateSlab } from "../middleware/validateSlab.js";
import { cacheMiddleware } from "../middleware/cache.js";
import { withDbCacheFallback } from "../middleware/db-cache-fallback.js";
import { 
  getFundingHistory, 
  getFundingHistorySince,
  getSupabase,
  getNetwork,
  createLogger,
  truncateErrorMessage,
} from "@percolator/shared";

/**
 * GH#1459: Import the backend blocklist predicate so /funding/global can
 * filter blocked slabs. validateSlab middleware only runs on /:slab routes;
 * the global endpoint bypasses it and must apply the same check inline.
 * isBlockedSlab covers both HARDCODED_BLOCKED_SLABS and BLOCKED_MARKET_ADDRESSES env var.
 */
import { isBlockedSlab } from "../middleware/validateSlab.js";

const logger = createLogger("api:funding");

/**
 * Maximum valid funding rate in bps/slot (matches on-chain guard).
 * Raw DB values outside [-MAX, MAX] are garbage from uninitialized slabs.
 * Returns 0 for garbage values to avoid rendering astronomical percentages.
 */
const MAX_FUNDING_RATE_BPS = 10_000;
function sanitizeFundingRateBps(raw: number): number {
  if (!Number.isFinite(raw) || Math.abs(raw) > MAX_FUNDING_RATE_BPS) return 0;
  return raw;
}

export function fundingRoutes(): Hono {
  const app = new Hono();

  /**
   * GET /funding/global
   * 
   * Returns current funding rates for all markets.
   * NOTE: This must come BEFORE /funding/:slab to avoid :slab matching "global"
   */
  app.get("/funding/global", async (c) => {
    const SLOTS_PER_HOUR = 9000;
    const SLOTS_PER_DAY = 216000;

    const result = await withDbCacheFallback(
      "funding:global",
      async () => {
        const { data: allStats, error } = await getSupabase()
          .from("markets_with_stats")
          .select("slab_address, funding_rate, net_lp_pos")
          .eq("network", getNetwork())
          .not("slab_address", "is", null);

        if (error) throw error;

        // GH#1459: Filter blocked slabs from the global response.
        // validateSlab middleware only runs on /:slab routes; the global endpoint
        // queries all market_stats rows and previously exposed blocked slabs
        // (8eFFEFBY, 3bmCyPee, 3YDqCJGz, 3ZKKwsK) with phantom netLpPosition values.
        const markets = (allStats ?? [])
          .filter((stats) => !isBlockedSlab(stats.slab_address))
          .map((stats) => {
            const rateBps = sanitizeFundingRateBps(Number(stats.funding_rate ?? 0));
            return {
              slabAddress: stats.slab_address,
              currentRateBpsPerSlot: rateBps,
              hourlyRatePercent: Number(((rateBps / 10000.0) * SLOTS_PER_HOUR).toFixed(6)),
              dailyRatePercent: Number(((rateBps / 10000.0) * SLOTS_PER_DAY).toFixed(4)),
              netLpPosition: stats.net_lp_pos ?? "0",
            };
          });

        return { count: markets.length, markets };
      },
      c
    );

    // withDbCacheFallback returns a Response on failure (503 when both the
    // query failed and no usable cache exists). On success — fresh or stale
    // fallback — it returns a DbCacheResult; staleness HTTP headers are
    // already set on the context by the middleware.
    if (result instanceof Response) return result;

    return c.json(result.data);
  });

  /**
   * GET /funding/:slab — 30s cache
   * 
   * Returns current funding rate data and 24h history for a market.
   * 
   * Response format:
   * {
   *   "currentRateBpsPerSlot": 5,
   *   "hourlyRatePercent": 0.42,
   *   "dailyRatePercent": 10.08,
   *   "annualizedPercent": 3679.2,
   *   "netLpPosition": "1500000",
   *   "fundingIndexQpbE6": "123456789",
   *   "lastUpdatedSlot": 123456789,
   *   "last24hHistory": [
   *     { "timestamp": "2025-02-14T12:00:00Z", "rateBpsPerSlot": 5, "priceE6": 150000000 }
   *   ]
   * }
   */
  app.get("/funding/:slab", cacheMiddleware(30), validateSlab, async (c) => {
    const slab = c.req.param("slab");
    if (!slab) return c.json({ error: "slab required" }, 400);

    try {
      // GH#1511: Fetch funding stats + market metadata in a single query via
      // markets_with_stats view so we can populate metadata.symbol and
      // metadata.last_price. Falls back gracefully if market row is missing.
      const { data: stats, error: statsError } = await getSupabase()
        .from("markets_with_stats")
        .select("funding_rate, net_lp_pos, symbol, last_price")
        .eq("slab_address", slab)
        .single();

      if (statsError && statsError.code !== "PGRST116") {
        throw statsError;
      }

      if (!stats) {
        return c.json({ 
          error: "Market stats not found",
          hint: "Market may not have been cranked yet or does not exist"
        }, 404);
      }

      // Parse current funding data
      const currentRateBpsPerSlot = stats.funding_rate ?? 0;
      const netLpPosition = stats.net_lp_pos ?? "0";

      // Calculate rates
      // Solana slots: ~2.5 slots/second = 400ms per slot
      // Hourly: 3600s / 0.4s = 9000 slots
      // Daily: 24 * 9000 = 216,000 slots
      // Annual: 365 * 216,000 = 78,840,000 slots
      const SLOTS_PER_HOUR = 9000;
      const SLOTS_PER_DAY = 216000;
      const SLOTS_PER_YEAR = 78840000;

      const rateBps = sanitizeFundingRateBps(Number(currentRateBpsPerSlot));
      const hourlyRatePercent = (rateBps / 10000.0) * SLOTS_PER_HOUR;
      const dailyRatePercent = (rateBps / 10000.0) * SLOTS_PER_DAY;
      const annualizedPercent = (rateBps / 10000.0) * SLOTS_PER_YEAR;

      // Fetch 24h funding history — gracefully degrade if table is unavailable
      const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      let history: Awaited<ReturnType<typeof getFundingHistorySince>>;
      try {
        history = await getFundingHistorySince(slab, since24h);
      } catch (histErr) {
        logger.warn("funding_history unavailable, returning empty history", { slab, error: histErr });
        history = [];
      }

      // Format history for response
      const last24hHistory = history.map((h) => ({
        timestamp: h.timestamp,
        slot: h.slot,
        rateBpsPerSlot: h.rate_bps_per_slot,
        netLpPos: h.net_lp_pos,
        priceE6: h.price_e6,
        fundingIndexQpbE6: h.funding_index_qpb_e6,
      }));

      // GH#1511: Sanitize last_price from markets_with_stats — same ceiling used
      // in /api/markets to guard against unscaled admin-set test prices.
      const MAX_SANE_PRICE_USD = 1_000_000;
      const rawLastPrice = Number(stats.last_price ?? 0);
      const sanitizedLastPrice =
        rawLastPrice > 0 && rawLastPrice <= MAX_SANE_PRICE_USD ? rawLastPrice : null;

      return c.json({
        slabAddress: slab,
        currentRateBpsPerSlot: rateBps,
        hourlyRatePercent: Number(hourlyRatePercent.toFixed(6)),
        dailyRatePercent: Number(dailyRatePercent.toFixed(4)),
        annualizedPercent: Number(annualizedPercent.toFixed(2)),
        netLpPosition,
        last24hHistory,
        metadata: {
          // GH#1511: Populate symbol and last_price from markets_with_stats.
          // Previously these fields were always null — the route only joined
          // market_stats, which has no symbol or price columns.
          symbol: stats.symbol ?? null,
          last_price: sanitizedLastPrice,
          dataPoints24h: last24hHistory.length,
          explanation: {
            rateBpsPerSlot: "Funding rate in basis points per slot (1 bps = 0.01%)",
            hourly: "Rate * 9,000 slots/hour (assumes 400ms slots)",
            daily: "Rate * 216,000 slots/day",
            annualized: "Rate * 78,840,000 slots/year",
            sign: "Positive = longs pay shorts | Negative = shorts pay longs",
            inventory: "Driven by net LP position (LP inventory imbalance)",
          }
        }
      });
    } catch (err) {
      logger.error("Error fetching funding data", { slab, error: truncateErrorMessage(err instanceof Error ? err.message : String(err), 120) });
      return c.json({ 
        error: "Failed to fetch funding data",
        ...(process.env.NODE_ENV !== "production" && { details: truncateErrorMessage(err instanceof Error ? err.message : String(err), 200) })
      }, 500);
    }
  });

  /**
   * GET /funding/:slab/historySince
   *
   * Returns funding rate history starting from a required `since` timestamp.
   * Referenced by the frontend funding history chart.
   *
   * Query params:
   * - since (required): ISO 8601 timestamp or unix epoch (seconds or ms).
   *   Returns all records with timestamp >= since, up to MAX_ROWS.
   * - limit (optional): max records to return (default 100, cap 500)
   *
   * Returns 400 if `since` is missing or invalid.
   * Returns 404 if the slab does not exist in market_stats.
   *
   * GH#36
   */
  app.get("/funding/:slab/historySince", validateSlab, async (c) => {
    const slab = c.req.param("slab");
    if (!slab) return c.json({ error: "slab required" }, 400);

    const sinceParam = c.req.query("since");
    const limitParam = c.req.query("limit");

    // `since` is required for this endpoint
    if (!sinceParam) {
      return c.json(
        {
          error: "Missing required query parameter: since",
          hint: "Provide an ISO 8601 timestamp or unix epoch (seconds/ms), e.g. ?since=2025-01-01T00:00:00Z",
        },
        400
      );
    }

    const MAX_ROWS = 500;

    // Parse and validate `limit` — guard against NaN from non-numeric input
    const parsedLimit = limitParam ? parseInt(limitParam, 10) : 100;
    const limit = Number.isNaN(parsedLimit) || parsedLimit <= 0
      ? 100
      : Math.min(parsedLimit, MAX_ROWS);

    // Parse and validate `since` — accepts ISO 8601 or unix epoch (same logic as /history)
    let validatedSince: string;
    const epochNum = Number(sinceParam);
    if (!Number.isNaN(epochNum) && epochNum > 0) {
      // Unix epoch — treat >1e12 as milliseconds, otherwise seconds
      const ms = epochNum > 1e12 ? epochNum : epochNum * 1000;
      const d = new Date(ms);
      if (Number.isNaN(d.getTime()) || d.getFullYear() < 2020 || d.getFullYear() > 2100) {
        return c.json({ error: "Invalid since parameter: epoch out of range" }, 400);
      }
      validatedSince = d.toISOString();
    } else {
      const d = new Date(sinceParam);
      if (Number.isNaN(d.getTime()) || d.getFullYear() < 2020 || d.getFullYear() > 2100) {
        return c.json(
          {
            error: "Invalid since parameter: expected ISO 8601 timestamp or unix epoch",
          },
          400
        );
      }
      validatedSince = d.toISOString();
    }

    try {
      let history = await getFundingHistorySince(slab, validatedSince);

      // Enforce row cap
      if (history.length > limit) {
        history = history.slice(0, limit);
      }

      return c.json({
        slabAddress: slab,
        since: validatedSince,
        count: history.length,
        history: history.map((h) => ({
          timestamp: h.timestamp,
          slot: h.slot,
          rateBpsPerSlot: h.rate_bps_per_slot,
          netLpPos: h.net_lp_pos,
          priceE6: h.price_e6,
          fundingIndexQpbE6: h.funding_index_qpb_e6,
        })),
      });
    } catch (err) {
      logger.error("Error fetching funding historySince", {
        slab,
        since: validatedSince,
        error: truncateErrorMessage(
          err instanceof Error ? err.message : String(err),
          120
        ),
      });
      return c.json(
        {
          error: "Failed to fetch funding history",
          ...(process.env.NODE_ENV !== "production" && {
            details: truncateErrorMessage(
              err instanceof Error ? err.message : String(err),
              200
            ),
          }),
        },
        500
      );
    }
  });

  /**
   * GET /funding/:slab/history
   * 
   * Returns historical funding rate data with optional time range.
   * Query params:
   * - limit: number of records (default 100, max 1000)
   * - since: ISO timestamp (default: 24h ago)
   */
  app.get("/funding/:slab/history", validateSlab, async (c) => {
    const slab = c.req.param("slab");
    if (!slab) return c.json({ error: "slab required" }, 400);
    const limitParam = c.req.query("limit");
    const sinceParam = c.req.query("since");

    // PERC-8178: Cap row limit at 500 regardless of path
    const MAX_ROWS = 500;

    try {
      let history;
      const parsedHistLimit = limitParam ? parseInt(limitParam, 10) : 100;
      const limit = (Number.isNaN(parsedHistLimit) || parsedHistLimit <= 0)
        ? 100
        : Math.min(parsedHistLimit, MAX_ROWS);

      if (sinceParam) {
        // PERC-8178: Validate sinceParam as ISO 8601 timestamp or unix epoch (seconds/ms)
        let validatedSince: string;
        const epochNum = Number(sinceParam);
        if (!Number.isNaN(epochNum) && epochNum > 0) {
          // Unix epoch — treat >1e12 as milliseconds, otherwise seconds
          const ms = epochNum > 1e12 ? epochNum : epochNum * 1000;
          const d = new Date(ms);
          if (Number.isNaN(d.getTime()) || d.getFullYear() < 2020 || d.getFullYear() > 2100) {
            return c.json({ error: "Invalid since parameter: epoch out of range" }, 400);
          }
          validatedSince = d.toISOString();
        } else {
          // Try ISO 8601 parse
          const d = new Date(sinceParam);
          if (Number.isNaN(d.getTime()) || d.getFullYear() < 2020 || d.getFullYear() > 2100) {
            return c.json({ error: "Invalid since parameter: expected ISO 8601 timestamp or unix epoch" }, 400);
          }
          validatedSince = d.toISOString();
        }
        history = await getFundingHistorySince(slab, validatedSince);
        // PERC-8178: Enforce row cap on since-based queries
        if (history.length > MAX_ROWS) {
          history = history.slice(0, MAX_ROWS);
        }
      } else {
        history = await getFundingHistory(slab, limit);
      }

      return c.json({
        slabAddress: slab,
        count: history.length,
        history: history.map((h) => ({
          timestamp: h.timestamp,
          slot: h.slot,
          rateBpsPerSlot: h.rate_bps_per_slot,
          netLpPos: h.net_lp_pos,
          priceE6: h.price_e6,
          fundingIndexQpbE6: h.funding_index_qpb_e6,
        })),
      });
    } catch (err) {
      logger.error("Error fetching funding history", { slab, error: truncateErrorMessage(err instanceof Error ? err.message : String(err), 120) });
      return c.json({ 
        error: "Failed to fetch funding history",
        ...(process.env.NODE_ENV !== "production" && { details: truncateErrorMessage(err instanceof Error ? err.message : String(err), 200) })
      }, 500);
    }
  });

  return app;
}
