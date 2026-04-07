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
      if (ifNoneMatch && ifNoneMatch === cached.etag) {
        c.status(304);
        c.header("ETag", cached.etag);
        c.header("Cache-Control", `public, max-age=${ttlSeconds}`);
        c.header("Vary", "Accept-Encoding, Origin");
        return c.body(null);
      }
      
      c.status(200);
      c.header("Content-Type", cached.headers["Content-Type"] || "application/json");
      c.header("ETag", cached.etag);
      c.header("Cache-Control", `public, max-age=${ttlSeconds}`);
      c.header("Vary", "Accept-Encoding, Origin");
      c.header("X-Cache", "HIT");
      return c.body(cached.body);
    }
    
    // Cache miss - execute handler
    await next();
    
    // Only cache successful JSON responses
    if (c.res.status === 200 && c.res.headers.get("Content-Type")?.includes("application/json")) {
      try {
        const body = await c.res.clone().text();
        const contentType = c.res.headers.get("Content-Type") || "application/json";

        const entry = cache.set(cacheKey, body, { "Content-Type": contentType });

        c.header("ETag", entry.etag);
        c.header("Cache-Control", `public, max-age=${ttlSeconds}`);
        c.header("Vary", "Accept-Encoding, Origin");
        c.header("X-Cache", "MISS");
      } catch {
        // Cache failure is non-critical — response was already sent
      }
    }
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
