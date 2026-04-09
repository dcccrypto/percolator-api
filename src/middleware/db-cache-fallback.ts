/**
 * DB Cache Fallback Utility
 * 
 * When Supabase queries fail, serve stale cached data instead of 500 errors.
 * This improves availability during DB outages or network issues.
 */
import { createLogger, truncateErrorMessage } from "@percolator/shared";
import { Context } from "hono";

const logger = createLogger("api:db-cache-fallback");

interface CachedResponse {
  data: unknown;
  timestamp: number;
}

// Global cache for DB fallback (separate from HTTP response cache)
const dbCache = new Map<string, CachedResponse>();

// Maximum age for stale cache (1 hour)
const MAX_STALE_AGE_MS = 60 * 60 * 1000;

const MAX_DB_CACHE_ENTRIES = 200;

/**
 * Discriminated success result returned by withDbCacheFallback. Callers
 * narrow against `instanceof Response` to handle the error path; on the
 * success path they read `result.data`. The `stale` flag distinguishes
 * fresh query data from cached fallback data so callers can react if they
 * need to (e.g. additional logging, payload annotation). The HTTP staleness
 * headers (X-Cache-Status, X-Cache-Age, Warning) are still set on the Hono
 * context regardless, so they reach the client through the caller's
 * subsequent c.json() response.
 */
export interface DbCacheResult<T> {
  ok: true;
  data: T;
  stale: boolean;
}

/**
 * Execute a database query with cache fallback.
 * If the query fails, return cached data if available (even if stale).
 *
 * @param cacheKey - Unique key for caching this query
 * @param queryFn - Async function that performs the DB query
 * @param c - Hono context (for error responses and staleness headers)
 * @returns A `DbCacheResult<T>` on success/stale-fallback, or a `Response`
 *          (HTTP 503) when both the query failed and no usable cache exists.
 */
export async function withDbCacheFallback<T>(
  cacheKey: string,
  queryFn: () => Promise<T>,
  c: Context
): Promise<DbCacheResult<T> | Response> {
  try {
    // Try the query
    const result = await queryFn();
    
    // Evict oldest entries when at capacity
    while (dbCache.size >= MAX_DB_CACHE_ENTRIES) {
      const oldest = dbCache.keys().next().value;
      if (oldest !== undefined) dbCache.delete(oldest);
      else break;
    }

    // Cache successful result
    dbCache.set(cacheKey, {
      data: result,
      timestamp: Date.now(),
    });

    return { ok: true, data: result, stale: false };
  } catch (err) {
    logger.error("DB query failed, checking cache", {
      error: truncateErrorMessage(err instanceof Error ? err.message : String(err), 120),
      cacheKey,
    });
    
    // Check if we have cached data
    const cached = dbCache.get(cacheKey);
    
    if (cached) {
      const age = Date.now() - cached.timestamp;
      const ageMinutes = Math.floor(age / 60_000);
      
      // Serve stale cache (even if expired, availability > freshness during outages)
      if (age < MAX_STALE_AGE_MS) {
        logger.warn("Serving stale cache due to DB failure", {
          cacheKey,
          ageMinutes,
          maxAgeMinutes: Math.floor(MAX_STALE_AGE_MS / 60_000),
        });
        
        c.header("X-Cache-Status", "stale-fallback");
        c.header("X-Cache-Age", String(Math.floor(age / 1000)));
        c.header("Warning", `110 - "Response is Stale (${ageMinutes}m old)"`);
        // The dbCache stores `unknown` since it spans multiple call sites with
        // different T parameters. The cast is contained here: every caller
        // owns its own cacheKey namespace, so the runtime type is guaranteed
        // to match the T the caller asked for.
        return { ok: true, data: cached.data as T, stale: true };
      } else {
        logger.error("Cached data too old, cannot serve", {
          cacheKey,
          ageMinutes,
          maxAgeMinutes: Math.floor(MAX_STALE_AGE_MS / 60_000),
        });
      }
    }
    
    // No cache available or cache too old - return error
    logger.error("No cache available, returning error", { cacheKey });
    return c.json(
      { 
        error: "Database temporarily unavailable",
        message: "Please try again in a moment",
      },
      503
    );
  }
}

/**
 * Clear the DB cache (useful for testing)
 */
export function clearDbCache(): void {
  dbCache.clear();
}

/**
 * Get DB cache statistics
 */
export function getDbCacheStats() {
  return {
    size: dbCache.size,
    entries: Array.from(dbCache.entries()).map(([key, value]) => ({
      key,
      ageSeconds: Math.floor((Date.now() - value.timestamp) / 1000),
    })),
  };
}
