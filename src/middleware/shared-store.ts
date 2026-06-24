/**
 * Pluggable shared store for abuse-control state (rate-limit buckets,
 * WS connection counters, auth-failure bans).
 *
 * WHY THIS EXISTS
 * ---------------
 * All abuse controls were previously backed by process-local Maps. Under a
 * multi-replica deployment (Railway horizontal scaling) each replica maintains
 * its own independent counters, so an attacker gets N× the per-IP budget by
 * cycling across replicas or letting the load balancer spread their requests.
 * IP bans set on replica-A are invisible to replica-B.
 *
 * This module provides a SharedStore interface and two implementations:
 *
 *   InMemoryStore  — default; works for single-replica / local dev. Zero deps,
 *                    same Map-based behaviour as before so nothing regresses.
 *
 *   UpstashStore   — uses the Upstash Redis REST API (plain fetch, no SDK dep)
 *                    when UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN are
 *                    set. State is shared across all replicas. On any network
 *                    error it falls back to the in-memory store so a Redis
 *                    outage degrades gracefully rather than taking down the API.
 *
 * USAGE
 * -----
 * Import `getSharedStore()` and call the atomic helpers. The caller never needs
 * to know which backend is active.
 *
 * CONFIGURATION
 * -------------
 *   UPSTASH_REDIS_REST_URL    — e.g. https://xxx.upstash.io
 *   UPSTASH_REDIS_REST_TOKEN  — Upstash REST token
 *
 * When either env var is absent the in-memory store is used automatically.
 *
 * KEY NAMESPACE
 * -------------
 * All Redis keys are prefixed with `pcl:` to avoid collisions if the Upstash
 * database is shared with other services.
 */

import { createLogger } from "@percolator/shared";

const logger = createLogger("api:shared-store");

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface RateBucket {
  count: number;
  resetAt: number; // Unix ms
}

export interface AuthFailureRecord {
  count: number;
  windowStart: number; // Unix ms
  bannedUntil: number; // 0 = not banned
}

export interface SharedStore {
  /**
   * Atomically increment the request count for `key` within a rolling window.
   * If no bucket exists or the existing one has expired, resets to count=1.
   * Returns the bucket AFTER the increment.
   */
  incrementRateBucket(
    key: string,
    windowMs: number,
    maxEntries: number
  ): Promise<RateBucket>;

  /** Flush all expired rate buckets (best-effort; no-op on Redis). */
  evictExpiredRateBuckets(): Promise<void>;

  /** Get the current connection count for an IP (0 if absent). */
  getConnectionCount(key: string): Promise<number>;

  /** Increment the connection count for an IP by 1. */
  incrementConnectionCount(key: string): Promise<void>;

  /**
   * Decrement the connection count for an IP by 1.
   * Deletes the key when count reaches 0.
   */
  decrementConnectionCount(key: string): Promise<void>;

  /**
   * Record an auth failure for an IP.
   * Returns the updated record so callers can decide whether to ban.
   */
  recordAuthFailure(
    ip: string,
    windowMs: number,
    banThreshold: number,
    banDurationMs: number,
    maxEntries: number
  ): Promise<AuthFailureRecord>;

  /**
   * Check whether an IP is currently banned for too many auth failures.
   * Automatically clears expired bans.
   */
  isAuthBanned(ip: string): Promise<boolean>;

  /** Evict stale auth-failure records (best-effort; no-op on Redis). */
  evictExpiredAuthFailures(windowMs: number, banDurationMs: number): Promise<void>;
}

// ---------------------------------------------------------------------------
// In-memory implementation (single-replica / dev fallback)
// ---------------------------------------------------------------------------

interface InMemoryRateBucket {
  count: number;
  resetAt: number;
}

interface InMemoryAuthRecord {
  count: number;
  windowStart: number;
  bannedUntil: number;
}

export class InMemoryStore implements SharedStore {
  private readonly readBuckets = new Map<string, InMemoryRateBucket>();
  private readonly connCounts = new Map<string, number>();
  private readonly authFailures = new Map<string, InMemoryAuthRecord>();

  // Keep eviction scan bounded so per-request cost stays O(1).
  private static readonly EVICTION_SCAN_LIMIT = 32;

