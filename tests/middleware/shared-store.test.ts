/**
 * Tests for the shared abuse-control store (issue #188).
 *
 * Covers:
 *   - InMemoryStore — rate bucket, connection counts, auth-failure bans
 *   - UpstashStore  — graceful fallback to in-memory when Redis call fails
 *   - Multi-replica property — two InMemoryStore instances independently; a
 *     shared InMemoryStore (simulating a shared backend) enforces limits across
 *     callers.
 *   - getSharedStore() singleton selection based on env vars
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  InMemoryStore,
  UpstashStore,
  getSharedStore,
  resetSharedStore,
} from "../../src/middleware/shared-store.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@percolator/shared", () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

// ---------------------------------------------------------------------------
// InMemoryStore — rate-bucket tests
// ---------------------------------------------------------------------------

describe("InMemoryStore — rate buckets", () => {
  it("increments count and returns it", async () => {
    const store = new InMemoryStore();
    const b1 = await store.incrementRateBucket("read:1.2.3.4", 60_000, 1000);
    expect(b1.count).toBe(1);
    const b2 = await store.incrementRateBucket("read:1.2.3.4", 60_000, 1000);
    expect(b2.count).toBe(2);
  });

  it("resets bucket after window expires", async () => {
    vi.useFakeTimers();
    const store = new InMemoryStore();
    for (let i = 0; i < 5; i++) {
      await store.incrementRateBucket("read:5.5.5.5", 60_000, 1000);
    }
    vi.advanceTimersByTime(61_000);
    const fresh = await store.incrementRateBucket("read:5.5.5.5", 60_000, 1000);
    expect(fresh.count).toBe(1);
    vi.useRealTimers();
  });

  it("keeps separate buckets for different keys", async () => {
    const store = new InMemoryStore();
    await store.incrementRateBucket("read:1.1.1.1", 60_000, 1000);
    await store.incrementRateBucket("read:1.1.1.1", 60_000, 1000);
    const other = await store.incrementRateBucket("read:2.2.2.2", 60_000, 1000);
    expect(other.count).toBe(1);
  });

  it("evicts entries when maxEntries is reached", async () => {
    const store = new InMemoryStore();
    // Fill up to maxEntries
    for (let i = 0; i < 5; i++) {
      await store.incrementRateBucket(`read:192.168.0.${i}`, 60_000, 5);
    }
    // Adding one more should evict an old entry and not throw
    const b = await store.incrementRateBucket("read:10.0.0.99", 60_000, 5);
    expect(b.count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// InMemoryStore — connection count tests
// ---------------------------------------------------------------------------

describe("InMemoryStore — connection counts", () => {
  it("starts at 0 for unknown IPs", async () => {
    const store = new InMemoryStore();
    expect(await store.getConnectionCount("auth:1.2.3.4")).toBe(0);
  });

  it("increments and decrements correctly", async () => {
    const store = new InMemoryStore();
    await store.incrementConnectionCount("auth:1.2.3.4");
    await store.incrementConnectionCount("auth:1.2.3.4");
    expect(await store.getConnectionCount("auth:1.2.3.4")).toBe(2);
    await store.decrementConnectionCount("auth:1.2.3.4");
    expect(await store.getConnectionCount("auth:1.2.3.4")).toBe(1);
  });

  it("removes key when count reaches 0", async () => {
    const store = new InMemoryStore();
    await store.incrementConnectionCount("auth:9.9.9.9");
    await store.decrementConnectionCount("auth:9.9.9.9");
    expect(await store.getConnectionCount("auth:9.9.9.9")).toBe(0);
  });

  it("does not go negative", async () => {
    const store = new InMemoryStore();
    await store.decrementConnectionCount("auth:0.0.0.0");
    expect(await store.getConnectionCount("auth:0.0.0.0")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// InMemoryStore — auth failure ban tests
// ---------------------------------------------------------------------------

describe("InMemoryStore — auth failure bans", () => {
  it("is not banned before threshold", async () => {
    const store = new InMemoryStore();
    for (let i = 0; i < 9; i++) {
      await store.recordAuthFailure("3.3.3.3", 60_000, 10, 300_000, 1000);
    }
    expect(await store.isAuthBanned("3.3.3.3")).toBe(false);
  });

  it("bans after hitting threshold", async () => {
    const store = new InMemoryStore();
    for (let i = 0; i < 10; i++) {
      await store.recordAuthFailure("4.4.4.4", 60_000, 10, 300_000, 1000);
    }
    expect(await store.isAuthBanned("4.4.4.4")).toBe(true);
  });

  it("ban expires after banDurationMs", async () => {
    vi.useFakeTimers();
    const store = new InMemoryStore();
    for (let i = 0; i < 10; i++) {
      await store.recordAuthFailure("5.5.5.5", 60_000, 10, 300_000, 1000);
    }
    expect(await store.isAuthBanned("5.5.5.5")).toBe(true);
    vi.advanceTimersByTime(300_001);
    expect(await store.isAuthBanned("5.5.5.5")).toBe(false);
    vi.useRealTimers();
  });

  it("resets failure count after window expires", async () => {
    vi.useFakeTimers();
    const store = new InMemoryStore();
    for (let i = 0; i < 9; i++) {
      await store.recordAuthFailure("6.6.6.6", 60_000, 10, 300_000, 1000);
    }
    expect(await store.isAuthBanned("6.6.6.6")).toBe(false);
    vi.advanceTimersByTime(61_000);
    // After window reset: 9 more failures but not at threshold yet
    for (let i = 0; i < 9; i++) {
      await store.recordAuthFailure("6.6.6.6", 60_000, 10, 300_000, 1000);
    }
    expect(await store.isAuthBanned("6.6.6.6")).toBe(false);
    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// Multi-replica property test
// ---------------------------------------------------------------------------

describe("multi-replica isolation vs shared backend", () => {
  it("per-replica InMemoryStores are independent (demonstrates the problem)", async () => {
    // Two replicas each with their own InMemoryStore — N=2 topology
    const replica1 = new InMemoryStore();
    const replica2 = new InMemoryStore();

    const MAX = 5;
    // Attacker sends 5 requests to replica1 — hits limit on replica1
    for (let i = 0; i < MAX; i++) {
      const b = await replica1.incrementRateBucket("read:attacker", 60_000, 1000);
      expect(b.count).toBeLessThanOrEqual(MAX);
    }
    const blocked = await replica1.incrementRateBucket("read:attacker", 60_000, 1000);
    expect(blocked.count).toBeGreaterThan(MAX);

    // But replica2 still lets them through — demonstrates the bug when each
    // replica has its own store.
    const onReplica2 = await replica2.incrementRateBucket("read:attacker", 60_000, 1000);
    expect(onReplica2.count).toBe(1); // replica2 sees count=1, not MAX+1
  });

  it("shared InMemoryStore instance enforces limits across callers (simulates Redis backend)", async () => {
    // Both "replicas" share the same store instance — same as Upstash Redis
    const sharedStore = new InMemoryStore();

    const MAX = 5;
    // Attacker sends 5 requests via "replica 1" path
    for (let i = 0; i < MAX; i++) {
      await sharedStore.incrementRateBucket("read:shared-attacker", 60_000, 1000);
    }

    // "Replica 2" now sees count > MAX because state is shared
    const overflow = await sharedStore.incrementRateBucket("read:shared-attacker", 60_000, 1000);
    expect(overflow.count).toBe(MAX + 1);
    // Caller would reject at count > MAX — exactly what Redis backend achieves
    expect(overflow.count).toBeGreaterThan(MAX);
  });
});

// ---------------------------------------------------------------------------
// UpstashStore — graceful fallback when Redis is unavailable
// ---------------------------------------------------------------------------

describe("UpstashStore — graceful fallback", () => {
  it("falls back to in-memory store when fetch fails", async () => {
    // Mock fetch to always reject (simulates Redis being unreachable)
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("Network unreachable"));

    const store = new UpstashStore("https://test.upstash.io", "token");
    // Should not throw; should fall back and return a valid bucket
    const bucket = await store.incrementRateBucket("read:1.2.3.4", 60_000, 1000);
    expect(bucket.count).toBe(1);

    globalThis.fetch = originalFetch;
  });

  it("falls back gracefully for connection counts", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("Network unreachable"));

    const store = new UpstashStore("https://test.upstash.io", "token");
    await expect(store.incrementConnectionCount("auth:1.2.3.4")).resolves.toBeUndefined();
    const count = await store.getConnectionCount("auth:1.2.3.4");
    // Falls back to in-memory which has 0 (separate fallback instance from increment)
    expect(typeof count).toBe("number");

    globalThis.fetch = originalFetch;
  });

  it("falls back gracefully for auth ban checks", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("Network unreachable"));

    const store = new UpstashStore("https://test.upstash.io", "token");
    // Should not throw; in-memory fallback returns false (not banned)
    const banned = await store.isAuthBanned("7.7.7.7");
    expect(banned).toBe(false);

    globalThis.fetch = originalFetch;
  });
});

// ---------------------------------------------------------------------------
// getSharedStore() singleton selection
// ---------------------------------------------------------------------------

describe("getSharedStore singleton", () => {
  beforeEach(() => {
    resetSharedStore();
  });

  afterEach(() => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    resetSharedStore();
  });

  it("returns InMemoryStore when env vars are absent", () => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    const store = getSharedStore();
    expect(store).toBeInstanceOf(InMemoryStore);
  });

  it("returns UpstashStore when both env vars are set", () => {
    process.env.UPSTASH_REDIS_REST_URL = "https://test.upstash.io";
    process.env.UPSTASH_REDIS_REST_TOKEN = "tok";
    const store = getSharedStore();
    expect(store).toBeInstanceOf(UpstashStore);
  });

  it("returns InMemoryStore when only URL is set (token missing)", () => {
    process.env.UPSTASH_REDIS_REST_URL = "https://test.upstash.io";
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    const store = getSharedStore();
    expect(store).toBeInstanceOf(InMemoryStore);
  });

  it("returns the same singleton on repeated calls", () => {
    const a = getSharedStore();
    const b = getSharedStore();
    expect(a).toBe(b);
  });

  it("resetSharedStore() forces a new instance", () => {
    const a = getSharedStore();
    resetSharedStore();
    const b = getSharedStore();
    expect(a).not.toBe(b);
  });
});
