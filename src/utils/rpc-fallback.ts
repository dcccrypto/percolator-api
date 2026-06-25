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
import { getFallbackConnection, createLogger, truncateErrorMessage } from "@percolator/shared";
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
      // Truncated like every other error-log call site in this codebase
      // (health.ts, markets.ts, etc.) — this was the one place that logged
      // the raw, untruncated message. truncateErrorMessage only bounds
      // length (it doesn't redact secrets), so this brings the exposure
      // window in line with the rest of the codebase rather than fully
      // eliminating it: RPC connection errors can embed the full endpoint
      // URL, and paid providers (Helius/Alchemy) embed an API key in that
      // URL, so a short error message could still leak it even truncated.
      error: truncateErrorMessage(
        primaryErr instanceof Error ? primaryErr.message : String(primaryErr),
        120,
      ),
    });

    return await withRpcTimeout(
      fn(getFallbackConnection()),
      `${operation}[fallback]`,
      timeoutMs,
    );
  }
}
