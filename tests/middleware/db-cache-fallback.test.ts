import { describe, it, expect, beforeEach, vi } from "vitest";
import { Hono } from "hono";

vi.mock("@percolator/shared", () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
  truncateErrorMessage: vi.fn((s: string) => s),
}));

import { withDbCacheFallback, clearDbCache } from "../../src/middleware/db-cache-fallback.js";

function makeApp(handler: (c: any) => Promise<Response>) {
  const app = new Hono();
  app.get("/test", handler);
  return app;
}

describe("withDbCacheFallback", () => {
  beforeEach(() => {
    clearDbCache();
  });

  it("returns DbCacheResult on success with stale=false and ok=true", async () => {
    const app = makeApp(async (c) => {
      const result = await withDbCacheFallback(
        "test:success",
        async () => ({ rows: [1, 2, 3] }),
        c,
      );
      if (result instanceof Response) return result;
      expect(result.ok).toBe(true);
      expect(result.stale).toBe(false);
      return c.json(result.data);
    });

    const res = await app.request("/test");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ rows: [1, 2, 3] });
  });

  it("returns a 503 Response when the query fails and the cache is empty", async () => {
    const app = makeApp(async (c) => {
      const result = await withDbCacheFallback(
        "test:no-cache",
        async () => {
          throw new Error("DB down");
        },
        c,
      );
      if (result instanceof Response) return result;
      return c.json(result.data);
    });

    const res = await app.request("/test");
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe("Database temporarily unavailable");
  });

  it("returns stale cached data with stale=true on failure within MAX_STALE_AGE_MS", async () => {
    // First call: succeeds and seeds the cache.
    const seedApp = makeApp(async (c) => {
      const result = await withDbCacheFallback(
        "test:stale",
        async () => ({ value: "fresh" }),
        c,
      );
      if (result instanceof Response) return result;
      return c.json(result.data);
    });
    const seed = await seedApp.request("/test");
    expect(seed.status).toBe(200);

    // Second call: query throws — middleware should serve the stale entry.
    let observedStale: boolean | undefined;
    const fallbackApp = makeApp(async (c) => {
      const result = await withDbCacheFallback(
        "test:stale",
        async () => {
          throw new Error("DB down");
        },
        c,
      );
      if (result instanceof Response) return result;
      observedStale = result.stale;
      return c.json(result.data);
    });

    const res = await fallbackApp.request("/test");
    expect(res.status).toBe(200);
    expect(observedStale).toBe(true);
    expect(await res.json()).toEqual({ value: "fresh" });
    // Headers set by the middleware persist on the context and reach the client.
    expect(res.headers.get("X-Cache-Status")).toBe("stale-fallback");
    expect(res.headers.get("Warning")).toMatch(/^110 - "Response is Stale/);
  });

  it("coalesces concurrent calls for the same key into a single queryFn invocation (BUG-004)", async () => {
    let resolveQuery: (value: { value: string }) => void;
    const queryFn = vi.fn(
      () =>
        new Promise<{ value: string }>((resolve) => {
          resolveQuery = resolve;
        }),
    );

    const app = makeApp(async (c) => {
      const result = await withDbCacheFallback("test:coalesce", queryFn, c);
      if (result instanceof Response) return result;
      return c.json(result.data);
    });

    // Two concurrent callers for the same key, neither awaited before the
    // other starts — exactly the thundering-herd scenario from BUG-004.
    const reqA = app.request("/test");
    const reqB = app.request("/test");

    // Both requests have reached the coalescing check by now (queryFn's
    // promise hasn't resolved yet), so a second invocation here would prove
    // de-duplication failed.
    expect(queryFn).toHaveBeenCalledTimes(1);

    resolveQuery!({ value: "shared-result" });

    const [resA, resB] = await Promise.all([reqA, reqB]);
    expect(await resA.json()).toEqual({ value: "shared-result" });
    expect(await resB.json()).toEqual({ value: "shared-result" });
    expect(queryFn).toHaveBeenCalledTimes(1);
  });
});
