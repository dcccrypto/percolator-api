import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";

vi.mock("@percolator/shared", () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

describe("TRUSTED_PROXY_DEPTH secure default behavior", () => {
  const oldDepth = process.env.TRUSTED_PROXY_DEPTH;
  const oldBlocklist = process.env.IP_BLOCKLIST;

  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("@hono/node-server/conninfo");
    delete process.env.TRUSTED_PROXY_DEPTH;
    delete process.env.IP_BLOCKLIST;
  });

  afterEach(() => {
    if (oldDepth === undefined) delete process.env.TRUSTED_PROXY_DEPTH;
    else process.env.TRUSTED_PROXY_DEPTH = oldDepth;

    if (oldBlocklist === undefined) delete process.env.IP_BLOCKLIST;
    else process.env.IP_BLOCKLIST = oldBlocklist;

    vi.doUnmock("@hono/node-server/conninfo");
    vi.resetModules();
  });

  function mockSocketIp(ip: string) {
    vi.doMock("@hono/node-server/conninfo", () => ({
      getConnInfo: vi.fn(() => ({
        remote: {
          address: ip,
        },
      })),
    }));
  }

  it("Regression: unset TRUSTED_PROXY_DEPTH ignores spoofed X-Forwarded-For and rate-limits by socket IP", async () => {
    mockSocketIp("10.0.0.1");

    const { readRateLimit } = await import("../../src/middleware/rate-limit.js");
    const { resetSharedStore, InMemoryStore } = await import("../../src/middleware/shared-store.js");

    resetSharedStore(new InMemoryStore());

    const app = new Hono();
    app.get("/test", readRateLimit(), (c) => c.json({ ok: true }));

    // Even though X-Forwarded-For rotates, the secure default must ignore it.
    // All requests should count against the mocked socket IP bucket.
    for (let i = 0; i < 100; i++) {
      const res = await app.request("/test", {
        headers: {
          "x-forwarded-for": `198.51.100.${i}`,
        },
      });

      expect(res.status).toBe(200);
    }

    const blocked = await app.request("/test", {
      headers: {
        "x-forwarded-for": "198.51.100.250",
      },
    });

    expect(blocked.status).toBe(429);
  });

  it("Regression: unset TRUSTED_PROXY_DEPTH uses socket IP for blocklist decision, not spoofed X-Forwarded-For", async () => {
    process.env.IP_BLOCKLIST = "10.0.0.1";
    mockSocketIp("10.0.0.1");

    const { ipBlocklist } = await import("../../src/middleware/ip-blocklist.js");

    const app = new Hono();
    app.get("/test", ipBlocklist(), (c) => c.json({ ok: true }));

    const res = await app.request("/test", {
      headers: {
        "x-forwarded-for": "198.51.100.77",
      },
    });

    // X-Forwarded-For is not blocklisted, but the socket IP is.
    // With the secure default, the request must be blocked.
    expect(res.status).toBe(403);
  });

  it("Explicit proxy mode: TRUSTED_PROXY_DEPTH=1 can still use X-Forwarded-For when intentionally configured", async () => {
    process.env.TRUSTED_PROXY_DEPTH = "1";
    process.env.IP_BLOCKLIST = "203.0.113.10";
    mockSocketIp("10.0.0.1");

    const { ipBlocklist } = await import("../../src/middleware/ip-blocklist.js");

    const app = new Hono();
    app.get("/test", ipBlocklist(), (c) => c.json({ ok: true }));

    const blockedViaTrustedProxyHeader = await app.request("/test", {
      headers: {
        "x-forwarded-for": "203.0.113.10",
      },
    });

    expect(blockedViaTrustedProxyHeader.status).toBe(403);

    const allowedViaTrustedProxyHeader = await app.request("/test", {
      headers: {
        "x-forwarded-for": "198.51.100.77",
      },
    });

    expect(allowedViaTrustedProxyHeader.status).toBe(200);
  });
});
