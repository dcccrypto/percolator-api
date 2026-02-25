/**
 * DB Cache Fallback Utility
 * 
 * When Supabase queries fail, serve stale cached data instead of 500 errors.
 * This improves availability during DB outages or network issues.
 */
import { createLogger } from "@percolator/shared";
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

/**
 * Execute a database query with cache fallback.
 * If the query fails, return cached data if available (even if stale).
 * 
 * @param cacheKey - Unique key for caching this query
 * @param queryFn - Async function that performs the DB query
 * @param c - Hono context (for error responses)
 * @returns Query result or cached data
 */
export async function withDbCacheFallback<T>(
  cacheKey: string,
  queryFn: () => Promise<T>,
  c: Context
): Promise<T | Response> {
  try {
    // Try the query
    const result = await queryFn();
    
    // Cache successful result
    dbCache.set(cacheKey, {
      data: result,
      timestamp: Date.now(),
    });
    
    return result;
  } catch (err) {
    logger.error("DB query failed, checking cache", { 
      error: err instanceof Error ? err.message : String(err),
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
        
        // Return cached data with warning header
        return cached.data as T;
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