  async incrementRateBucket(
    key: string,
    windowMs: number,
    maxEntries: number
  ): Promise<RateBucket> {
    const now = Date.now();
    let bucket = this.readBuckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      if (!bucket && this.readBuckets.size >= maxEntries) {
        // Prefer evicting an expired entry so active buckets aren't displaced.
        let evicted = false;
        let scanned = 0;
        for (const [k, v] of this.readBuckets) {
          if (scanned >= InMemoryStore.EVICTION_SCAN_LIMIT) break;
          scanned++;
          if (v.resetAt <= now) {
            this.readBuckets.delete(k);
            evicted = true;
            break;
          }
        }
        if (!evicted) {
          const oldest = this.readBuckets.keys().next().value;
          if (oldest !== undefined) this.readBuckets.delete(oldest);
        }
      }
      bucket = { count: 0, resetAt: now + windowMs };
      this.readBuckets.set(key, bucket);
    }

    bucket.count++;
    return { count: bucket.count, resetAt: bucket.resetAt };
  }

  async evictExpiredRateBuckets(): Promise<void> {
    const now = Date.now();
    for (const [k, v] of this.readBuckets) {
      if (v.resetAt <= now) this.readBuckets.delete(k);
    }
  }

  async getConnectionCount(key: string): Promise<number> {
    return this.connCounts.get(key) ?? 0;
  }

  async incrementConnectionCount(key: string): Promise<void> {
    this.connCounts.set(key, (this.connCounts.get(key) ?? 0) + 1);
  }

  async decrementConnectionCount(key: string): Promise<void> {
    const cur = this.connCounts.get(key) ?? 1;
    if (cur <= 1) {
      this.connCounts.delete(key);
    } else {
      this.connCounts.set(key, cur - 1);
    }
  }

  async recordAuthFailure(
    ip: string,
    windowMs: number,
    banThreshold: number,
    banDurationMs: number,
    maxEntries: number
  ): Promise<AuthFailureRecord> {
    const now = Date.now();
    let rec = this.authFailures.get(ip);
    if (!rec) {
      if (this.authFailures.size >= maxEntries) {
        const oldest = this.authFailures.keys().next().value;
        if (oldest !== undefined) this.authFailures.delete(oldest);
      }
      rec = { count: 0, windowStart: now, bannedUntil: 0 };
      this.authFailures.set(ip, rec);
    }

    if (now - rec.windowStart > windowMs) {
      rec.count = 0;
      rec.windowStart = now;
    }

    rec.count++;
    if (rec.count >= banThreshold) {
      rec.bannedUntil = now + banDurationMs;
    }

    return { count: rec.count, windowStart: rec.windowStart, bannedUntil: rec.bannedUntil };
  }

  async isAuthBanned(ip: string): Promise<boolean> {
    const rec = this.authFailures.get(ip);
    if (!rec || rec.bannedUntil === 0) return false;
    if (Date.now() >= rec.bannedUntil) {
      this.authFailures.delete(ip);
      return false;
    }
    return true;
  }

  async evictExpiredAuthFailures(windowMs: number, banDurationMs: number): Promise<void> {
    const now = Date.now();
    for (const [ip, rec] of this.authFailures.entries()) {
      const stale =
        rec.bannedUntil > 0
          ? now >= rec.bannedUntil + banDurationMs
          : now - rec.windowStart > windowMs * 2;
      if (stale) this.authFailures.delete(ip);
    }
  }
}

// ---------------------------------------------------------------------------
// Upstash Redis REST implementation
// ---------------------------------------------------------------------------

/**
 * Thin wrapper around the Upstash Redis REST API.
 * All operations use fetch — no extra npm dependency.
 *
 * Failure mode: if any Redis call throws, the method falls back to the
 * in-memory store and logs a warning. This means a Redis outage degrades
 * multi-replica protection to per-replica but never crashes the API.
 */
export class UpstashStore implements SharedStore {
  private readonly url: string;
  private readonly token: string;
  private readonly fallback: InMemoryStore;

  constructor(url: string, token: string) {
    // Strip trailing slash for consistent URL construction.
    this.url = url.replace(/\/$/, "");
    this.token = token;
    this.fallback = new InMemoryStore();
  }

  private async cmd(...args: (string | number)[]): Promise<unknown> {
    const res = await fetch(`${this.url}/pipeline`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify([args]),
      signal: AbortSignal.timeout(2_000), // 2s hard cap so we never block a request long
    });

