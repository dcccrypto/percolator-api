import { Hono } from "hono";
import { PublicKey } from "@solana/web3.js";
import { resolvePrice, type PriceRouterResult } from "@percolatorct/sdk";
import { createLogger } from "@percolator/shared";

const logger = createLogger("api:oracle-router");

// Simple in-memory cache: mint → { result, expiresAt }
const cache = new Map<string, { result: PriceRouterResult; expiresAt: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_CACHE_SIZE = 500;

export function oracleRouterRoutes(): Hono {
  const app = new Hono();

  // GET /oracle/resolve/:mint — returns ranked oracle sources for a given token
  app.get("/oracle/resolve/:mint", async (c) => {
    const mint = c.req.param("mint");

    // GH#1667: Validate mint by decoding via PublicKey — catches non-base58
    // and non-32-byte inputs without relying on string-length heuristics.
    if (!mint) {
      return c.json({ error: "Invalid mint address" }, 400);
    }
    try {
      new PublicKey(mint);
    } catch {
      return c.json({ error: "Invalid mint address" }, 400);
    }

    // Evict expired entries on every read
    const now = Date.now();
    for (const [key, entry] of cache) {
      if (now >= entry.expiresAt) cache.delete(key);
    }

    // Check cache — promote to most-recently-used on hit
    const cached = cache.get(mint);
    if (cached && now < cached.expiresAt) {
      cache.delete(mint);
      cache.set(mint, cached);
      return c.json({ ...cached.result, cached: true });
    }

    try {
      const result = await resolvePrice(mint, AbortSignal.timeout(10_000));

      // Cache the result (with max size enforcement)
      if (cache.size >= MAX_CACHE_SIZE) {
        // Delete oldest entry
        const oldestKey = cache.keys().next().value;
        if (oldestKey) cache.delete(oldestKey);
      }
      cache.set(mint, { result, expiresAt: Date.now() + CACHE_TTL_MS });

      return c.json({ ...result, cached: false });
    } catch (err: any) {
      const detail = err instanceof Error ? err.message : String(err);
      logger.error("Oracle resolve error", { detail, path: c.req.path });
      return c.json({ error: "Failed to resolve oracle sources" }, 500);
    }
  });

  return app;
}
