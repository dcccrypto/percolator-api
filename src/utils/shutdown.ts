/**
 * Shutdown helpers extracted from index.ts so the bounded-draining logic is
 * independently unit-testable — index.ts itself has real side effects on
 * import (starts the HTTP server, registers signal handlers) and is not
 * unit-tested anywhere in this codebase.
 */

interface DrainableClient {
  close(code: number, reason: string): void;
  terminate(): void;
}

/**
 * Ask every client to close cleanly, then force-terminate any that haven't
 * within `timeoutMs`. Bounds how long WS draining can take regardless of
 * client behavior — the `ws` library's own per-socket close-handshake
 * timeout defaults to 30s, which would otherwise be free to block a
 * caller's own (typically much shorter) overall shutdown budget.
 */
export async function drainWebSocketClients(
  clients: Iterable<DrainableClient>,
  timeoutMs: number,
): Promise<void> {
  for (const client of clients) {
    client.close(1001, "Server shutting down");
  }
  await new Promise<void>((resolve) => setTimeout(resolve, timeoutMs));
  for (const client of clients) {
    client.terminate();
  }
}

/**
 * Await `promise`, but never wait longer than `ms` — resolves either way
 * rather than rejecting on timeout, since callers use this to bound a
 * best-effort step (e.g. a webhook call) that shouldn't block shutdown.
 */
export async function withTimeout(promise: Promise<unknown>, ms: number): Promise<void> {
  await Promise.race([
    promise,
    new Promise<void>((resolve) => setTimeout(resolve, ms)),
  ]);
}
