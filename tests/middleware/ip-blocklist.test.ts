/**
 * ip-blocklist middleware tests.
 *
 * The middleware captures IP_BLOCKLIST and TRUSTED_PROXY_DEPTH at module-load
 * time, so we must reset modules and re-import per test to pick up env changes.
 *
 * X-Forwarded-For parsing (PROXY_DEPTH=N):
 *   idx = max(0, ips.length - N)
 *   so the resolved client IP is ips[idx] — the Nth-from-the-right entry.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";

type MiddlewareFn = (c: unknown, next: unknown) => Promise<unknown>;

async function buildApp(
  blocklist?: string,
  proxyDepth?: string,
): Promise<Hono> {
  // Set env vars BEFORE importing the module so constants are captured fresh.
  if (blocklist !== undefined) {
    process.env.IP_BLOCKLIST = blocklist;
  } else {
    delete process.env.IP_BLOCKLIST;
  }
  if (proxyDepth !== undefined) {
    process.env.TRUSTED_PROXY_DEPTH = proxyDepth;
  } else {
    delete process.env.TRUSTED_PROXY_DEPTH;
  }

  vi.resetModules();
  const { ipBlocklistMiddleware } = await import(
    "../../src/middleware/ip-blocklist.js"
  );

  const app = new Hono();
  app.use("*", (ipBlocklistMiddleware as () => MiddlewareFn)());
  app.get("/test", (c) => c.json({ ok: true }));
  return app;
}

describe("ipBlocklistMiddleware", () => {
  let savedEnv: typeof process.env;

  beforeEach(() => {
    savedEnv = { ...process.env };
  });

  afterEach(() => {
    // Restore env and clear module cache so next test starts clean.
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) delete process.env[key];
    }
    Object.assign(process.env, savedEnv);
    vi.resetModules();
  });

  it("allows all requests when IP_BLOCKLIST is empty", async () => {
    const app = await buildApp("");
    const res = await app.request("/test", {
      headers: { "x-forwarded-for": "1.2.3.4" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("allows requests when IP_BLOCKLIST is not set", async () => {
    const app = await buildApp(undefined);
    const res = await app.request("/test", {
      headers: { "x-forwarded-for": "1.2.3.4" },
    });
    expect(res.status).toBe(200);
  });

  it("blocks a single matching IP (PROXY_DEPTH=1)", async () => {
    // PROXY_DEPTH=1: idx = max(0, n-1)
    // With "10.0.0.1, 5.6.7.8": n=2, idx=1 → resolved IP = "5.6.7.8"
    const app = await buildApp("5.6.7.8", "1");
    const res = await app.request("/test", {
      headers: { "x-forwarded-for": "10.0.0.1, 5.6.7.8" },
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toEqual({ error: "Forbidden" });
  });

  it("allows a non-blocked IP (PROXY_DEPTH=1)", async () => {
    // Resolved IP = "9.9.9.9" (rightmost) → not blocked
    const app = await buildApp("5.6.7.8", "1");
    const res = await app.request("/test", {
      headers: { "x-forwarded-for": "10.0.0.1, 9.9.9.9" },
    });
    expect(res.status).toBe(200);
  });

  it("blocks any of multiple comma-separated IPs in blocklist", async () => {
    // Resolved IP = "2.2.2.2" (rightmost with PROXY_DEPTH=1)
    const app = await buildApp("1.1.1.1, 2.2.2.2, 5.6.7.8", "1");
    const res = await app.request("/test", {
      headers: { "x-forwarded-for": "8.8.8.8, 2.2.2.2" },
    });
    expect(res.status).toBe(403);
  });

  it("allows IP not in a multi-entry blocklist", async () => {
    const app = await buildApp("1.1.1.1, 2.2.2.2", "1");
    const res = await app.request("/test", {
      headers: { "x-forwarded-for": "8.8.8.8, 3.3.3.3" },
    });
    expect(res.status).toBe(200);
  });

  it("falls back to x-real-ip when TRUSTED_PROXY_DEPTH=0", async () => {
    const app = await buildApp("5.6.7.8", "0");
    const res = await app.request("/test", {
      headers: { "x-real-ip": "5.6.7.8" },
    });
    expect(res.status).toBe(403);
  });

  it("allows requests with unknown IP when no forwarding headers present", async () => {
    // No x-forwarded-for or x-real-ip → resolved as "unknown" → never blocked
    const app = await buildApp("5.6.7.8", "1");
    const res = await app.request("/test", {});
    expect(res.status).toBe(200);
  });
});
