/**
 * Candles API Route — internal Percolator OHLCV from the `trades` table.
 *
 * GET /candles/:slab?resolution=1&from=<unix_s>&to=<unix_s>
 *
 * Response shape follows TradingView UDF (same as Pyth Benchmarks proxy so the
 * frontend can swap data source without changing parsing):
 *
 *   { s: "ok"|"no_data", t: number[], o: number[], h: number[], l: number[], c: number[], v: number[] }
 *
 * Timestamps are Unix seconds (UDF convention). Resolution maps to minutes,
 * except "1D" which buckets into days.
 *
 * Implementation: fetches raw trades in the requested range, buckets them
 * in-process. Works on plain Postgres; when Variant B of migration
 * 20260420_candle_support.sql is applied (TimescaleDB continuous aggregates),
 * this can be upgraded to query the candles_* materialized views directly.
 */
import { Hono } from "hono";
import { getSupabase, getNetwork, createLogger, truncateErrorMessage } from "@percolator/shared";
import { validateSlab } from "../middleware/validateSlab.js";

const logger = createLogger("api:candles");

const RES_TO_SECONDS: Record<string, number> = {
  "1": 60,
  "5": 5 * 60,
  "15": 15 * 60,
  "60": 60 * 60,
  "240": 4 * 60 * 60,
  "1D": 24 * 60 * 60,
};

const MAX_BARS = 5000;

interface UdfResponse {
  s: "ok" | "no_data" | "error";
  t: number[];
  o: number[];
  h: number[];
  l: number[];
  c: number[];
  v: number[];
}

function emptyResponse(status: "no_data" | "error"): UdfResponse {
  return { s: status, t: [], o: [], h: [], l: [], c: [], v: [] };
}

interface TradeRow {
  price: number;
  size: number | string;
  created_at: string;
}

/** Bucket raw trades into OHLCV candles. Input must be in ascending `created_at` order. */
export function bucketCandles(trades: TradeRow[], bucketSeconds: number): UdfResponse {
  if (trades.length === 0) return emptyResponse("no_data");
  const bars = new Map<number, { o: number; h: number; l: number; c: number; v: number }>();

  for (const t of trades) {
    const ts = Math.floor(new Date(t.created_at).getTime() / 1000);
    const bucket = Math.floor(ts / bucketSeconds) * bucketSeconds;
    const price = Number(t.price);
    const size = Math.abs(Number(t.size));
    if (!Number.isFinite(price) || !Number.isFinite(size)) continue;

    const existing = bars.get(bucket);
    if (!existing) {
      bars.set(bucket, { o: price, h: price, l: price, c: price, v: size });
    } else {
      if (price > existing.h) existing.h = price;
      if (price < existing.l) existing.l = price;
      existing.c = price;
      existing.v += size;
    }
  }

  const sortedKeys = [...bars.keys()].sort((a, b) => a - b);
  const out: UdfResponse = { s: "ok", t: [], o: [], h: [], l: [], c: [], v: [] };
  for (const k of sortedKeys) {
    const b = bars.get(k)!;
    out.t.push(k);
    out.o.push(b.o);
    out.h.push(b.h);
    out.l.push(b.l);
    out.c.push(b.c);
    out.v.push(b.v);
  }
  return out;
}

export function candleRoutes(): Hono {
  const app = new Hono();

  app.get("/candles/:slab", validateSlab, async (c) => {
    const slab = c.req.param("slab");
    const resolution = c.req.query("resolution") ?? "1";
    const fromSec = parseInt(c.req.query("from") ?? "0", 10);
    const toSec = parseInt(c.req.query("to") ?? String(Math.floor(Date.now() / 1000)), 10);

    const bucketSeconds = RES_TO_SECONDS[resolution];
    if (!bucketSeconds) {
      return c.json({ s: "error", errmsg: `Unsupported resolution '${resolution}'` }, 400);
    }
    if (!Number.isFinite(fromSec) || !Number.isFinite(toSec) || toSec <= fromSec) {
      return c.json({ s: "error", errmsg: "Invalid from/to" }, 400);
    }

    try {
      const { data, error } = await getSupabase()
        .from("trades")
        .select("price, size, created_at")
        .eq("slab_address", slab)
        .eq("network", getNetwork())
        .gte("created_at", new Date(fromSec * 1000).toISOString())
        .lte("created_at", new Date(toSec * 1000).toISOString())
        .order("created_at", { ascending: true })
        .limit(MAX_BARS * 10);
      if (error) throw error;
      const bars = bucketCandles((data ?? []) as TradeRow[], bucketSeconds);
      return c.json(bars);
    } catch (err) {
      logger.error("Candles query failed", {
        slab,
        resolution,
        error: truncateErrorMessage(err instanceof Error ? err.message : String(err), 120),
      });
      return c.json(emptyResponse("error"), 500);
    }
  });

  return app;
}
