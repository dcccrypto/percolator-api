import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";

vi.mock("@percolator/shared", () => ({
  sanitizeSlabAddress: vi.fn((addr: string) => addr),
  createLogger: vi.fn(() => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  })),
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

  describe("BLOCKED_MARKET_ADDRESSES env validation", () => {
    it("should drop invalid base58 entries and keep valid ones", async () => {
      // Set env before re-importing the module
      const validPubkey = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
      process.env.BLOCKED_MARKET_ADDRESSES = `${validPubkey},not-a-valid-key,truncated`;

      vi.resetModules();

      // Re-import after env change
      const { isBlockedSlab } = await import("../../src/middleware/validateSlab.js");

      // Valid pubkey should be blocked
      expect(isBlockedSlab(validPubkey)).toBe(true);
      // Invalid entries should have been dropped, not blocking anything
      expect(isBlockedSlab("not-a-valid-key")).toBe(false);
      expect(isBlockedSlab("truncated")).toBe(false);

      // Clean up
      delete process.env.BLOCKED_MARKET_ADDRESSES;
      vi.resetModules();
    });
  });

  describe("blocklist (GH#1357 / Sentry 2026-03-17)", () => {
    // These addresses are phantom-OI / empty-vault slabs that cause backend
    // 500s when queried. They are hardcoded so the API returns 404 even when called
    // directly, bypassing the Next.js proxy blocklist.
    const BLOCKED = [
      "3bmCyPee8GWJR5aPGTyN5EyyQJLzYyD8Wkg9m1Afd1SD",
      "3YDqCJGz88xGiPBiRvx4vrM51mWTiTZPZ95hxYDZqKpJ",
      "3ZKKwsKoo5UP28cYmMpvGpwoFpWLVgEWLQJCejJnECQn",
      // GH#1413: DfLoAzny/USD slab — was blocked in frontend blocklist.ts (PR #1415)
      // but missing from backend validateSlab; /api/open-interest/8eFFEFBY was returning
      // 200 with phantom 2T micro-unit OI data. Fixed by PR #1416.
      "8eFFEFBY3HHbBgzxJJP5hyxdzMNMAumnYNhkWXErBM4c",
    ];

    for (const addr of BLOCKED) {
      it(`returns 404 for blocked slab ${addr.slice(0, 8)}...`, async () => {
        const res = await app.request(`/markets/${addr}`);
        expect(res.status).toBe(404);
        const data = await res.json();
        expect(data).toEqual({ error: "Market not found" });
      });
    }

    it("still allows valid non-blocked slabs through", async () => {
      const valid = "11111111111111111111111111111111";
      const res = await app.request(`/markets/${valid}`);
      expect(res.status).toBe(200);
    });
  });
});
