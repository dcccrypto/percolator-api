import { Hono } from "hono";
import { getSupabase, getNetwork, createLogger, truncateErrorMessage } from "@percolator/shared";
import { validateSlab, isBlockedSlab } from "../middleware/validateSlab.js";

const logger = createLogger("api:prices");

export function priceRoutes(): Hono {
  const app = new Hono();

  app.get("/prices/markets", async (c) => {
    try {
      const { data, error } = await getSupabase()
        .from("markets_with_stats")
        .select("slab_address, last_price, mark_price, index_price, updated_at")
        .eq("network", getNetwork())
        .not("slab_address", "is", null);
      if (error) throw error;
      const filtered = (data ?? []).filter((m) => !isBlockedSlab(m.slab_address));
      return c.json({ markets: filtered });
    } catch (err) {
      logger.error("Error fetching market prices", {
        error: truncateErrorMessage(err instanceof Error ? err.message : String(err), 120),
      });
      return c.json({ error: "Failed to fetch prices" }, 500);
    }
  });

  app.get("/prices/:slab", validateSlab, async (c) => {
    const slab = c.req.param("slab");
    try {
      // Return prices in ascending order (oldest→newest) so the chart component
      // can feed them directly into lightweight-charts setData(), which requires
      // strictly ascending timestamps. Previously returned DESC (newest first) which
      // caused aggregateCandles to produce DESC-ordered candles → lwc silently failed.
      //
      // Limit raised from 100 → 1500: at the 2-min indexer cadence, 100 rows covers
      // only ~3.3 hours — insufficient for the "1d" and "4h" chart timeframes.
      // 1500 rows = ~50 hours of history at 2-min intervals (covers any visible timeframe).
      const { data, error } = await getSupabase()
        .from("oracle_prices")
        .select("*")
        .eq("slab_address", slab)
        .order("timestamp", { ascending: true })
        .limit(1500);
      if (error) throw error;
      return c.json({ prices: data ?? [] });
    } catch (err) {
      logger.error("Error fetching price history", {
        slab,
        error: truncateErrorMessage(err instanceof Error ? err.message : String(err), 120),
      });
      return c.json({ error: "Failed to fetch price history" }, 500);
    }
  });

  return app;
}
