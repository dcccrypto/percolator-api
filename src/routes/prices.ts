import { Hono } from "hono";
import { getSupabase, getNetwork, createLogger, truncateErrorMessage } from "@percolator/shared";
import { validateSlab } from "../middleware/validateSlab.js";

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
      return c.json({ markets: data ?? [] });
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
      const { data, error } = await getSupabase()
        .from("oracle_prices")
        .select("*")
        .eq("slab_address", slab)
        .order("timestamp", { ascending: false })
        .limit(100);
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
