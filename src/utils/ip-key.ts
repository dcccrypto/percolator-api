/**
 * Shared client-IP bucket keys (#205).
 *
 * Rate limiting, the IP blocklist and the WS per-IP counters each had their own
 * copy of `normalizeIp`, which only unwrapped `::ffff:`-mapped addresses and
 * otherwise used the full 128-bit IPv6 address as the bucket key. A single host
 * controlling a /64 — the standard cloud and residential allocation — could
 * rotate source addresses to mint a fresh quota per request.
 *
 * IPv6 clients are therefore keyed by their /64 prefix. IPv4 behaviour is
 * unchanged: the exact address stays the key.
 *
 * No new dependency: #205 suggested a vetted IP library, but adding one now
 * would mean regenerating pnpm-lock.yaml, which is exactly the file broken by
 * #232 (it pins @percolatorct/sdk to a local filesystem path). Instead the
 * expansion below is validated in tests against Node's built-in
 * `net.BlockList`, which does its own subnet masking and so acts as an
 * independent oracle.
 */
import { isIPv4 } from "node:net";

/** A /64 covers the first 4 of the 8 hextets. */
const IPV6_PREFIX_GROUPS = 4;

/** Drop a zone/scope id (`fe80::1%eth0`). */
function stripZone(ip: string): string {
  const i = ip.indexOf("%");
  return i === -1 ? ip : ip.slice(0, i);
}

/**
 * Expand an IPv6 literal into exactly 8 numeric hextets.
 * Returns null when the input does not parse as IPv6.
 */
function expandIpv6(ip: string): number[] | null {
  let addr = stripZone(ip);

  // Embedded IPv4 tail (`::ffff:1.2.3.4`, `2001:db8::1.2.3.4`) → two hextets.
  const lastColon = addr.lastIndexOf(":");
  if (lastColon === -1) return null;
  const tail = addr.slice(lastColon + 1);
  if (tail.includes(".")) {
    if (!isIPv4(tail)) return null;
    const o = tail.split(".").map(Number);
    const hi = (((o[0] << 8) | o[1]) >>> 0).toString(16);
    const lo = (((o[2] << 8) | o[3]) >>> 0).toString(16);
    addr = `${addr.slice(0, lastColon + 1)}${hi}:${lo}`;
  }

  const halves = addr.split("::");
  if (halves.length > 2) return null;

  const parseGroups = (s: string): number[] | null => {
    if (s === "") return [];
    const out: number[] = [];
    for (const g of s.split(":")) {
      if (g === "" || g.length > 4 || !/^[0-9a-fA-F]+$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };

  const head = parseGroups(halves[0] ?? "");
  if (head === null) return null;

  if (halves.length === 2) {
    const rest = parseGroups(halves[1] ?? "");
    if (rest === null) return null;
    const fill = 8 - head.length - rest.length;
    if (fill < 0) return null;
    return [...head, ...new Array(fill).fill(0), ...rest];
  }

  return head.length === 8 ? head : null;
}

/**
 * Bucket key for a client IP.
 *
 * - IPv4 (incl. `::ffff:`-mapped): the exact address, unchanged.
 * - IPv6: the `/64` prefix, so address rotation inside one allocation shares
 *   a single quota.
 * - Unparseable input: the address verbatim. That is the pre-#205 behaviour —
 *   a per-address bucket. Collapsing unparseable input into one shared key
 *   would let a malformed value evict or throttle unrelated clients.
 */
export function rateLimitKey(ip: string): string {
  const norm = ip.startsWith("::ffff:") ? ip.slice(7) : ip;
  if (!norm.includes(":")) return norm; // IPv4 fast path

  const groups = expandIpv6(norm);
  if (!groups) return norm;

  return (
    groups
      .slice(0, IPV6_PREFIX_GROUPS)
      .map((g) => g.toString(16))
      .join(":") + "::/64"
  );
}

/** Exported for tests that cross-check expansion against `net.BlockList`. */
export const __ipKeyInternals = { expandIpv6 };
