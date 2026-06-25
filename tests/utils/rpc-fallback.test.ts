/**
 * Tests for the RPC failover utility, including BUG-007: the primary-RPC
 * failure log must be truncated like every other error-log call site in
 * this codebase, not log the raw, potentially URL/API-key-bearing message.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const warnSpy = vi.fn();

vi.mock("@percolator/shared", () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: warnSpy,
    error: vi.fn(),
    debug: vi.fn(),
  })),
  getFallbackConnection: vi.fn(() => ({})),
  // Real implementation (mirrors @percolator/shared's actual behavior):
  // bounds length only, does not redact secrets.
  truncateErrorMessage: (msg: unknown, maxLength = 120) => {
    const str = typeof msg === "string" ? msg : String(msg ?? "");
    return str.length > maxLength ? str.slice(0, maxLength) + "..." : str;
  },
}));

async function loadWithRpcFallback() {
  vi.resetModules();
  const mod = await import("../../src/utils/rpc-fallback.js");
  return mod.withRpcFallback;
}

describe("withRpcFallback", () => {
  beforeEach(() => {
    warnSpy.mockClear();
  });

  afterEach(() => {
    delete process.env.FALLBACK_RPC_URL;
  });

  it("re-throws the original error unchanged when no fallback RPC is configured", async () => {
    delete process.env.FALLBACK_RPC_URL;
    const withRpcFallback = await loadWithRpcFallback();

    const primaryErr = new Error("boom");
    const fn = vi.fn().mockRejectedValue(primaryErr);

    await expect(withRpcFallback(fn, {} as any, "test-op")).rejects.toThrow("boom");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("falls back to the secondary connection and returns its result on primary failure", async () => {
    process.env.FALLBACK_RPC_URL = "https://fallback.example.com";
    const withRpcFallback = await loadWithRpcFallback();

    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("primary down"))
      .mockResolvedValueOnce("fallback-result");

    const result = await withRpcFallback(fn, {} as any, "test-op");
    expect(result).toBe("fallback-result");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("truncates a long primary-RPC error message before logging it, instead of logging it raw (BUG-007)", async () => {
    process.env.FALLBACK_RPC_URL = "https://fallback.example.com";
    const withRpcFallback = await loadWithRpcFallback();

    // Simulates an RPC connection error whose message embeds the full
    // endpoint URL — paid providers (Helius/Alchemy) embed an API key in
    // that URL per .env.example.
    const longUrl =
      "https://rpc.helius.xyz/?api-key=SUPER-SECRET-KEY-1234567890" + "x".repeat(200);
    const primaryErr = new Error(`fetch failed: ${longUrl}`);
    const fn = vi.fn()
      .mockRejectedValueOnce(primaryErr)
      .mockResolvedValueOnce("fallback-result");

    const result = await withRpcFallback(fn, {} as any, "test-op");
    expect(result).toBe("fallback-result");

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const loggedError = warnSpy.mock.calls[0][1].error as string;
    // 120 chars + the "..." suffix truncateErrorMessage appends.
    expect(loggedError.length).toBeLessThanOrEqual(123);
    expect(loggedError).not.toBe(primaryErr.message);
  });
});
