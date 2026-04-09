import { Hono } from "hono";
import { getSupabase, getNetwork, createLogger, truncateErrorMessage } from "@percolator/shared";
import { withDbCacheFallback } from "../middleware/db-cache-fallback.js";

const logger = createLogger("api:crank");

export function crankStatusRoutes(): Hono {
  const app = new Hono();

  app.get("/crank/status", async (c) => {
    const result = await withDbCacheFallback(
      "crank:status",
      async () => {
        const { data, error } = await getSupabase()
          .from("markets_with_stats")
          .select("slab_address, last_crank_slot, updated_at")
          .eq("network", getNetwork())
          .not("slab_address", "is", null);
        if (error) throw error;
        return data ?? [];
      },
      c
    );

    if (result instanceof Response) {
      return result;
    }

    return c.json({ markets: result });
  });

  return app;
}
