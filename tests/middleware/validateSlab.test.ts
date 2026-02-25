import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";

vi.mock("@percolator/shared", () => ({
  sanitizeSlabAddress: vi.fn((addr: string) => addr),
  config: { supabaseUrl: "http://test", supabaseKey: "test", rpcUrl: "http://test" },
}));

import { validateSlab } from "../../src/middleware/validateSlab.js";

describe("validateSlab middleware", () => {
  const app = new Hono();
  app.get("/markets/:slab", validateSlab, (c) => c.json({ success: true }));
  app.get("/test", validateSlab, (c) => c.json({ success: true }));

  it("should pass through valid Solana public key", async () => {
    const validSlab = "11111111111111111111111111111111";
    const res = await app.request(`/markets/${validSlab}`);
    
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({ success: true });
  });

  it("should return 400 for invalid base58 string", async () => {
    const invalidSlab = "invalid-base58-string!@#$";
    const res = await app.request(`/markets/${invalidSlab}`);
    
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data).toEqual({ error: "Invalid slab address" });
  });

  it("should pass through when slab param is missing", async () => {
    const res = await app.request("/test");
    
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({ success: true });
  });

  it("should return 400 for too-short string", async () => {
    const tooShort = "short";
    const res = await app.request(`/markets/${tooShort}`);
    
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data).toEqual({ error: "Invalid slab address" });
  });

  it("should handle empty string param (routing behavior)", async () => {
    // Empty param in route (/markets/) means the route doesn't match
    // Hono will return 404 for unmatched routes
    const res = await app.request("/markets/");
    
    // This is a routing issue, not a validation issue
    expect(res.status).toBe(404);
  });

  it("should accept valid base58 addresses of varying lengths", async () => {
    // Test with actual Solana address format
    const validAddresses = [
      "11111111111111111111111111111111",
      "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      "So11111111111111111111111111111111111111112"
    ];

    for (const addr of validAddresses) {
      const res = await app.request(`/markets/${addr}`);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toEqual({ success: true });
    }
  });

  it("should reject string with invalid base58 characters", async () => {
    // Base58 doesn't include 0, O, I, l
    const invalidChars = "11111111111111111111111111111110"; // contains '0'
    const res = await app.request(`/markets/${invalidChars}`);
    
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data).toEqual({ error: "Invalid slab address" });
  });

  it("should reject extremely long input (DoS prevention)", async () => {
    // An attacker may send a very long string to cause slow processing or regex backtracking
    const longInput = "a".repeat(10_000);
    const res = await app.request(`/markets/${longInput}`);

    // Should quickly reject with 400 (no hang/timeout)
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data).toEqual({ error: "Invalid slab address" });
  });

  it("should reject input containing null bytes", async () => {
    // Null bytes can cause issues in some validators and should be rejected
    // URL-encode null byte as %00 so the HTTP request is well-formed
    const withNullByte = "1111111111111111111111%001111111111";
    const res = await app.request(`/markets/${withNullByte}`);

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data).toEqual({ error: "Invalid slab address" });
  });
});
