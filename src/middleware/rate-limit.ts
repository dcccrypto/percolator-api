import type { Context, Next } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import { createLogger } from "@percolator/shared";
import { getSharedStore } from "./shared-store.js";

const logger = createLogger("api:rate-limit");

const WINDOW_MS = 60_000; // 1 minute
const READ_LIMIT = 100; // 100 requests per minute for reads
const WRITE_LIMIT = 10; // 10 requests per minute for writes
const MAX_RATE_LIMIT_ENTRIES = 50_000; // cap to prevent OOM from distributed DDoS (in-memory fallback only)

// Clean up expired buckets every minute (in-memory fallback only — Redis
// handles its own TTL-based eviction automatically).
setInterval(() => {
  getSharedStore().evictExpiredRateBuckets().catch(() => undefined);
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

export function readRateLimit() {
  return async (c: Context, next: Next) => {
    const ip = getClientIp(c);
    if (!ip) {
      logger.warn("Rejected request: could not determine client IP", { path: c.req.path });
      return c.json({ error: "Bad request" }, 400);
    }

    const bucket = await getSharedStore().incrementRateBucket(
      `read:${ip}`,
      WINDOW_MS,
      MAX_RATE_LIMIT_ENTRIES
    );

    const remaining = Math.max(0, READ_LIMIT - bucket.count);
    const reset = Math.floor(bucket.resetAt / 1000);

    c.header("X-RateLimit-Limit", READ_LIMIT.toString());
    c.header("X-RateLimit-Remaining", remaining.toString());
    c.header("X-RateLimit-Reset", reset.toString());

    if (bucket.count > READ_LIMIT) {
      const retryAfter = Math.max(1, reset - Math.floor(Date.now() / 1000));
      c.header("Retry-After", retryAfter.toString());
      logger.warn("Read rate limit exceeded", {
        ip,
        path: c.req.path,
        limit: READ_LIMIT,
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

    const bucket = await getSharedStore().incrementRateBucket(
      `write:${ip}`,
      WINDOW_MS,
      MAX_RATE_LIMIT_ENTRIES
    );

    const remaining = Math.max(0, WRITE_LIMIT - bucket.count);
    const reset = Math.floor(bucket.resetAt / 1000);

    c.header("X-RateLimit-Limit", WRITE_LIMIT.toString());
    c.header("X-RateLimit-Remaining", remaining.toString());
    c.header("X-RateLimit-Reset", reset.toString());

    if (bucket.count > WRITE_LIMIT) {
      const retryAfter = Math.max(1, reset - Math.floor(Date.now() / 1000));
      c.header("Retry-After", retryAfter.toString());
      logger.warn("Write rate limit exceeded", {
        ip,
        path: c.req.path,
        method: c.req.method,
        limit: WRITE_LIMIT,
      });
      return c.json({ error: "Rate limit exceeded" }, 429);
    }

    return next();
  };
}
