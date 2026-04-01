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
import { getSupabase, createLogger, truncateErrorMessage } from "@percolator/shared";

/**
 * GH#1458: Phantom OI guard for history records.
 *
 * Pre-migration data in oi_history can contain astronomically large values
 * (e.g. 9.87e+34) from uninitialized on-chain state. These corrupt OI charts
 * for active markets (usdEkK5G, MOLTBOT). Filter them before returning history.
 *
 * Threshold: any total_oi or net_lp_pos value >= 1e18 (> max plausible micro-units
 * for any real market at any token price) is considered phantom and excluded.
 */
const MAX_SANE_OI_RAW = 1e18;

function isPhantomOiRecord(record: { total_oi: string | number | null; net_lp_pos: string | number | null }): boolean {
  const oi = Number(record.total_oi);
  const lp = Number(record.net_lp_pos);
  return (
    !Number.isFinite(oi) || Math.abs(oi) >= MAX_SANE_OI_RAW ||
    !Number.isFinite(lp) || Math.abs(lp) >= MAX_SANE_OI_RAW
  );
}

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

      // GH#1458: Filter phantom values from history before returning.
      // Pre-migration oi_history rows can contain values like 9.87e+34 from
      // uninitialized on-chain state — corrupts OI charts for active markets.
      const filteredHistory = (history ?? [])
        .filter((h) => !isPhantomOiRecord(h))
        .map((h) => ({
          timestamp: h.timestamp,
          totalOi: h.total_oi,
          netLpPos: h.net_lp_pos,
        }));

      return c.json({
        slabAddress: slab,
        totalOpenInterest: stats.total_open_interest ?? "0",
        netLpPos: stats.net_lp_pos ?? "0",
        lpSumAbs: stats.lp_sum_abs ?? "0",
        lpMaxAbs: stats.lp_max_abs ?? "0",
        history: filteredHistory,
      });
    } catch (err) {
      logger.error("Error fetching OI data", { slab, error: truncateErrorMessage(err instanceof Error ? err.message : String(err), 120) });
      return c.json({ 
        error: "Failed to fetch open interest data",
        ...(process.env.NODE_ENV !== "production" && { details: err instanceof Error ? err.message : String(err) })
      }, 500);
    }
  });

  return app;
}
