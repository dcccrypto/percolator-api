import type { Context, Next } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import { createLogger } from "@percolator/shared";

const logger = createLogger("api:rate-limit");

interface RateBucket {
  count: number;
  resetAt: number;
}

const readBuckets = new Map<string, RateBucket>();
const writeBuckets = new Map<string, RateBucket>();
const WINDOW_MS = 60_000; // 1 minute
const READ_LIMIT = 100; // 100 requests per minute for reads
const WRITE_LIMIT = 10; // 10 requests per minute for writes
const MAX_RATE_LIMIT_ENTRIES = 50_000; // cap to prevent OOM from distributed DDoS
// Number of leading entries the eviction path scans for an already-expired
// bucket before falling back to deleting the oldest insertion. Bounded so the
// per-request cost stays O(1) even when the map is full.
const EVICTION_SCAN_LIMIT = 32;

// Clean up expired buckets every minute. Aligned with WINDOW_MS so most
// expired entries are reclaimed within one window, keeping the eviction
// scan effective even under sustained pressure from many fresh IPs.
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of readBuckets) if (v.resetAt <= now) readBuckets.delete(k);
  for (const [k, v] of writeBuckets) if (v.resetAt <= now) writeBuckets.delete(k);
}, 60_000).unref();

/**
 * Extract client IP with configurable trusted proxy depth.
 *
 * TRUSTED_PROXY_DEPTH=0 (default): Ignore X-Forwarded-For entirely,
 *   use X-Real-IP or connection address. Safe when exposed directly.
 * TRUSTED_PROXY_DEPTH=1: One reverse proxy (e.g. Vercel, Cloudflare).
 *   Use the IP at position (length - 1) in X-Forwarded-For.
 * TRUSTED_PROXY_DEPTH=2: Two proxy layers. Use (length - 2).
 *
 * This prevents bypass via spoofed X-Forwarded-For headers when
 * no trusted proxy is configured.
 */
const PROXY_DEPTH = (() => {
  const parsed = Number(process.env.TRUSTED_PROXY_DEPTH ?? 1);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) {
    logger.warn("Invalid TRUSTED_PROXY_DEPTH, falling back to default", { value: process.env.TRUSTED_PROXY_DEPTH });
    return 1;
  }
  return parsed;
})();

function normalizeIp(ip: string): string {
  if (ip.startsWith("::ffff:")) return ip.slice(7);
  return ip;
}

function getClientIp(c: Context): string | null {
  if (PROXY_DEPTH === 0) {
    // No trusted proxy: ignore all forwarded headers, use socket address.
    // x-real-ip is client-spoofable and must not be trusted without a proxy.
    const info = getConnInfo(c);
    const addr = info.remote.address;
    return addr ? normalizeIp(addr) : null;
  }

  const forwarded = c.req.header("x-forwarded-for");
  if (forwarded) {
    const ips = forwarded.split(",").map(ip => ip.trim()).filter(Boolean);
    const idx = Math.max(0, ips.length - PROXY_DEPTH);
    const ip = ips[idx];
    return ip ? normalizeIp(ip) : null;
  }

  // x-forwarded-for absent behind a proxy — fall back to socket address
  // rather than the spoofable x-real-ip header (see comment on line 48).
  try {
    const info = getConnInfo(c);
    const addr = info.remote.address;
    return addr ? normalizeIp(addr) : null;
  } catch {
    return null;
  }
}

interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  reset: number;
}

function checkLimit(
  buckets: Map<string, RateBucket>, 
  ip: string, 
  limit: number
): RateLimitResult {
  const now = Date.now();
  let bucket = buckets.get(ip);
  
  if (!bucket || bucket.resetAt <= now) {
    if (!bucket && buckets.size >= MAX_RATE_LIMIT_ENTRIES) {
      // Prefer evicting an already-expired bucket so legitimate users with
      // an active rate-limit window are not displaced by attackers cycling
      // through fresh IPs. Bound the scan so the per-request cost stays
      // O(1) even when the whole map is active.
      let evicted = false;
      let scanned = 0;
      for (const [k, v] of buckets) {
        if (scanned >= EVICTION_SCAN_LIMIT) break;
        scanned++;
        if (v.resetAt <= now) {
          buckets.delete(k);
          evicted = true;
          break;
        }
      }
      // Fallback: if nothing in the scan window has expired, drop the
      // oldest insertion as a last resort. This still happens but only
      // when the entire scan window is occupied by genuinely-active IPs.
      if (!evicted) {
        const oldestKey = buckets.keys().next().value;
        if (oldestKey !== undefined) buckets.delete(oldestKey);
      }
    }
    bucket = { count: 0, resetAt: now + WINDOW_MS };
    buckets.set(ip, bucket);
  }
  
  bucket.count++;
  const allowed = bucket.count <= limit;
  const remaining = Math.max(0, limit - bucket.count);
  
  return {
    allowed,
    limit,
    remaining,
    reset: Math.floor(bucket.resetAt / 1000), // Unix timestamp in seconds
  };
}

export function readRateLimit() {
  return async (c: Context, next: Next) => {
    const ip = getClientIp(c);
    if (!ip) {
      logger.warn("Rejected request: could not determine client IP", { path: c.req.path });
      return c.json({ error: "Bad request" }, 400);
    }
    const result = checkLimit(readBuckets, ip, READ_LIMIT);
    
    // Set rate limit headers
    c.header("X-RateLimit-Limit", result.limit.toString());
    c.header("X-RateLimit-Remaining", result.remaining.toString());
    c.header("X-RateLimit-Reset", result.reset.toString());
    
    if (!result.allowed) {
      const retryAfter = Math.max(1, result.reset - Math.floor(Date.now() / 1000));
      c.header("Retry-After", retryAfter.toString());
      logger.warn("Read rate limit exceeded", { 
        ip, 
        path: c.req.path,
        limit: READ_LIMIT 
      });
      return c.json({ error: "Rate limit exceeded" }, 429);
    }
    
    return next();
  };
}

export function writeRateLimit() {
  return async (c: Context, next: Next) => {
    const ip = getClientIp(c);
    if (!ip) {
      logger.warn("Rejected request: could not determine client IP", { path: c.req.path, method: c.req.method });
      return c.json({ error: "Bad request" }, 400);
    }
    const result = checkLimit(writeBuckets, ip, WRITE_LIMIT);
    
    // Set rate limit headers
    c.header("X-RateLimit-Limit", result.limit.toString());
    c.header("X-RateLimit-Remaining", result.remaining.toString());
    c.header("X-RateLimit-Reset", result.reset.toString());
    
    if (!result.allowed) {
      const retryAfter = Math.max(1, result.reset - Math.floor(Date.now() / 1000));
      c.header("Retry-After", retryAfter.toString());
      logger.warn("Write rate limit exceeded", { 
        ip, 
        path: c.req.path,
        method: c.req.method,
        limit: WRITE_LIMIT 
      });
      return c.json({ error: "Rate limit exceeded" }, 429);
    }
    
    return next();
  };
}
