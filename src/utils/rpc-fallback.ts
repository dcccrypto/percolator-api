/**
 * RPC failover for read-only on-chain calls.
 *
 * Tries the primary connection first; on ANY error, retries once against
 * the fallback connection (FALLBACK_RPC_URL).  Each attempt is independently
 * wrapped in withRpcTimeout so a hung primary doesn't consume the fallback's
 * timeout budget.
 *
 * If FALLBACK_RPC_URL is not explicitly set, the original primary error is
 * re-thrown unchanged.  This prevents silent failover to the devnet default
 * that @percolator/shared uses when the env var is missing.
 */

import type { Connection } from "@solana/web3.js";
import { getFallbackConnection, createLogger } from "@percolator/shared";
import { withRpcTimeout } from "./rpc-timeout.js";

const logger = createLogger("api:rpc-fallback");

/** True only when the operator has explicitly configured a fallback RPC. */
const hasFallbackRpc = Boolean(process.env.FALLBACK_RPC_URL);

export async function withRpcFallback<T>(
  fn: (conn: Connection) => Promise<T>,
  primary: Connection,
  operation: string,
  timeoutMs?: number,
): Promise<T> {
  try {
    return await withRpcTimeout(fn(primary), operation, timeoutMs);
  } catch (primaryErr) {
    if (!hasFallbackRpc) {
      throw primaryErr; // no explicit fallback configured — re-throw original
    }

    logger.warn("Primary RPC failed, trying fallback", {
      operation,
      error: primaryErr instanceof Error ? primaryErr.message : String(primaryErr),
    });

    return await withRpcTimeout(
      fn(getFallbackConnection()),
      `${operation}[fallback]`,
      timeoutMs,
    );
  }
}
