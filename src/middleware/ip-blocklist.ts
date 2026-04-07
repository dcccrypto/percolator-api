import type { Context, Next } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import { createLogger } from "@percolator/shared";

const logger = createLogger("api:ip-blocklist");

/**
 * IP Blocklist Middleware
 *
 * Reads a comma-separated list of blocked CIDRs/IPs from the IP_BLOCKLIST
 * environment variable and rejects matching requests with 403 before they
 * reach any other middleware (rate-limit, auth, routes).
 *
 * Usage (Railway / .env):
 *   IP_BLOCKLIST=88.97.223.158,10.0.0.5,192.168.1.0/24
 *
 * IP extraction respects TRUSTED_PROXY_DEPTH (same logic as rate-limit.ts).
 * CIDR matching is supported for /8, /16, /24, /32 (IPv4 only).
 */

const PROXY_DEPTH = (() => {
  const parsed = Number(process.env.TRUSTED_PROXY_DEPTH ?? 1);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) {
    logger.warn("Invalid TRUSTED_PROXY_DEPTH, falling back to default", { value: process.env.TRUSTED_PROXY_DEPTH });
    return 1;
  }
  return parsed;
})();

// Parse the env var once at startup
const RAW_BLOCKLIST = (process.env.IP_BLOCKLIST ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

if (RAW_BLOCKLIST.length > 0) {
  logger.info("IP blocklist loaded", { count: RAW_BLOCKLIST.length });
} else {
  logger.info("IP blocklist is empty — no IPs will be blocked");
}

/** Convert a dotted-decimal IPv4 to a 32-bit integer */
function ipToInt(ip: string): number {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) return -1;
  return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
}

interface ParsedEntry {
  type: "exact" | "cidr";
  raw: string;
  // For exact matches
  ip?: string;
  // For CIDR matches
  network?: number;
  mask?: number;
}

function parseEntry(entry: string): ParsedEntry | null {
  if (entry.includes("/")) {
    const [addr, prefixStr] = entry.split("/");
    const prefix = Number(prefixStr);
    if (!addr || isNaN(prefix) || prefix < 0 || prefix > 32) return null;
    const network = ipToInt(addr);
    if (network === -1) return null;
    const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
    return { type: "cidr", raw: entry, network: (network & mask) >>> 0, mask };
  }
  return { type: "exact", raw: entry, ip: entry };
}

const PARSED_BLOCKLIST: ParsedEntry[] = RAW_BLOCKLIST.map((entry) => {
  const parsed = parseEntry(entry);
  if (parsed === null) {
    logger.warn("Invalid IP blocklist entry dropped", { entry });
  }
  return parsed;
}).filter((e): e is ParsedEntry => e !== null);

if (RAW_BLOCKLIST.length > 0 && PARSED_BLOCKLIST.length === 0) {
  logger.warn("All IP blocklist entries failed to parse — no IPs will be blocked");
}

function isBlocked(clientIp: string): boolean {
  if (PARSED_BLOCKLIST.length === 0) return false;

  const clientInt = ipToInt(clientIp);

  for (const entry of PARSED_BLOCKLIST) {
    if (entry.type === "exact") {
      if (clientIp === entry.ip) return true;
    } else {
      if (clientInt === -1) continue;
      if ((clientInt & entry.mask!) >>> 0 === entry.network) return true;
    }
  }
  return false;
}

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
    const ips = forwarded
      .split(",")
      .map((ip) => ip.trim())
      .filter(Boolean);
    const idx = Math.max(0, ips.length - PROXY_DEPTH);
    const ip = ips[idx];
    return ip ? normalizeIp(ip) : null;
  }
  // x-forwarded-for absent behind a proxy — fall back to socket address
  // rather than the spoofable x-real-ip header (see comment on line 93).
  try {
    const info = getConnInfo(c);
    const addr = info.remote.address;
    return addr ? normalizeIp(addr) : null;
  } catch {
    return null;
  }
}

export function ipBlocklist() {
  return async (c: Context, next: Next) => {
    if (PARSED_BLOCKLIST.length === 0) return next();

    const ip = getClientIp(c);
    if (!ip) {
      logger.warn("Rejected request: could not determine client IP for blocklist check", {
        path: c.req.path,
        method: c.req.method,
      });
      return c.json({ error: "Bad request" }, 400);
    }
    if (isBlocked(ip)) {
      logger.warn("Blocked request from blocklisted IP", {
        ip,
        path: c.req.path,
        method: c.req.method,
      });
      return c.json({ error: "Forbidden" }, 403);
    }

    return next();
  };
}

/**
 * Check whether a raw IP string (already extracted from headers) is on the
 * blocklist. Used by non-Hono code paths such as the WebSocket upgrade
 * handler, which runs before Hono middleware gets a chance to fire.
 */
export function isClientIpBlocked(ip: string): boolean {
  return isBlocked(ip);
}
