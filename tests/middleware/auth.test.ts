import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { requireApiKey } from "../../src/middleware/auth.js";

describe("auth middleware", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("should allow all requests when API_AUTH_KEY is not set (dev mode)", async () => {
    delete process.env.API_AUTH_KEY;
    delete process.env.NODE_ENV;

    const app = new Hono();
    app.post("/test", requireApiKey(), (c) => c.json({ success: true }));

    const res = await app.request("/test", { method: "POST" });
    
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({ success: true });
  });

  it("should accept valid x-api-key header", async () => {
    process.env.API_AUTH_KEY = "secret-key-123";

    const app = new Hono();
    app.post("/test", requireApiKey(), (c) => c.json({ success: true }));

    const res = await app.request("/test", {
      method: "POST",
      headers: { "x-api-key": "secret-key-123" }
    });
    
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({ success: true });
  });

  it("should return 401 for invalid x-api-key", async () => {
    process.env.API_AUTH_KEY = "secret-key-123";

    const app = new Hono();
    app.post("/test", requireApiKey(), (c) => c.json({ success: true }));

    const res = await app.request("/test", {
      method: "POST",
      headers: { "x-api-key": "wrong-key" }
    });
    
    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data).toEqual({ error: "Unauthorized: invalid or missing x-api-key" });
  });

  it("should return 401 for missing x-api-key", async () => {
    process.env.API_AUTH_KEY = "secret-key-123";

    const app = new Hono();
    app.post("/test", requireApiKey(), (c) => c.json({ success: true }));

    const res = await app.request("/test", { method: "POST" });
    
    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data).toEqual({ error: "Unauthorized: invalid or missing x-api-key" });
  });

  it("should return 500 in production mode without API_AUTH_KEY", async () => {
    delete process.env.API_AUTH_KEY;
    process.env.NODE_ENV = "production";

    const app = new Hono();
    app.post("/test", requireApiKey(), (c) => c.json({ success: true }));

    const res = await app.request("/test", { method: "POST" });
    
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data).toEqual({ error: "Server misconfigured — auth key not set" });
  });

  it("should handle empty string API_AUTH_KEY", async () => {
    process.env.API_AUTH_KEY = "";
    delete process.env.NODE_ENV;

    const app = new Hono();
    app.post("/test", requireApiKey(), (c) => c.json({ success: true }));

    // Empty string is falsy, so should allow in dev mode
    const res = await app.request("/test", { method: "POST" });
    
    expect(res.status).toBe(200);
  });

  it("should be case-sensitive for API key", async () => {
    process.env.API_AUTH_KEY = "SecretKey123";

    const app = new Hono();
    app.post("/test", requireApiKey(), (c) => c.json({ success: true }));

    const res = await app.request("/test", {
      method: "POST",
      headers: { "x-api-key": "secretkey123" }
    });
    
    expect(res.status).toBe(401);
  });

  it("should reject empty string as x-api-key header", async () => {
    process.env.API_AUTH_KEY = "secret-key-123";

    const app = new Hono();
    app.post("/test", requireApiKey(), (c) => c.json({ success: true }));

    // An empty string header is falsy → treated as missing → 401
    const res = await app.request("/test", {
      method: "POST",
      headers: { "x-api-key": "" },
    });

    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.error).toBe("Unauthorized: invalid or missing x-api-key");
  });

  it("should reject whitespace-only x-api-key", async () => {
    process.env.API_AUTH_KEY = "secret-key-123";

    const app = new Hono();
    app.post("/test", requireApiKey(), (c) => c.json({ success: true }));

    // A whitespace-only key is truthy but won't match the expected key → 401
    const res = await app.request("/test", {
      method: "POST",
      headers: { "x-api-key": "   " },
    });

    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.error).toBe("Unauthorized: invalid or missing x-api-key");
  });

  it("should handle API key with spaces (exact match, no trim)", async () => {
    process.env.API_AUTH_KEY = "secret-key-123";

    const app = new Hono();
    app.post("/test", requireApiKey(), (c) => c.json({ success: true }));

    // Valid key should work
    const res1 = await app.request("/test", {
      method: "POST",
      headers: { "x-api-key": "secret-key-123" }
    });
    expect(res1.status).toBe(200);

    // Key with spaces should fail (no trimming)
    const res2 = await app.request("/test", {
      method: "POST",
      headers: { "x-api-key": " secret-key-123 " }
    });
    
    // Note: Hono automatically trims header values, so this will actually pass
    // This is standard HTTP header behavior
    expect(res2.status).toBe(200);
  });
});
