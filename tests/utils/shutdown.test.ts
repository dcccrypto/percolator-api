/**
 * Tests for the shutdown-draining helpers, including BUG-102: the `ws`
 * library's own per-socket close-handshake timeout defaults to 30s — far
 * longer than this process's overall SHUTDOWN_TIMEOUT_MS (10s in index.ts).
 * drainWebSocketClients must force-terminate stuck clients within its own
 * bounded window so a single slow/unresponsive client can't make the
 * caller's wss.close() block past the overall shutdown budget.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { drainWebSocketClients, withTimeout } from "../../src/utils/shutdown.js";

function makeClient(opts: { selfCloses?: boolean } = {}) {
  const client = {
    close: vi.fn(() => {
      if (opts.selfCloses) client.terminate();
    }),
    terminate: vi.fn(),
  };
  return client;
}

describe("drainWebSocketClients", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("asks every client to close, then force-terminates any still present after timeoutMs", async () => {
    const stuckClient = makeClient({ selfCloses: false });
    const promise = drainWebSocketClients([stuckClient], 3000);

    expect(stuckClient.close).toHaveBeenCalledWith(1001, "Server shutting down");
    expect(stuckClient.terminate).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(3000);
    await promise;

    // Force-terminated because it never acked the close handshake (BUG-102's
    // exact scenario — without this, a real `ws` socket would still be open
    // 30s later, well past the 3s bound here).
    expect(stuckClient.terminate).toHaveBeenCalledTimes(1);
  });

  it("unconditionally terminates every client after the timeout, even one that already closed cleanly (a real ws socket's terminate() is a documented no-op when already closed)", async () => {
    const fastClient = makeClient({ selfCloses: true });
    const promise = drainWebSocketClients([fastClient], 3000);

    await vi.advanceTimersByTimeAsync(3000);
    await promise;

    expect(fastClient.close).toHaveBeenCalledTimes(1);
    expect(fastClient.terminate).toHaveBeenCalled();
  });

  it("does not block longer than timeoutMs regardless of how many clients are passed", async () => {
    const clients = Array.from({ length: 50 }, () => makeClient({ selfCloses: false }));
    const promise = drainWebSocketClients(clients, 3000);

    await vi.advanceTimersByTimeAsync(2999);
    // Not yet resolved — timer hasn't fired.
    let resolved = false;
    promise.then(() => { resolved = true; });
    await Promise.resolve();
    expect(resolved).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await promise;
    for (const c of clients) {
      expect(c.terminate).toHaveBeenCalledTimes(1);
    }
  });
});

describe("withTimeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves as soon as the promise resolves, without waiting for the timeout", async () => {
    let resolved = false;
    const fast = Promise.resolve().then(() => { resolved = true; });

    await withTimeout(fast, 2000);
    expect(resolved).toBe(true);
  });

  it("resolves anyway once ms elapses, even if the promise never settles (BUG-102: sendInfoAlert has no internal timeout)", async () => {
    const hanging = new Promise(() => {}); // never resolves/rejects
    const promise = withTimeout(hanging, 2000);

    await vi.advanceTimersByTimeAsync(2000);
    await expect(promise).resolves.toBeUndefined();
  });

  it("does not reject even if the underlying promise eventually rejects", async () => {
    const willReject = new Promise((_, reject) => {
      setTimeout(() => reject(new Error("boom")), 5000);
    });
    const promise = withTimeout(willReject, 2000);

    await vi.advanceTimersByTimeAsync(2000);
    await expect(promise).resolves.toBeUndefined();
    // Let the rejection actually fire so it doesn't leak as an unhandled
    // rejection into a later test — attach a no-op catch.
    await vi.advanceTimersByTimeAsync(3000);
    await willReject.catch(() => undefined);
  });
});
