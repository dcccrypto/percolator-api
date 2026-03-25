import type { Context, Next } from "hono";
import { createLogger } from "@percolator/shared";

const logger = createLogger("api:rate-limit");

// ──────────────────────────────────────────────────────────────
// Upstash Redis rate limiting (production)
// ──────────────────────────────────────────────────────────────
//
// When UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN are set,
// all rate-limit state is stored in Redis so limits are enforced
// across multiple API replicas (Railway horizontal scale).
//
// When unset (local dev / CI), falls back to in-memory Maps with
// identical semantics.

let redisRatelimit: {
  readLimiter: { limit: (key: string) => Promise<{ success: boolean; limit: number; remaining: number; reset: number }> };
  writeLimiter: { limit: (key: string) => Promise<{ success: boolean; limit: number; remaining: number; reset: number }> };
  createLimiter: (limit: number) => { limit: (key: string) => Promise<{ success: boolean; limit: number; remaining: number; reset: number }> };
} | null = null;

async function getRedisLimiters() {
  if (redisRatelimit !== null) return redisRatelimit;

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) {
    logger.warn(
      "UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN not set — falling back to in-memory rate limiting (not suitable for multi-replica deployments)"
    );
    return null;
  }

  const { Redis } = await import("@upstash/redis");
  const { Ratelimit } = await import("@upstash/ratelimit");

  const redis = new Redis({ url, token });

  const readLimiter = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(READ_LIMIT, "1 m"),
    prefix: "perc_rl_read",
  });

  const writeLimiter = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(WRITE_LIMIT, "1 m"),
    prefix: "perc_rl_write",
  });

  function createLimiter(limit: number) {
    return new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(limit, "1 m"),
      prefix: `perc_rl_endpoint_${limit}`,
    });
  }

  redisRatelimit = { readLimiter, writeLimiter, createLimiter };
  logger.info("Upstash Redis rate limiting initialised", { url: url.replace(/\/\/.*@/, "//<redacted>@") });
  return redisRatelimit;
}

// ──────────────────────────────────────────────────────────────
// In-memory fallback (dev / single-replica)
// ──────────────────────────────────────────────────────────────

interface RateBucket {
  count: number;
  resetAt: number;
}

const readBuckets = new Map<string, RateBucket>();
const writeBuckets = new Map<string, RateBucket>();
const WINDOW_MS = 60_000; // 1 minute
const READ_LIMIT = 100; // 100 requests per minute for reads
const WRITE_LIMIT = 10; // 10 requests per minute for writes

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

function getClientIp(c: Context): string {
  if (PROXY_DEPTH === 0) {
    // No trusted proxy: ignore forwarded headers, use connection IP
    return c.req.header("x-real-ip") ?? "unknown";
  }

  const forwarded = c.req.header("x-forwarded-for");
  if (forwarded) {
    const ips = forwarded.split(",").map(ip => ip.trim()).filter(Boolean);
    // Use the IP at (length - PROXY_DEPTH): the one the outermost
    // trusted proxy appended for the real client.
    const idx = Math.max(0, ips.length - PROXY_DEPTH);
    return ips[idx] || "unknown";
  }

  return c.req.header("x-real-ip") ?? "unknown";
}

interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  reset: number;
}

function checkLimitInMemory(
  buckets: Map<string, RateBucket>,
  ip: string,
  limit: number
): RateLimitResult {
  const now = Date.now();
  let bucket = buckets.get(ip);

  if (!bucket || bucket.resetAt <= now) {
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

// ──────────────────────────────────────────────────────────────
// Exported middleware
// ──────────────────────────────────────────────────────────────

export function readRateLimit() {
  return async (c: Context, next: Next) => {
    const ip = getClientIp(c);
    const limiters = await getRedisLimiters();

    let result: RateLimitResult;
    if (limiters) {
      const r = await limiters.readLimiter.limit(ip);
      result = { allowed: r.success, limit: r.limit, remaining: r.remaining, reset: Math.floor(r.reset / 1000) };
    } else {
      result = checkLimitInMemory(readBuckets, ip, READ_LIMIT);
    }

    c.header("X-RateLimit-Limit", result.limit.toString());
    c.header("X-RateLimit-Remaining", result.remaining.toString());
    c.header("X-RateLimit-Reset", result.reset.toString());

    if (!result.allowed) {
      logger.warn("Read rate limit exceeded", {
        ip,
        path: c.req.path,
        limit: READ_LIMIT,
        backend: limiters ? "redis" : "memory",
      });
      return c.json({ error: "Rate limit exceeded" }, 429);
    }

    return next();
  };
}

export function writeRateLimit() {
  return async (c: Context, next: Next) => {
    const ip = getClientIp(c);
    const limiters = await getRedisLimiters();

    let result: RateLimitResult;
    if (limiters) {
      const r = await limiters.writeLimiter.limit(ip);
      result = { allowed: r.success, limit: r.limit, remaining: r.remaining, reset: Math.floor(r.reset / 1000) };
    } else {
      result = checkLimitInMemory(writeBuckets, ip, WRITE_LIMIT);
    }

    c.header("X-RateLimit-Limit", result.limit.toString());
    c.header("X-RateLimit-Remaining", result.remaining.toString());
    c.header("X-RateLimit-Reset", result.reset.toString());

    if (!result.allowed) {
      logger.warn("Write rate limit exceeded", {
        ip,
        path: c.req.path,
        method: c.req.method,
        limit: WRITE_LIMIT,
        backend: limiters ? "redis" : "memory",
      });
      return c.json({ error: "Rate limit exceeded" }, 429);
    }

    return next();
  };
}

/**
 * Create a per-endpoint rate limiter with a custom request limit per minute.
 *
 * When Redis is configured, each unique limit value gets its own Upstash
 * Ratelimit instance backed by the shared Redis connection.
 *
 * When Redis is not configured (dev/CI), falls back to an isolated in-memory
 * bucket map.
 *
 * Example: apply 60 req/min to /stats
 *   app.use("/stats", createRateLimit(60));
 */
export function createRateLimit(limit: number) {
  const buckets = new Map<string, RateBucket>();

  // Clean up expired buckets every 5 minutes (in-memory path only)
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of buckets) if (v.resetAt <= now) buckets.delete(k);
  }, 5 * 60_000);

  return async (c: Context, next: Next) => {
    const ip = getClientIp(c);
    const limiters = await getRedisLimiters();

    let result: RateLimitResult;
    if (limiters) {
      const endpointLimiter = limiters.createLimiter(limit);
      const r = await endpointLimiter.limit(`${ip}:${c.req.path}`);
      result = { allowed: r.success, limit: r.limit, remaining: r.remaining, reset: Math.floor(r.reset / 1000) };
    } else {
      result = checkLimitInMemory(buckets, ip, limit);
    }

    c.header("X-RateLimit-Limit", result.limit.toString());
    c.header("X-RateLimit-Remaining", result.remaining.toString());
    c.header("X-RateLimit-Reset", result.reset.toString());

    if (!result.allowed) {
      logger.warn("Endpoint rate limit exceeded", {
        ip,
        path: c.req.path,
        limit,
        backend: limiters ? "redis" : "memory",
      });
      return c.json({ error: "Rate limit exceeded" }, 429);
    }

    return next();
  };
}
