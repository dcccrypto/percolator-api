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
import { 
  getFundingHistory, 
  getFundingHistorySince,
  getMarketBySlabAddress,
  getSupabase,
  createLogger,
} from "@percolator/shared";

const logger = createLogger("api:funding");

export function fundingRoutes(): Hono {
  const app = new Hono();

  /**
   * GET /funding/global
   * 
   * Returns current funding rates for all markets.
   * NOTE: This must come BEFORE /funding/:slab to avoid :slab matching "global"
   */
  app.get("/funding/global", async (c) => {
    try {
      let allStats: { slab_address: string; funding_rate: number | null; net_lp_pos: string | null }[] | null = null;
      try {
        const result = await getSupabase()
          .from("market_stats")
          .select("slab_address, funding_rate, net_lp_pos");
        if (result.error) throw result.error;
        allStats = result.data;
      } catch (fetchErr) {
        logger.warn("global market_stats fetch failed, returning empty", { error: fetchErr instanceof Error ? fetchErr.message : String(fetchErr) });
        return c.json({ count: 0, markets: [], degraded: true });
      }

      const SLOTS_PER_HOUR = 9000;
      const SLOTS_PER_DAY = 216000;
      const MAX_FUNDING_BPS = 10_000;

      const markets = (allStats ?? []).map((stats) => {
        const rawBps = Number(stats.funding_rate ?? 0);
        const rateBps = Number.isFinite(rawBps) && Math.abs(rawBps) <= MAX_FUNDING_BPS
          ? rawBps
          : 0;
        return {
          slabAddress: stats.slab_address,
          currentRateBpsPerSlot: rateBps,
          hourlyRatePercent: Number(((rateBps / 10000.0) * SLOTS_PER_HOUR).toFixed(6)),
          dailyRatePercent: Number(((rateBps / 10000.0) * SLOTS_PER_DAY).toFixed(4)),
          netLpPosition: stats.net_lp_pos ?? "0",
        };
      });

      return c.json({
        count: markets.length,
        markets,
      });
    } catch (err) {
      logger.error("Error fetching global funding data", { error: err });
      return c.json({ 
        error: "Failed to fetch global funding data",
        ...(process.env.NODE_ENV !== "production" && { details: err instanceof Error ? err.message : String(err) })
      }, 500);
    }
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

    try {
      // GH-1611: Check that the slab exists in the markets table before querying.
      // Zombie slabs (e.g. 3bmCyP, 3YDqCJ, 3ZKKwsk) pass format validation but have
      // no row in `markets` — querying market_stats or funding_history for them triggers
      // Supabase errors that bubbled up as 500s. Return 404 instead.
      // GH#1511: Store the market row (not just existence) so we can populate metadata.symbol.
      let market: Awaited<ReturnType<typeof getMarketBySlabAddress>> = null;
      let marketExists: boolean | null = null;
      try {
        market = await getMarketBySlabAddress(slab);
        marketExists = market !== null;
      } catch (marketCheckErr) {
        // If the existence check itself fails (e.g. transient DB error), log and fall
        // through — do not 500 out. The market_stats query below will handle it gracefully.
        logger.warn("markets existence check failed, continuing", {
          slab,
          error: marketCheckErr instanceof Error ? marketCheckErr.message : String(marketCheckErr),
        });
      }

      if (marketExists === false) {
        return c.json({ error: "Market not found" }, 404);
      }

      // Fetch current funding rate from market_stats.
      // Use maybeSingle() so PostgREST returns null (not an error) when zero rows found,
      // avoiding PGRST116 edge-cases that differ across PostgREST versions.
      // Wrapped in its own try/catch so network-level fetch failures (ConnectTimeoutError,
      // DNS failures) degrade gracefully instead of bubbling to the outer 500 handler.
      // GH#1511: Also select last_price to populate metadata.last_price.
      let stats: { funding_rate: number | null; net_lp_pos: string | null; last_price: number | null } | null = null;
      let statsError: { code?: string; message?: string } | null = null;
      try {
        const result = await getSupabase()
          .from("market_stats")
          .select("funding_rate, net_lp_pos, last_price")
          .eq("slab_address", slab)
          .maybeSingle();
        stats = result.data;
        statsError = result.error;
      } catch (fetchErr) {
        logger.warn("market_stats fetch failed (network error), returning defaults", { slab, error: fetchErr instanceof Error ? fetchErr.message : String(fetchErr) });
        statsError = { message: fetchErr instanceof Error ? fetchErr.message : "network error" };
      }

      if (statsError) {
        // Any DB error fetching market stats — log and fall through to defaults.
        // This guards against transient PostgREST schema-cache reloads (e.g. after
        // migration NOTIFY pgrst) that may return unexpected error codes.
        logger.warn("market_stats query error, returning defaults", { slab, code: statsError.code, message: statsError.message });
      }

      if (!stats || statsError) {
        // Return default zeroed data instead of 404 — market exists but hasn't been cranked yet.
        // This prevents console error floods from frontend polling.
        return c.json({
          slabAddress: slab,
          currentRateBpsPerSlot: 0,
          hourlyRatePercent: 0,
          dailyRatePercent: 0,
          annualizedPercent: 0,
          netLpPosition: "0",
          last24hHistory: [],
          metadata: {
            // GH#1511: Populate symbol from markets row (already fetched above).
            symbol: market?.symbol ?? null,
            last_price: null,
            dataPoints24h: 0,
            note: "Market has not been cranked yet — funding data will appear after first crank.",
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

      // Sanitize: the on-chain Rust engine clamps funding_rate to [-10_000, 10_000] bps/slot.
      // Values outside this range are garbage (wrong-offset reads on old devnet slabs or
      // uninitialized markets stored in DB before the guard was applied).
      // Treat them as 0 — matches the sanitizeFundingRateBps() guard in the frontend.
      const MAX_FUNDING_BPS = 10_000;
      const rawBps = Number(currentRateBpsPerSlot);
      const rateBps = Number.isFinite(rawBps) && Math.abs(rawBps) <= MAX_FUNDING_BPS
        ? rawBps
        : 0;
      const hourlyRatePercent = (rateBps / 10000.0) * SLOTS_PER_HOUR;
      const dailyRatePercent = (rateBps / 10000.0) * SLOTS_PER_DAY;
      const annualizedPercent = (rateBps / 10000.0) * SLOTS_PER_YEAR;

      // GH#1511: Sanitize last_price (same ceiling guard as frontend).
      const MAX_PRICE_E6 = 1e15; // 1 billion USD in E6 — anything above is sentinel garbage
      const rawLastPrice = Number(stats.last_price ?? 0);
      const sanitizedLastPrice = Number.isFinite(rawLastPrice) && rawLastPrice > 0 && rawLastPrice < MAX_PRICE_E6
        ? rawLastPrice
        : null;

      // Fetch 24h funding history — non-fatal. If the funding_history table is
      // unavailable (e.g. schema cache reload, new slab not yet indexed, or transient
      // DB error), we still return the current rate; we just omit the history array.
      const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      let history: Awaited<ReturnType<typeof getFundingHistorySince>> = [];
      try {
        history = await getFundingHistorySince(slab, since24h);
      } catch (historyErr) {
        logger.warn("funding_history query failed, returning empty history", { slab, error: historyErr });
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

      return c.json({
        slabAddress: slab,
        currentRateBpsPerSlot: rateBps,
        hourlyRatePercent: Number(hourlyRatePercent.toFixed(6)),
        dailyRatePercent: Number(dailyRatePercent.toFixed(4)),
        annualizedPercent: Number(annualizedPercent.toFixed(2)),
        netLpPosition,
        last24hHistory,
        metadata: {
          // GH#1511: Populate symbol and last_price from market row / market_stats.
          // symbol comes from markets table (getMarketBySlabAddress).
          // last_price comes from market_stats (added to select above).
          symbol: market?.symbol ?? null,
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
      logger.error("Error fetching funding data", { slab, error: err });
      return c.json({ 
        error: "Failed to fetch funding data",
        ...(process.env.NODE_ENV !== "production" && { details: err instanceof Error ? err.message : String(err) })
      }, 500);
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
    const limitParam = c.req.query("limit");
    const sinceParam = c.req.query("since");

    try {
      // GH-1611: Same zombie-slab existence check as /funding/:slab.
      let marketExists: boolean | null = null;
      try {
        const market = await getMarketBySlabAddress(slab);
        marketExists = market !== null;
      } catch (marketCheckErr) {
        logger.warn("markets existence check failed on /history, continuing", {
          slab,
          error: marketCheckErr instanceof Error ? marketCheckErr.message : String(marketCheckErr),
        });
      }

      if (marketExists === false) {
        return c.json({ error: "Market not found" }, 404);
      }

      let history: Awaited<ReturnType<typeof getFundingHistorySince>> = [];
      const limit = limitParam ? Math.min(parseInt(limitParam, 10), 1000) : 100;

      try {
        if (sinceParam) {
          history = await getFundingHistorySince(slab, sinceParam);
        } else {
          history = await getFundingHistory(slab, limit);
        }
      } catch (historyErr) {
        // Non-fatal: transient DB errors (e.g. schema-cache reload, connection blip) return
        // an empty history array so the client can still render — no 500 alarm.
        logger.warn("funding_history query failed on /funding/:slab/history, returning empty", {
          slab,
          error: historyErr,
        });
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
        ...(history.length === 0 && { degraded: true }),
      });
    } catch (err) {
      logger.error("Error fetching funding history", { slab, error: err });
      return c.json({ 
        error: "Failed to fetch funding history",
        ...(process.env.NODE_ENV !== "production" && { details: err instanceof Error ? err.message : String(err) })
      }, 500);
    }
  });

  return app;
}
