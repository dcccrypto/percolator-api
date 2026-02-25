/**
 * Open Interest API Routes
 * 
 * Exposes open interest data for markets:
 * - Total open interest
 * - Net LP position
 * - LP sum/max absolute values
 * - Historical OI data
 */
import { Hono } from "hono";
import { validateSlab } from "../middleware/validateSlab.js";
import { cacheMiddleware } from "../middleware/cache.js";
import { getSupabase, createLogger } from "@percolator/shared";

const logger = createLogger("api:open-interest");

export function openInterestRoutes(): Hono {
  const app = new Hono();

  /**
   * GET /open-interest/:slab — 15s cache
   * 
   * Returns current open interest data and historical records for a market.
   * 
   * Response format:
   * {
   *   "slabAddress": "...",
   *   "totalOpenInterest": "5000000000",
   *   "netLpPos": "1500000",
   *   "lpSumAbs": "2000000",
   *   "lpMaxAbs": "500000",
   *   "history": [
   *     { "timestamp": "2025-02-14T12:00:00Z", "totalOi": "4800000000", "netLpPos": "1400000" }
   *   ]
   * }
   */
  app.get("/open-interest/:slab", cacheMiddleware(15), validateSlab, async (c) => {
    const slab = c.req.param("slab");

    try {
      // Fetch current OI data from market_stats
      const { data: stats, error: statsError } = await getSupabase()
        .from("market_stats")
        .select("total_open_interest, net_lp_pos, lp_sum_abs, lp_max_abs")
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

      // Fetch historical OI data
      const { data: history, error: historyError } = await getSupabase()
        .from("oi_history")
        .select("timestamp, total_oi, net_lp_pos")
        .eq("market_slab", slab)
        .order("timestamp", { ascending: false })
        .limit(100);

      if (historyError) {
        throw historyError;
      }

      return c.json({
        slabAddress: slab,
        totalOpenInterest: stats.total_open_interest ?? "0",
        netLpPos: stats.net_lp_pos ?? "0",
        lpSumAbs: stats.lp_sum_abs ?? "0",
        lpMaxAbs: stats.lp_max_abs ?? "0",
        history: (history ?? []).map((h) => ({
          timestamp: h.timestamp,
          totalOi: h.total_oi,
          netLpPos: h.net_lp_pos,
        })),
      });
    } catch (err) {
      logger.error("Error fetching OI data", { slab, error: err });
      return c.json({ 
        error: "Failed to fetch open interest data",
        ...(process.env.NODE_ENV !== "production" && { details: err instanceof Error ? err.message : String(err) })
      }, 500);
    }
  });

  return app;
}
