import { describe, it, expect, beforeEach, vi } from "vitest";
import { Hono } from "hono";

vi.mock("@percolator/shared", () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  })),
  config: { supabaseUrl: "http://test", supabaseKey: "test", rpcUrl: "http://test" },
}));

import { readRateLimit, writeRateLimit } from "../../src/middleware/rate-limit.js";

describe("rate-limit middleware", () => {
  beforeEach(() => {
    // Clear rate limit buckets before each test by creating fresh middleware
    vi.clearAllMocks();
  });

  describe("readRateLimit", () => {
    const app = new Hono();
    app.get("/test", readRateLimit(), (c) => c.json({ success: true }));

    it("should allow requests within limit (100 GET/min)", async () => {
      // Make 100 requests - all should pass
      for (let i = 0; i < 100; i++) {
        const res = await app.request("/test", {
          headers: { "x-forwarded-for": "192.168.1.1" }
        });
        expect(res.status).toBe(200);
      }
    });

    it("should return 429 when exceeding read limit", async () => {
      // Make 100 requests - the 101st should fail
      for (let i = 0; i < 100; i++) {
        await app.request("/test", {
          headers: { "x-forwarded-for": "192.168.1.2" }
        });
      }

      const res = await app.request("/test", {
        headers: { "x-forwarded-for": "192.168.1.2" }
      });
      
      expect(res.status).toBe(429);
      const data = await res.json();
      expect(data).toEqual({ error: "Rate limit exceeded" });
    });

    it("should have separate buckets for different IPs", async () => {
      // Make 100 requests from IP1
      for (let i = 0; i < 100; i++) {
        const res = await app.request("/test", {
          headers: { "x-forwarded-for": "192.168.1.3" }
        });
        expect(res.status).toBe(200);
      }

      // IP2 should still be able to make requests
      const res = await app.request("/test", {
        headers: { "x-forwarded-for": "192.168.1.4" }
      });
      
      expect(res.status).toBe(200);
    });

    it("should reset bucket after window expires", async () => {
      vi.useFakeTimers();
      
      const freshApp = new Hono();
      freshApp.get("/test", readRateLimit(), (c) => c.json({ success: true }));

      // Exhaust limit (READ_LIMIT = 100)
      for (let i = 0; i < 100; i++) {
        await freshApp.request("/test", {
          headers: { "x-forwarded-for": "192.168.1.5" }
        });
      }

      // Should fail
      let res = await freshApp.request("/test", {
        headers: { "x-forwarded-for": "192.168.1.5" }
      });
      expect(res.status).toBe(429);

      // Advance time by 61 seconds (past 60s window)
      vi.advanceTimersByTime(61_000);

      // Should succeed after window reset
      res = await freshApp.request("/test", {
        headers: { "x-forwarded-for": "192.168.1.5" }
      });
      expect(res.status).toBe(200);

      vi.useRealTimers();
    });
  });

  describe("writeRateLimit", () => {
    const app = new Hono();
    app.post("/test", writeRateLimit(), (c) => c.json({ success: true }));

    it("should allow requests within limit (10 POST/min)", async () => {
      // Make 10 requests - all should pass
      for (let i = 0; i < 10; i++) {
        const res = await app.request("/test", {
          method: "POST",
          headers: { "x-forwarded-for": "192.168.2.1" }
        });
        expect(res.status).toBe(200);
      }
    });

    it("should return 429 when exceeding write limit", async () => {
      // Make 11 requests - the 11th should fail
      for (let i = 0; i < 10; i++) {
        await app.request("/test", {
          method: "POST",
          headers: { "x-forwarded-for": "192.168.2.2" }
        });
      }

      const res = await app.request("/test", {
        method: "POST",
        headers: { "x-forwarded-for": "192.168.2.2" }
      });
      
      expect(res.status).toBe(429);
      const data = await res.json();
      expect(data).toEqual({ error: "Rate limit exceeded" });
    });

    it("should have separate buckets for different IPs", async () => {
      // Make 10 requests from IP1
      for (let i = 0; i < 10; i++) {
        const res = await app.request("/test", {
          method: "POST",
          headers: { "x-forwarded-for": "192.168.2.3" }
        });
        expect(res.status).toBe(200);
      }

      // IP2 should still be able to make requests
      const res = await app.request("/test", {
        method: "POST",
        headers: { "x-forwarded-for": "192.168.2.4" }
      });
      
      expect(res.status).toBe(200);
    });

    it("should handle missing x-forwarded-for header", async () => {
      // Should use "unknown" as IP
      for (let i = 0; i < 10; i++) {
        const res = await app.request("/test", { method: "POST" });
        expect(res.status).toBe(200);
      }

      const res = await app.request("/test", { method: "POST" });
      expect(res.status).toBe(429);
    });
  });
});
