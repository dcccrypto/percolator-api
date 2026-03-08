import type { Context, Next } from "hono";
import { createLogger } from "@percolator/shared";

const logger = createLogger("api:ip-blocklist");

/**
 * Extract client IP using the same trusted-proxy-depth logic as rate-limit.ts.
 * TRUSTED_PROXY_DEPTH=1 is the default (Railway sits behind one reverse proxy).
 */
const PROXY_DEPTH = Math.max(0, Number(process.env.TRUSTED_PROXY_DEPTH ?? 1));

function getClientIp(c: Context): string {
  if (PROXY_DEPTH === 0) {
    return c.req.header("x-real-ip") ?? "unknown";
  }

  const forwarded = c.req.header("x-forwarded-for");
  if (forwarded) {
    const ips = forwarded.split(",").map((ip) => ip.trim()).filter(Boolean);
    const idx = Math.max(0, ips.length - PROXY_DEPTH);
    return ips[idx] || "unknown";
  }

  return c.req.header("x-real-ip") ?? "unknown";
}

/**
 * Parse IP_BLOCKLIST env var (comma-separated) into a Set.
 * Also supports CIDR-free plain IP matching; for CIDR support add a
 * library like 'ip-range-check' when needed.
 */
function parseBlocklist(): Set<string> {
  const raw = process.env.IP_BLOCKLIST ?? "";
  const ips = raw.split(",").map((ip) => ip.trim()).filter(Boolean);
  if (ips.length > 0) {
    logger.info("IP blocklist loaded", { count: ips.length });
  }
  return new Set(ips);
}

// Snapshot at startup; refreshed every 60 s so a Railway env var update
// takes effect without a full redeploy.
let blocklist = parseBlocklist();
setInterval(() => {
  blocklist = parseBlocklist();
}, 60_000);

/**
 * Middleware that hard-blocks IPs listed in the IP_BLOCKLIST env var.
 * Returns HTTP 403 immediately — no rate-limit headers, no body beyond the
 * JSON error object.  Register this before rate-limiting middleware so
 * blocked connections never consume a rate-limit slot.
 */
export function ipBlocklistMiddleware() {
  return async (c: Context, next: Next) => {
    if (blocklist.size === 0) return next();

    const ip = getClientIp(c);
    if (ip !== "unknown" && blocklist.has(ip)) {
      logger.warn("Blocked IP rejected", {
        ip,
        path: c.req.path,
        method: c.req.method,
      });
      return c.json({ error: "Forbidden" }, 403);
    }

    return next();
  };
}
