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
import { getSupabase, getNetwork, createLogger, truncateErrorMessage } from "@percolator/shared";
import { withDbCacheFallback } from "../middleware/db-cache-fallback.js";

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
    const result = await withDbCacheFallback(
      "stats:platform",
      async () => {
        const network = getNetwork();

        // Count total markets — filter by network to prevent devnet/mainnet mixing (PERC-8192)
        const { count: marketsCount, error: marketsError } = await getSupabase()
          .from("markets")
          .select("*", { count: "exact", head: true })
          .eq("network", network);

        if (marketsError) throw marketsError;

        // Aggregate stats from markets_with_stats view — filter by network to
        // prevent cross-network volume/OI inflation in shared DB deployments.
        const { data: stats, error: statsError } = await getSupabase()
          .from("markets_with_stats")
          .select("volume_24h, total_open_interest")
          .eq("network", network)
          .not("slab_address", "is", null);

        if (statsError) throw statsError;

        const safeBigInt = (val: unknown): bigint => {
          try { return BigInt(val as string); } catch { return 0n; }
        };
        const volume24h = (stats ?? []).reduce((sum, s) => sum + safeBigInt(s.volume_24h ?? "0"), 0n);
        const totalOI = (stats ?? []).reduce((sum, s) => sum + safeBigInt(s.total_open_interest ?? "0"), 0n);

        // Count unique deployers — filter by network
        const { data: deployers, error: deployersError } = await getSupabase()
          .from("markets")
          .select("deployer")
          .eq("network", network);

        if (deployersError) throw deployersError;

        const uniqueDeployers = new Set((deployers ?? []).map((d) => d.deployer)).size;

        // Count 24h trades — filter by network
        // NOTE: trades table uses `created_at` (TIMESTAMPTZ), not `timestamp`.
        // The `timestamp` column exists only on oracle_prices/funding_history/oi_history.
        const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        const { count: trades24h, error: tradesError } = await getSupabase()
          .from("trades")
          .select("*", { count: "exact", head: true })
          .eq("network", network)
          .gte("created_at", since24h);

        if (tradesError) throw tradesError;

        return {
          totalMarkets: marketsCount ?? 0,
          volume24h: volume24h.toString(),
          totalOpenInterest: totalOI.toString(),
          uniqueDeployers,
          trades24h: trades24h ?? 0,
        };
      },
      c
    );

    if (result instanceof Response) {
      return result;
    }

    return c.json(result);
  });

  return app;
}
