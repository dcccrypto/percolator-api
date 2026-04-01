import { Hono } from "hono";
import { getSupabase, getNetwork, createLogger, truncateErrorMessage } from "@percolator/shared";

const logger = createLogger("api:crank");

export function crankStatusRoutes(): Hono {
  const app = new Hono();

  app.get("/crank/status", async (c) => {
    try {
      const { data, error } = await getSupabase()
        .from("markets_with_stats")
        .select("slab_address, last_crank_slot, updated_at")
        .eq("network", getNetwork())
        .not("slab_address", "is", null);
      if (error) throw error;
      return c.json({ markets: data ?? [] });
    } catch (err) {
      logger.error("Error fetching crank status", {
        error: truncateErrorMessage(err instanceof Error ? err.message : String(err), 120),
      });
      return c.json({ error: "Failed to fetch crank status" }, 500);
    }
  });

  return app;
}
