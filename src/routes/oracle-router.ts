import { Hono } from "hono";
import { PublicKey } from "@solana/web3.js";
import { resolvePrice, type PriceRouterResult } from "@percolatorct/sdk";
import { createLogger } from "@percolator/shared";

const logger = createLogger("api:oracle-router");

// Simple in-memory cache: mint → { result, expiresAt }
const cache = new Map<string, { result: PriceRouterResult; expiresAt: number }>();
// In-flight request coalescing: mint → pending resolvePrice promise. Used to
// prevent thundering-herd amplification when N concurrent requests miss cache
// for the same mint — only the first triggers an upstream call; the rest await
// the same promise.
const inflight = new Map<string, Promise<PriceRouterResult>>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
// How long an entry past its TTL may still be served as a stale-while-error
// fallback when the upstream oracle is unreachable. Bounded so we never serve
// dangerously-old prices, but generous enough to ride out a transient outage.
const MAX_STALE_AGE_MS = 15 * 60 * 1000; // 15 minutes past expiry
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

    // Evict entries only once they are beyond the stale-fallback window so
    // expired-but-still-usable entries survive long enough to back up the
    // catch path below if the upstream oracle is down.
    const now = Date.now();
    for (const [key, entry] of cache) {
      if (now >= entry.expiresAt + MAX_STALE_AGE_MS) cache.delete(key);
    }

    // Capture once: used both for the fresh-cache fast path and as a
    // potential stale fallback in the catch block.
    const cached = cache.get(mint);
    if (cached && now < cached.expiresAt) {
      // Fresh hit — promote to most-recently-used and return.
      cache.delete(mint);
      cache.set(mint, cached);
      return c.json({ ...cached.result, cached: true });
    }

    // Coalesce concurrent requests for the same mint: if a fetch is already
    // in flight, await the same promise instead of starting a new one. The
    // first request writes the cache and clears the inflight entry only after
    // the cache is populated, so a request arriving immediately afterwards
    // sees a fresh cache hit.
    let inFlightPromise = inflight.get(mint);
    if (!inFlightPromise) {
      inFlightPromise = resolvePrice(mint, AbortSignal.timeout(10_000))
        .then((result) => {
          if (cache.size >= MAX_CACHE_SIZE) {
            const oldestKey = cache.keys().next().value;
            if (oldestKey) cache.delete(oldestKey);
          }
          cache.set(mint, { result, expiresAt: Date.now() + CACHE_TTL_MS });
          inflight.delete(mint);
          return result;
        })
        .catch((err) => {
          inflight.delete(mint);
          throw err;
        });
      inflight.set(mint, inFlightPromise);
    }

    try {
      const result = await inFlightPromise;
      return c.json({ ...result, cached: false });
    } catch (err: any) {
      const detail = err instanceof Error ? err.message : String(err);
      logger.error("Oracle resolve error", { detail, path: c.req.path });

      // Stale-while-error fallback: if we have an expired entry that is still
      // within MAX_STALE_AGE_MS, serve it with stale: true so consumers know
      // the data is degraded. Otherwise fall through to the original 500.
      if (cached && Date.now() < cached.expiresAt + MAX_STALE_AGE_MS) {
        logger.warn("Serving stale oracle cache after upstream error", {
          mint,
          stalenessMs: Date.now() - cached.expiresAt,
        });
        return c.json({ ...cached.result, cached: true, stale: true });
      }

      return c.json({ error: "Failed to resolve oracle sources" }, 500);
    }
  });

  return app;
}
