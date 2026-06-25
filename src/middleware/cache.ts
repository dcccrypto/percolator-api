/**
 * API Response Caching Middleware
 * 
 * In-memory cache with TTL support for read-heavy endpoints.
 * Implements Cache-Control, ETag, and If-None-Match (304) responses.
 */
import { createMiddleware } from "hono/factory";
import { createHash } from "node:crypto";

interface CacheEntry {
  body: string;
  etag: string;
  timestamp: number;
  headers: Record<string, string>;
}

const MAX_CACHE_ENTRIES = 500;

class ResponseCache {
  private cache = new Map<string, CacheEntry>();
  
  get(key: string, ttlSeconds: number): CacheEntry | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    
    const age = (Date.now() - entry.timestamp) / 1000;
    if (age > ttlSeconds) {
      this.cache.delete(key);
      return null;
    }

    // Move to end for LRU ordering (Map preserves insertion order)
    this.cache.delete(key);
    this.cache.set(key, entry);
    
    return entry;
  }
  
  set(key: string, body: string, headers: Record<string, string>): CacheEntry {
    // Evict least-recently-used entries when at capacity
    while (this.cache.size >= MAX_CACHE_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
      else break;
    }

    const etag = `"${createHash("md5").update(body).digest("hex")}"`;
    const entry: CacheEntry = {
      body,
      etag,
      timestamp: Date.now(),
      headers,
    };
    this.cache.set(key, entry);
    return entry;
  }
  
  clear(): void {
    this.cache.clear();
  }
  
  size(): number {
    return this.cache.size;
  }
}

const cache = new ResponseCache();

// In-flight request coalescing: cacheKey → pending "did the leader populate
// the cache" promise. Without this, N concurrent misses for the same key
// each independently run the full handler chain (often an RPC/DB call) and
// race to overwrite the cache with whichever happens to resolve last. Only
// the first ("leader") request actually calls next(); concurrent
// ("follower") requests await this promise and then replay the leader's
// cached entry via serveEntry() below instead of re-running next()
// themselves. Deleted only after settling (mirrors oracle-router.ts), so a
// request arriving immediately after resolution sees a normal cache hit.
const inflight = new Map<string, Promise<boolean>>();

function serveEntry(
  c: Parameters<Parameters<typeof createMiddleware>[0]>[0],
  entry: CacheEntry,
  ttlSeconds: number,
  ifNoneMatch: string | undefined,
  xCache: string,
) {
  if (ifNoneMatch && ifNoneMatch === entry.etag) {
    c.status(304);
    c.header("ETag", entry.etag);
    c.header("Cache-Control", `public, max-age=${ttlSeconds}`);
    c.header("Vary", "Accept-Encoding, Origin");
    return c.body(null);
  }

  c.status(200);
  c.header("Content-Type", entry.headers["Content-Type"] || "application/json");
  c.header("ETag", entry.etag);
  c.header("Cache-Control", `public, max-age=${ttlSeconds}`);
  c.header("Vary", "Accept-Encoding, Origin");
  c.header("X-Cache", xCache);
  return c.body(entry.body);
}

/**
 * Cache middleware factory with configurable TTL.
 *
 * @param ttlSeconds - Time-to-live for cached responses in seconds
 * @returns Hono middleware
 */
export function cacheMiddleware(ttlSeconds: number) {
  return createMiddleware(async (c, next) => {
    // Only cache GET requests
    if (c.req.method !== "GET") {
      return next();
    }

    // Cache key = path + sorted query string (prevents cache pollution via parameter reordering)
    const url = new URL(c.req.url);
    url.searchParams.sort();
    const cacheKey = url.pathname + (url.searchParams.size > 0 ? `?${url.searchParams.toString()}` : "");

    // Check If-None-Match header for conditional requests
    const ifNoneMatch = c.req.header("If-None-Match");

    // Try to get cached response
    const cached = cache.get(cacheKey, ttlSeconds);

    if (cached) {
      return serveEntry(c, cached, ttlSeconds, ifNoneMatch, "HIT");
    }

    // Cache miss. Coalesce concurrent misses for this key.
    let isLeader = false;
    let inFlightPromise = inflight.get(cacheKey);
    if (!inFlightPromise) {
      isLeader = true;
      inFlightPromise = (async (): Promise<boolean> => {
        await next();

        // Only cache successful JSON responses.
        if (c.res.status === 200 && c.res.headers.get("Content-Type")?.includes("application/json")) {
          try {
            const body = await c.res.clone().text();
            const contentType = c.res.headers.get("Content-Type") || "application/json";
            cache.set(cacheKey, body, { "Content-Type": contentType });
            return true;
          } catch {
            // Cache failure is non-critical — response was already sent.
            return false;
          }
        }
        return false;
      })().finally(() => inflight.delete(cacheKey));
      inflight.set(cacheKey, inFlightPromise);
    }

    if (isLeader) {
      // Propagates any error from next() exactly as before this change —
      // c.res is already populated by this request's own next() call.
      const wasCached = await inFlightPromise;
      if (wasCached) {
        const entry = cache.get(cacheKey, ttlSeconds);
        if (entry) {
          c.header("ETag", entry.etag);
          c.header("Cache-Control", `public, max-age=${ttlSeconds}`);
          c.header("Vary", "Accept-Encoding, Origin");
          c.header("X-Cache", "MISS");
        }
      }
      return;
    }

    // Follower — never called next() itself. Try to replay the leader's result.
    let wasCached: boolean;
    try {
      wasCached = await inFlightPromise;
    } catch {
      // The leader's handler threw. Every route this middleware guards is a
      // read-only GET handler with no side effects, so re-running next() for
      // this request is safe and gives it its own accurate error response
      // instead of inventing one.
      return next();
    }

    if (!wasCached) {
      // Leader's response wasn't cacheable (non-200 or non-JSON, e.g. an
      // error). Same reasoning as above — get our own accurate response.
      return next();
    }

    const entry = cache.get(cacheKey, ttlSeconds);
    if (!entry) {
      // Extremely unlikely (e.g. evicted the instant it was written under
      // heavy multi-key pressure) — fall back safely rather than guess.
      return next();
    }

    return serveEntry(c, entry, ttlSeconds, ifNoneMatch, "MISS-COALESCED");
  });
}

/**
 * Clear all cached responses (useful for testing or manual invalidation)
 */
export function clearCache(): void {
  cache.clear();
}

/**
 * Get cache statistics
 */
export function getCacheStats() {
  return {
    size: cache.size(),
    enabled: true,
  };
}
