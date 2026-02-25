/**
 * Insurance Fund API Routes
 * 
 * Exposes insurance fund data for markets:
 * - Current insurance balance
 * - Insurance fee revenue
 * - Historical insurance data
 */
import { Hono } from "hono";
import { validateSlab } from "../middleware/validateSlab.js";
import { getSupabase, createLogger } from "@percolator/shared";

const logger = createLogger("api:insurance");

export function insuranceRoutes(): Hono {
  const app = new Hono();

  /**
   * GET /insurance/:slab
   * 
   * Returns current insurance fund data and historical records for a market.
   * 
   * Response format:
   * {
   *   "slabAddress": "...",
   *   "currentBalance": "1000000000",
   *   "feeRevenue": "50000000",
   *   "totalOpenInterest": "5000000000",
   *   "history": [
   *     { "timestamp": "2025-02-14T12:00:00Z", "balance": "950000000", "feeRevenue": "45000000" }
   *   ]
   * }
   */
  app.get("/insurance/:slab", validateSlab, async (c) => {
    const slab = c.req.param("slab");

    try {
      // Fetch current insurance data from market_stats
      const { data: stats, error: statsError } = await getSupabase()
        .from("market_stats")
        .select("insurance_balance, insurance_fee_revenue, total_open_interest")
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

      // Fetch historical insurance data
      const { data: history, error: historyError } = await getSupabase()
        .from("insurance_history")
        .select("timestamp, balance, fee_revenue")
        .eq("market_slab", slab)
        .order("timestamp", { ascending: false })
        .limit(100);

      if (historyError) {
        throw historyError;
      }

      return c.json({
        slabAddress: slab,
        currentBalance: stats.insurance_balance ?? "0",
        feeRevenue: stats.insurance_fee_revenue ?? "0",
        totalOpenInterest: stats.total_open_interest ?? "0",
        history: (history ?? []).map((h) => ({
          timestamp: h.timestamp,
          balance: h.balance,
          feeRevenue: h.fee_revenue,
        })),
      });
    } catch (err) {
      logger.error("Error fetching insurance data", { slab, error: err });
      return c.json({ 
        error: "Failed to fetch insurance data",
        ...(process.env.NODE_ENV !== "production" && { details: err instanceof Error ? err.message : String(err) })
      }, 500);
    }
  });

  return app;
}
