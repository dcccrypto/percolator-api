import { Hono } from "hono";
import { getSupabase, getNetwork, createLogger } from "@percolator/shared";
import { withDbCacheFallback } from "../middleware/db-cache-fallback.js";

const logger = createLogger("api:crank");

export function crankStatusRoutes(): Hono {
  const app = new Hono();

  app.get("/crank/status", async (c) => {
    const result = await withDbCacheFallback(
      "crank:status",
      async () => {
        // Select only columns that exist in the markets_with_stats view.
        // asset_index is NOT in the schema (no migration defines it) — selecting it
        // causes a PostgREST 400 which makes withDbCacheFallback return 503 on every call.
        // Per-asset crank tracking is not implemented in the data layer; remove the column.
        const { data, error } = await getSupabase()
          .from("markets_with_stats")
          .select("slab_address, last_crank_slot, updated_at")
          .eq("network", getNetwork())
          .not("slab_address", "is", null);
        if (error) throw error;
        return (data ?? []).map((row) => ({
          slabAddress: row.slab_address,
          lastCrankSlot: row.last_crank_slot ?? null,
          updatedAt: row.updated_at ?? null,
        }));
      },
      c
    );

    if (result instanceof Response) {
      return result;
    }

    return c.json({ markets: result.data, stale: result.stale });
  });

  return app;
}
