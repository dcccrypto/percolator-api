import type { Context, Next } from "hono";
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

// Clean up expired buckets every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of readBuckets) if (v.resetAt <= now) readBuckets.delete(k);
  for (const [k, v] of writeBuckets) if (v.resetAt <= now) writeBuckets.delete(k);
}, 5 * 60_000);

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
const PROXY_DEPTH = Math.max(0, Number(process.env.TRUSTED_PROXY_DEPTH ?? 1));

function normalizeIp(ip: string): string {
  if (ip.startsWith("::ffff:")) return ip.slice(7);
  return ip;
}

function getClientIp(c: Context): string {
  if (PROXY_DEPTH === 0) {
    return normalizeIp(c.req.header("x-real-ip") ?? "unknown");
  }

  const forwarded = c.req.header("x-forwarded-for");
  if (forwarded) {
    const ips = forwarded.split(",").map(ip => ip.trim()).filter(Boolean);
    const idx = Math.max(0, ips.length - PROXY_DEPTH);
    return normalizeIp(ips[idx] || "unknown");
  }

  return normalizeIp(c.req.header("x-real-ip") ?? "unknown");
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
      const oldestKey = buckets.keys().next().value;
      if (oldestKey !== undefined) buckets.delete(oldestKey);
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
    const result = checkLimit(readBuckets, ip, READ_LIMIT);
    
    // Set rate limit headers
    c.header("X-RateLimit-Limit", result.limit.toString());
    c.header("X-RateLimit-Remaining", result.remaining.toString());
    c.header("X-RateLimit-Reset", result.reset.toString());
    
    if (!result.allowed) {
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
    const result = checkLimit(writeBuckets, ip, WRITE_LIMIT);
    
    // Set rate limit headers
    c.header("X-RateLimit-Limit", result.limit.toString());
    c.header("X-RateLimit-Remaining", result.remaining.toString());
    c.header("X-RateLimit-Reset", result.reset.toString());
    
    if (!result.allowed) {
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
