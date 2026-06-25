/**
 * Tests for the response cache middleware, including BUG-004 in-flight
 * coalescing: concurrent misses for the same key must not each independently
 * re-run the handler and race to overwrite the cache.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { cacheMiddleware, clearCache } from "../../src/middleware/cache.js";

describe("cacheMiddleware", () => {
  beforeEach(() => {
    clearCache();
  });

  it("serves a cache HIT on a second sequential request without re-running the handler", async () => {
    let callCount = 0;
    const app = new Hono();
    app.get("/test", cacheMiddleware(30), (c) => {
      callCount++;
      return c.json({ count: callCount });
    });

    const res1 = await app.request("/test");
    expect(res1.status).toBe(200);
    expect(res1.headers.get("X-Cache")).toBe("MISS");
    const body1 = await res1.json();

    const res2 = await app.request("/test");
    expect(res2.headers.get("X-Cache")).toBe("HIT");
    const body2 = await res2.json();

    expect(body1).toEqual(body2);
    expect(callCount).toBe(1);
  });

  it("returns a 304 with a matching ETag on a conditional request", async () => {
    const app = new Hono();
    app.get("/test", cacheMiddleware(30), (c) => c.json({ hello: "world" }));

    const res1 = await app.request("/test");
    const etag = res1.headers.get("ETag");
    expect(etag).toBeTruthy();

    const res2 = await app.request("/test", { headers: { "If-None-Match": etag! } });
    expect(res2.status).toBe(304);
  });

  it("coalesces concurrent misses for the same key into a single handler invocation (BUG-004)", async () => {
    let callCount = 0;
    let resolveHandler: (value: number) => void;
    const app = new Hono();
    app.get("/test", cacheMiddleware(30), async (c) => {
      callCount++;
      const value = await new Promise<number>((resolve) => {
        resolveHandler = resolve;
      });
      return c.json({ value });
    });

    // Two concurrent requests for the same key, neither awaited before the
    // other starts — the exact thundering-herd scenario from BUG-004.
    const reqA = app.request("/test");
    const reqB = app.request("/test");

    // Both requests have already reached the coalescing check (the handler
    // is suspended on the unresolved promise below) — a second invocation
    // here would prove de-duplication failed.
    expect(callCount).toBe(1);

    resolveHandler!(42);

    const [resA, resB] = await Promise.all([reqA, reqB]);
    expect(await resA.json()).toEqual({ value: 42 });
    expect(await resB.json()).toEqual({ value: 42 });
    expect(resA.headers.get("X-Cache")).toBe("MISS");
    expect(resB.headers.get("X-Cache")).toBe("MISS-COALESCED");
    expect(callCount).toBe(1);
  });

  it("does not let a slower request overwrite a faster concurrent request's cached result (BUG-004)", async () => {
    // Regression for the original bug: before coalescing, two concurrent
    // misses each ran the handler and both unconditionally wrote the cache —
    // whichever resolved LAST won, even if it wasn't the request that
    // "should" have been served. With coalescing there is only one handler
    // invocation per miss episode, so this scenario can no longer occur.
    let callCount = 0;
    const app = new Hono();
    app.get("/test", cacheMiddleware(30), async (c) => {
      callCount++;
      return c.json({ value: "only-possible-value" });
    });

    const [resA, resB] = await Promise.all([app.request("/test"), app.request("/test")]);
    expect(await resA.json()).toEqual({ value: "only-possible-value" });
    expect(await resB.json()).toEqual({ value: "only-possible-value" });
    expect(callCount).toBe(1);
  });

  it("falls back to re-running the handler for a follower when the leader's response isn't cacheable", async () => {
    let callCount = 0;
    const app = new Hono();
    app.get("/test", cacheMiddleware(30), async (c) => {
      callCount++;
      if (callCount === 1) {
        // Leader's response: an error — not cacheable, nothing to replay.
        await new Promise((r) => setTimeout(r, 10));
        return c.json({ error: "boom" }, 500);
      }
      return c.json({ ok: true });
    });

    const [resA, resB] = await Promise.all([app.request("/test"), app.request("/test")]);

    expect(resA.status).toBe(500);
    expect(resB.status).toBe(200);
    expect(await resB.json()).toEqual({ ok: true });
    expect(callCount).toBe(2);
  });

  it("does not coalesce sequential, non-overlapping requests differently than before (no-op for the non-concurrent case)", async () => {
    let callCount = 0;
    const app = new Hono();
    app.get("/test", cacheMiddleware(30), (c) => {
      callCount++;
      return c.json({ count: callCount });
    });

    await app.request("/test");
    clearCache(); // force a fresh miss
    await app.request("/test");

    expect(callCount).toBe(2);
  });
});
