/**
 * Platform Stats API Routes
 * 
 * Exposes platform-wide aggregated statistics:
 * - Total markets count
 * - Aggregate 24h volume
 * - Total open interest across all markets
 * - Unique deployers count
 * - 24h trade count
 */
import { Hono } from "hono";
import { getSupabase, createLogger } from "@percolator/shared";

const logger = createLogger("api:stats");

export function statsRoutes(): Hono {
  const app = new Hono();

  /**
   * GET /stats
   * 
   * Returns platform-wide aggregated statistics.
   * 
   * Response format:
   * {
   *   "totalMarkets": 10,
   *   "volume24h": "1000000000",
   *   "totalOpenInterest": "5000000000",
   *   "uniqueDeployers": 5,
   *   "trades24h": 1250
   * }
   */
  app.get("/stats", async (c) => {
    try {
      // Count total markets
      const { count: marketsCount, error: marketsError } = await getSupabase()
        .from("markets")
        .select("*", { count: "exact", head: true });

      if (marketsError) throw marketsError;

      // Aggregate stats from market_stats
      const { data: stats, error: statsError } = await getSupabase()
        .from("market_stats")
        .select("volume_24h, total_open_interest");

      if (statsError) throw statsError;

      const volume24h = (stats ?? []).reduce((sum, s) => sum + BigInt(s.volume_24h ?? "0"), BigInt(0));
      const totalOI = (stats ?? []).reduce((sum, s) => sum + BigInt(s.total_open_interest ?? "0"), BigInt(0));

      // Count unique deployers
      const { data: deployers, error: deployersError } = await getSupabase()
        .from("markets")
        .select("deployer");

      if (deployersError) throw deployersError;

      const uniqueDeployers = new Set((deployers ?? []).map((d) => d.deployer)).size;

      // Count 24h trades
      const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const { count: trades24h, error: tradesError } = await getSupabase()
        .from("trades")
        .select("*", { count: "exact", head: true })
        .gte("timestamp", since24h);

      if (tradesError) throw tradesError;

      return c.json({
        totalMarkets: marketsCount ?? 0,
        volume24h: volume24h.toString(),
        totalOpenInterest: totalOI.toString(),
        uniqueDeployers,
        trades24h: trades24h ?? 0,
      });
    } catch (err) {
      logger.error("Error fetching platform stats", { error: err });
      return c.json({ 
        error: "Failed to fetch platform statistics",
        ...(process.env.NODE_ENV !== "production" && { details: err instanceof Error ? err.message : String(err) })
      }, 500);
    }
  });

  return app;
}
