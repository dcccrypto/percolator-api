import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { securityHeaders } from "../src/middleware/security-headers.js";

describe("securityHeaders", () => {
  it("preserves route-specific Content-Security-Policy headers", async () => {
    const app = new Hono();

    app.use("*", securityHeaders());
    app.get("/docs", (c) => {
      c.header(
        "Content-Security-Policy",
        "script-src 'self' unpkg.com 'sha256-test'; style-src 'self' unpkg.com 'unsafe-inline'",
      );
      return c.text("docs");
    });

    const res = await app.request("/docs");

    expect(res.headers.get("Content-Security-Policy")).toBe(
      "script-src 'self' unpkg.com 'sha256-test'; style-src 'self' unpkg.com 'unsafe-inline'",
    );
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("sets the default Content-Security-Policy when a route does not define one", async () => {
    const app = new Hono();

    app.use("*", securityHeaders());
    app.get("/markets", (c) => c.json({ ok: true }));

    const res = await app.request("/markets");
    const csp = res.headers.get("Content-Security-Policy");

    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self' unpkg.com");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it("preserves route-specific Cache-Control headers", async () => {
    const app = new Hono();

    app.use("*", securityHeaders());
    app.get("/cached", (c) => {
      c.header("Cache-Control", "public, max-age=60");
      return c.json({ ok: true });
    });

    const res = await app.request("/cached");

    expect(res.headers.get("Cache-Control")).toBe("public, max-age=60");
  });
});