    if (!res.ok) {
      throw new Error(`Upstash HTTP ${res.status}: ${await res.text()}`);
    }

    const body = (await res.json()) as [{ result: unknown; error?: string }];
    const item = body[0];
    if (!item) throw new Error("Empty pipeline response");
    if (item.error) throw new Error(`Upstash error: ${item.error}`);
    return item.result;
  }

  /**
   * Execute a Lua script atomically via EVAL.
   * `keys` and `args` map to KEYS[] and ARGV[] inside the script.
   */
  private async eval(
    script: string,
    keys: string[],
    args: (string | number)[]
  ): Promise<unknown> {
    return this.cmd("EVAL", script, keys.length, ...keys, ...args);
  }

  // Rate-bucket key: pcl:rl:<ip-or-key>
  private rlKey(key: string): string {
    return `pcl:rl:${key}`;
  }

  // Connection count key: pcl:conn:<ip>
  private connKey(ip: string): string {
    return `pcl:conn:${ip}`;
  }

  // Auth-failure hash key: pcl:af:<ip>
  private afKey(ip: string): string {
    return `pcl:af:${ip}`;
  }

  /**
   * Atomically increment a rate bucket.
   *
   * Redis HASH layout:
   *   pcl:rl:<key>  →  { count: N, resetAt: <unix-ms> }
   *
   * Lua script:
   *   - If key absent or resetAt expired → reset count=1
   *   - Else increment count
   *   - Return [count, resetAt]
   */
  async incrementRateBucket(
    key: string,
    windowMs: number,
    _maxEntries: number // maxEntries is process-local; Redis manages its own memory
  ): Promise<RateBucket> {
    const rk = this.rlKey(key);
    const script = `
      local now = tonumber(ARGV[1])
      local windowMs = tonumber(ARGV[2])
      local resetAt = tonumber(redis.call("HGET", KEYS[1], "resetAt") or "0")
      local count
      if resetAt <= now then
        count = 1
        resetAt = now + windowMs
        redis.call("HSET", KEYS[1], "count", count, "resetAt", resetAt)
        -- Expire the key slightly after the window so Redis reclaims memory
        redis.call("PEXPIRE", KEYS[1], windowMs + 5000)
      else
        count = redis.call("HINCRBY", KEYS[1], "count", 1)
      end
      return {count, resetAt}
    `;
    try {
      const result = await this.eval(script, [rk], [Date.now(), windowMs]) as [number, number];
      return { count: result[0], resetAt: result[1] };
    } catch (err) {
      logger.warn("UpstashStore.incrementRateBucket failed, using fallback", {
        key,
        error: err instanceof Error ? err.message : String(err),
      });
      return this.fallback.incrementRateBucket(key, windowMs, _maxEntries);
    }
  }

  async evictExpiredRateBuckets(): Promise<void> {
    // Redis handles TTL-based eviction automatically via PEXPIRE. No-op here.
  }

  async getConnectionCount(ip: string): Promise<number> {
    try {
      const val = await this.cmd("GET", this.connKey(ip));
      return val === null ? 0 : Number(val);
    } catch (err) {
      logger.warn("UpstashStore.getConnectionCount failed, using fallback", {
        ip,
        error: err instanceof Error ? err.message : String(err),
      });
      return this.fallback.getConnectionCount(ip);
    }
  }

  async incrementConnectionCount(ip: string): Promise<void> {
    try {
      // INCR creates the key at 0 then increments to 1 if absent.
      // We use a 24-hour TTL as a safety net so leaked keys don't accumulate
      // forever if decrementConnectionCount is never called (e.g. crash).
      const script = `
        local val = redis.call("INCR", KEYS[1])
        redis.call("EXPIRE", KEYS[1], 86400)
        return val
      `;
      await this.eval(script, [this.connKey(ip)], []);
    } catch (err) {
      logger.warn("UpstashStore.incrementConnectionCount failed, using fallback", {
        ip,
        error: err instanceof Error ? err.message : String(err),
      });
      await this.fallback.incrementConnectionCount(ip);
    }
  }

  async decrementConnectionCount(ip: string): Promise<void> {
    try {
      const script = `
        local val = redis.call("DECR", KEYS[1])
        if val <= 0 then
          redis.call("DEL", KEYS[1])
        end
        return val
      `;
      await this.eval(script, [this.connKey(ip)], []);
    } catch (err) {
      logger.warn("UpstashStore.decrementConnectionCount failed, using fallback", {
        ip,
        error: err instanceof Error ? err.message : String(err),
      });
      await this.fallback.decrementConnectionCount(ip);
    }
  }

  /**
   * Auth-failure record stored as a Redis HASH:
   *   pcl:af:<ip>  →  { count, windowStart, bannedUntil }
   */
  async recordAuthFailure(
    ip: string,
    windowMs: number,
    banThreshold: number,
    banDurationMs: number,
    _maxEntries: number
  ): Promise<AuthFailureRecord> {
    const rk = this.afKey(ip);
    const script = `
      local now = tonumber(ARGV[1])
      local windowMs = tonumber(ARGV[2])
      local banThreshold = tonumber(ARGV[3])
      local banDurationMs = tonumber(ARGV[4])

      local count = tonumber(redis.call("HGET", KEYS[1], "count") or "0")
      local windowStart = tonumber(redis.call("HGET", KEYS[1], "windowStart") or tostring(now))
      local bannedUntil = tonumber(redis.call("HGET", KEYS[1], "bannedUntil") or "0")

      if now - windowStart > windowMs then
        count = 0
        windowStart = now
      end

      count = count + 1
      if count >= banThreshold then
        bannedUntil = now + banDurationMs
      end

      redis.call("HSET", KEYS[1], "count", count, "windowStart", windowStart, "bannedUntil", bannedUntil)
      -- Keep key alive until ban expires + window, or just 2x window if not banned
      local ttlMs = bannedUntil > 0 and (bannedUntil - now + banDurationMs) or (windowMs * 2)
      redis.call("PEXPIRE", KEYS[1], ttlMs)

      return {count, windowStart, bannedUntil}
    `;
    try {
      const result = await this.eval(script, [rk], [
        Date.now(),
        windowMs,
        banThreshold,
        banDurationMs,
      ]) as [number, number, number];
      return { count: result[0], windowStart: result[1], bannedUntil: result[2] };
    } catch (err) {
      logger.warn("UpstashStore.recordAuthFailure failed, using fallback", {
        ip,
        error: err instanceof Error ? err.message : String(err),
      });
      return this.fallback.recordAuthFailure(ip, windowMs, banThreshold, banDurationMs, _maxEntries);
    }
  }

  async isAuthBanned(ip: string): Promise<boolean> {
    try {
      const val = await this.cmd("HGET", this.afKey(ip), "bannedUntil");
      if (val === null) return false;
      const bannedUntil = Number(val);
      if (bannedUntil === 0) return false;
      if (Date.now() >= bannedUntil) {
        // Expired — delete key (best-effort, ignore error)
        this.cmd("DEL", this.afKey(ip)).catch(() => undefined);
        return false;
      }
      return true;
    } catch (err) {
      logger.warn("UpstashStore.isAuthBanned failed, using fallback", {
        ip,
        error: err instanceof Error ? err.message : String(err),
      });
      return this.fallback.isAuthBanned(ip);
    }
  }

  async evictExpiredAuthFailures(_windowMs: number, _banDurationMs: number): Promise<void> {
    // Redis TTL handles eviction automatically. No-op here.
  }
}

// ---------------------------------------------------------------------------
// Singleton factory
// ---------------------------------------------------------------------------

let _store: SharedStore | null = null;

/**
 * Returns the shared store singleton.
 *
 * - If UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are both set,
 *   returns an UpstashStore (shared across replicas).
 * - Otherwise returns an InMemoryStore (single-replica / dev).
 *
 * The choice is logged at startup so operators know which backend is active.
 * Call resetSharedStore() in tests to get a fresh instance per test.
 */
export function getSharedStore(): SharedStore {
  if (_store) return _store;

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (url && token) {
    logger.info("SharedStore: using Upstash Redis backend (multi-replica safe)", { url });
    _store = new UpstashStore(url, token);
  } else {
    logger.warn(
      "SharedStore: UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN not set — " +
        "using in-memory store. Abuse controls are per-replica only. " +
        "Set both env vars for multi-replica deployments."
    );
    _store = new InMemoryStore();
  }

  return _store;
}

/**
 * Replace the shared store singleton. Only for tests.
 */
export function resetSharedStore(store?: SharedStore): void {
  _store = store ?? null;
}
