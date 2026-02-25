import { Hono } from "hono";
import { 
  getRecentTrades, 
  get24hVolume, 
  getGlobalRecentTrades, 
  getPriceHistory, 
  createLogger,
  sanitizeSlabAddress,
  sanitizePagination,
  sanitizeNumber
} from "@percolator/shared";

const logger = createLogger("api:trades");

export function tradeRoutes(): Hono {
  const app = new Hono();

  /** Recent trades for a specific market */
  app.get("/markets/:slab/trades", async (c) => {
    const slab = sanitizeSlabAddress(c.req.param("slab"));
    if (!slab) {
      return c.json({ error: "Invalid slab address" }, 400);
    }
    
    const { limit } = sanitizePagination(c.req.query("limit"), 0);
    const safeLimit = Math.min(limit, 200); // Cap at 200

    try {
      const trades = await getRecentTrades(slab, safeLimit);
      return c.json({ trades });
    } catch (err) {
      logger.error("Error fetching trades", { error: err instanceof Error ? err.message : err });
      return c.json({ error: "Failed to fetch trades" }, 500);
    }
  });

  /** 24h volume for a specific market */
  app.get("/markets/:slab/volume", async (c) => {
    const slab = sanitizeSlabAddress(c.req.param("slab"));
    if (!slab) {
      return c.json({ error: "Invalid slab address" }, 400);
    }

    try {
      const { volume, tradeCount } = await get24hVolume(slab);
      return c.json({ slab_address: slab, volume_24h: volume, trade_count_24h: tradeCount });
    } catch (err) {
      logger.error("Error fetching volume", { error: err instanceof Error ? err.message : err });
      return c.json({ error: "Failed to fetch volume" }, 500);
    }
  });

  /** Price history for a specific market (for charts) */
  app.get("/markets/:slab/prices", async (c) => {
    const slab = sanitizeSlabAddress(c.req.param("slab"));
    if (!slab) {
      return c.json({ error: "Invalid slab address" }, 400);
    }

    // Default to 24h of price history
    const hoursBack = sanitizeNumber(c.req.query("hours"), 1, 720) ?? 24; // max 30 days
    const sinceEpoch = Math.floor((Date.now() - hoursBack * 60 * 60 * 1000) / 1000);

    try {
      const prices = await getPriceHistory(slab, sinceEpoch);
      return c.json({
        slab_address: slab,
        prices: prices.map((p) => ({
          price: Number(p.price_e6) / 1_000_000,
          price_e6: p.price_e6,
          timestamp: p.timestamp,
        })),
      });
    } catch (err) {
      logger.error("Error fetching price history", { error: err instanceof Error ? err.message : err });
      return c.json({ error: "Failed to fetch price history" }, 500);
    }
  });

  /** Global recent trades across all markets */
  app.get("/trades/recent", async (c) => {
    const { limit } = sanitizePagination(c.req.query("limit"), 0);
    const safeLimit = Math.min(limit, 200); // Cap at 200

    try {
      const trades = await getGlobalRecentTrades(safeLimit);
      return c.json({ trades });
    } catch (err) {
      logger.error("Error fetching global trades", { error: err instanceof Error ? err.message : err });
      return c.json({ error: "Failed to fetch trades" }, 500);
    }
  });

  return app;
}
