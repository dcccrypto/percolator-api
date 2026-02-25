import { Hono } from "hono";
import { getSupabase } from "@percolator/shared";

export function crankStatusRoutes(): Hono {
  const app = new Hono();
  
  app.get("/crank/status", async (c) => {
    const { data, error } = await getSupabase()
      .from("market_stats")
      .select("slab_address, last_crank_slot, updated_at");
    if (error) return c.json({ error: "Failed to fetch crank status" }, 500);
    return c.json({ markets: data ?? [] });
  });
  
  return app;
}
