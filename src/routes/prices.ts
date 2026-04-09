import { Hono } from "hono";
import { getSupabase, getNetwork, createLogger, truncateErrorMessage } from "@percolator/shared";
import { validateSlab } from "../middleware/validateSlab.js";

const logger = createLogger("api:prices");

export function priceRoutes(): Hono {
  const app = new Hono();

  // Sanity bound for USD-denominated prices, mirroring src/routes/markets.ts.
  // Bad rows in markets_with_stats / oracle_prices (negative, NaN, absurd) must
  // not reach the chart consumers — lightweight-charts silently fails on them.
  const MAX_SANE_PRICE_USD = 1_000_000_000;
  // price_e6 is the same value scaled by 1e6 (microUSD), so its bound is 1e15.
  const MAX_SANE_PRICE_E6 = MAX_SANE_PRICE_USD * 1_000_000;

  const sanitizeUsdPrice = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) && v > 0 && v <= MAX_SANE_PRICE_USD ? v : null;

  app.get("/prices/markets", async (c) => {
    try {
      const { data, error } = await getSupabase()
        .from("markets_with_stats")
        .select("slab_address, last_price, mark_price, index_price, updated_at")
        .eq("network", getNetwork())
        .not("slab_address", "is", null);
      if (error) throw error;
      const markets = (data ?? []).map((m) => ({
        slab_address: m.slab_address,
        last_price: sanitizeUsdPrice(m.last_price),
        mark_price: sanitizeUsdPrice(m.mark_price),
        index_price: sanitizeUsdPrice(m.index_price),
        updated_at: m.updated_at,
      }));
      return c.json({ markets });
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
      // Drop rows whose price_e6 is not a positive finite number within the
      // sanity bound. Charts feed this series straight to lightweight-charts'
      // setData(), which silently fails on a single corrupt row.
      const prices = (data ?? []).filter((p: { price_e6?: unknown }) => {
        const v = p.price_e6;
        return typeof v === "number" && Number.isFinite(v) && v > 0 && v <= MAX_SANE_PRICE_E6;
      });
      return c.json({ prices });
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
