/**
 * #205: IPv6 rate-limit buckets must key on /64, not /128.
 *
 * A host controlling a /64 (the standard cloud and residential allocation)
 * could rotate source addresses to mint a fresh 100 req/min bucket per request.
 *
 * The expansion in ip-key.ts is hand-written (see the module header for why no
 * new dependency), so it is cross-checked here against Node's built-in
 * `net.BlockList`. BlockList masks host bits itself, so `addSubnet(a, 64)`
 * followed by `check(b)` is an independent answer to "are a and b in the same
 * /64?" — derived without reference to our implementation.
 */
import { describe, it, expect } from "vitest";
import { BlockList, isIPv6 } from "node:net";
import { rateLimitKey } from "../../src/utils/ip-key.js";

const V6 = [
  "2001:db8::1",
  "2001:db8::dead:beef",
  "2001:0db8:0000:0000:0000:0000:0000:0002",
  "2001:db8:0:0:aaaa:bbbb:cccc:dddd",
  "2001:db8:0:1::1",
  "2001:db8:0:1:ffff::9",
  "fe80::1",
  "fe80:0:0:0::abcd",
  "::1",
  "::",
  "2001:db8:85a3::8a2e:370:7334",
  "2001:db8:85a3:0:0:8a2e:370:7335",
  "2600:1f18:abcd:1234::5",
  "2600:1f18:abcd:1234:9999::5",
  "2001:db8::1.2.3.4",
  "2001:db8::5.6.7.8",
  "fd00::1",
  "fd00:0:0:1::1",
];

/** Independent answer: are these two addresses in the same /64? */
function sameSlash64(a: string, b: string): boolean {
  const list = new BlockList();
  list.addSubnet(a, 64, "ipv6");
  return list.check(b, "ipv6");
}

describe("#205 rateLimitKey", () => {
  it("agrees with net.BlockList on every address pair", () => {
    const mismatches: string[] = [];
    let checked = 0;

    for (const a of V6) {
      for (const b of V6) {
        if (!isIPv6(a) || !isIPv6(b)) continue;
        checked++;
        const oracle = sameSlash64(a, b);
        const mine = rateLimitKey(a) === rateLimitKey(b);
        if (oracle !== mine) {
          mismatches.push(`${a} vs ${b}: oracle=${oracle} mine=${mine}`);
        }
      }
    }

    expect(checked).toBeGreaterThan(300);
    expect(mismatches).toEqual([]);
  });

  it("collapses rotation within one /64 to a single bucket (the bypass)", () => {
    // What an attacker rotates through. Pre-fix each of these was its own
    // /128 bucket and therefore its own full quota.
    const rotated = [
      "2001:db8::1",
      "2001:db8::2",
      "2001:db8::dead:beef",
      "2001:db8:0:0:ffff:ffff:ffff:ffff",
    ];
    const keys = new Set(rotated.map(rateLimitKey));
    expect(keys.size).toBe(1);
  });

  it("keeps distinct /64s in distinct buckets", () => {
    expect(rateLimitKey("2001:db8:0:1::1")).not.toBe(rateLimitKey("2001:db8:0:2::1"));
  });

  it("leaves IPv4 keys exactly as-is", () => {
    for (const v4 of ["1.2.3.4", "203.0.113.9", "10.0.0.1", "255.255.255.255"]) {
      expect(rateLimitKey(v4)).toBe(v4);
    }
  });

  it("unwraps IPv4-mapped IPv6 to the bare IPv4 address", () => {
    expect(rateLimitKey("::ffff:1.2.3.4")).toBe("1.2.3.4");
  });

  it("keeps two different IPv4 addresses in different buckets", () => {
    expect(rateLimitKey("1.2.3.4")).not.toBe(rateLimitKey("1.2.3.5"));
  });

  it("ignores a zone id when keying", () => {
    expect(rateLimitKey("fe80::2%eth0")).toBe(rateLimitKey("fe80::2"));
  });

  it("falls back to the verbatim value for unparseable input", () => {
    // Per-value bucket, matching pre-#205 behaviour. Collapsing malformed
    // input into one shared key would let it throttle unrelated clients.
    for (const junk of ["not-an-ip", "2001:db8:::1", "xyz::1"]) {
      expect(rateLimitKey(junk)).toBe(junk);
    }
  });
});
