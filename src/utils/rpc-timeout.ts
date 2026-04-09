/**
 * Timeout wrapper for RPC calls that don't accept AbortSignal.
 *
 * fetchSlab() and getConnection().getSlot() from the SDK/shared libs take a
 * Connection object, not an AbortSignal, so AbortSignal.timeout() cannot be
 * threaded through.  Promise.race is the only viable approach.
 *
 * The underlying RPC call is NOT cancelled — Node will GC the dangling promise
 * once it settles.  This is acceptable because fetchSlab/getSlot are read-only.
 */

const DEFAULT_RPC_TIMEOUT_MS = 10_000;
const DEFAULT_HEALTH_RPC_TIMEOUT_MS = 5_000;

export const RPC_TIMEOUT_MS: number =
  Number(process.env.RPC_TIMEOUT_MS) || DEFAULT_RPC_TIMEOUT_MS;

export const HEALTH_RPC_TIMEOUT_MS: number =
  Number(process.env.HEALTH_RPC_TIMEOUT_MS) || DEFAULT_HEALTH_RPC_TIMEOUT_MS;

export class RpcTimeoutError extends Error {
  public readonly timeoutMs: number;

  constructor(operation: string, timeoutMs: number) {
    super(`RPC timeout: ${operation} did not complete within ${timeoutMs}ms`);
    this.name = "RpcTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export function withRpcTimeout<T>(
  promise: Promise<T>,
  operation: string,
  timeoutMs: number = RPC_TIMEOUT_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new RpcTimeoutError(operation, timeoutMs)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer!));
}
