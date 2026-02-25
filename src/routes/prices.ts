import { Hono } from "hono";
import { getSupabase } from "@percolator/shared";
import { validateSlab } from "../middleware/validateSlab.js";

export function priceRoutes(): Hono {
  const app = new Hono();
  
  app.get("/prices/markets", async (c) => {
    const { data, error } = await getSupabase()
      .from("market_stats")
      .select("slab_address, last_price, mark_price, index_price, updated_at");
    if (error) return c.json({ error: "Failed to fetch prices" }, 500);
    return c.json({ markets: data ?? [] });
  });
  
  app.get("/prices/:slab", validateSlab, async (c) => {
    const slab = c.req.param("slab");
    const { data, error } = await getSupabase()
      .from("oracle_prices")
      .select("*")
      .eq("slab_address", slab)
      .order("timestamp", { ascending: false })
      .limit(100);
    if (error) return c.json({ error: "Failed to fetch price history" }, 500);
    return c.json({ prices: data ?? [] });
  });
  
  return app;
}
