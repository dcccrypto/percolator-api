/**
 * OraclePriceBroadcaster
 *
 * Bridges cross-process state: the INDEXER (separate service) writes rows to
 * Supabase `oracle_prices` on every keeper oracle push. This service subscribes
 * to Supabase Realtime INSERT events on that table and fires a LOCAL
 * `price.updated` event on the api's `eventBus`. The existing WebSocket handler
 * in `routes/ws.ts` picks that up and fans out to clients subscribed to
 * `price:<slab>`.
 *
 * Without this, the api's `eventBus.on("price.updated")` handler waits for an
 * event that no in-process emitter fires — so frontends only see new prices on
 * page refresh, never live.
 *
 * REQUIRES the `oracle_prices` table to be added to Supabase's `supabase_realtime`
 * publication:
 *
 *   ALTER PUBLICATION supabase_realtime ADD TABLE oracle_prices;
 *
 * v17 NOTE: In v17 the keeper no longer dispatches a standalone oracle-push
 * instruction. Oracle prices are updated as a side-effect of PermissionlessCrank
 * (tag 5). The indexer will populate `oracle_prices` rows when it indexes crank
 * transactions. This broadcaster is correct as written — it will be a no-op until
 * the v17 indexer is deployed. No code change required here.
 * Reference: V17_SWEEP_RECONCILIATION_2026-06-08.md § "keeper" downstream specifics.
 */
import { eventBus, getSupabase, getNetwork, createLogger } from "@percolator/shared";
import type { RealtimeChannel } from "@supabase/supabase-js";

const logger = createLogger("api:price-broadcaster");

interface OraclePriceRow {
  slab_address: string;
  price_e6: string | number;
  timestamp: number;
  tx_signature: string | null;
  network: string;
}

/** Statuses Supabase Realtime's .subscribe() callback can report, plus the
 *  two states this class itself tracks before a subscription has ever been
 *  attempted or after stop() has been called. */
export type BroadcasterStatus =
  | "not_started"
  | "JOINING"
  | "SUBSCRIBED"
  | "CHANNEL_ERROR"
  | "TIMED_OUT"
  | "CLOSED"
  | "stopped";

const RECONNECT_BASE_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 30_000;

export class OraclePriceBroadcaster {
  private channel: RealtimeChannel | null = null;
  private started = false;
  private stopped = false;
  private lastStatus: BroadcasterStatus = "not_started";
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;

  /** Current Realtime subscription status — used by /health (see health.ts). */
  getStatus(): BroadcasterStatus {
    return this.lastStatus;
  }

  /** True only while genuinely subscribed and receiving live updates. */
  isHealthy(): boolean {
    return this.lastStatus === "SUBSCRIBED";
  }

  private scheduleReconnect(network: string): void {
    if (this.stopped || this.reconnectTimer) return;
    const delayMs = Math.min(
      RECONNECT_MAX_DELAY_MS,
      RECONNECT_BASE_DELAY_MS * 2 ** this.reconnectAttempt,
    );
    this.reconnectAttempt++;
    logger.warn("oracle-price broadcaster scheduling reconnect", {
      network,
      delayMs,
      attempt: this.reconnectAttempt,
    });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.started = false; // allow start() to actually run again
      this.start().catch((err) => {
        logger.error("oracle-price broadcaster reconnect attempt failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, delayMs);
    this.reconnectTimer.unref?.();
  }

  async start(): Promise<void> {
    if (this.started || this.stopped) return;
    this.started = true;

    const network = getNetwork();
    logger.info("oracle-price broadcaster starting", { network });
    try {
      const sb = getSupabase();
      this.channel = sb
        .channel("oracle-prices-broadcaster")
        .on(
          "postgres_changes",
          {
            event: "INSERT",
            schema: "public",
            table: "oracle_prices",
            filter: `network=eq.${network}`,
          },
          (payload) => {
            try {
              const row = payload.new as OraclePriceRow | undefined;
              if (!row || !row.slab_address) return;
              const priceE6 = typeof row.price_e6 === "string"
                ? Number(row.price_e6)
                : Number(row.price_e6);
              if (!Number.isFinite(priceE6) || priceE6 <= 0) return;

              logger.debug("oracle_prices insert received", {
                slab: row.slab_address,
                priceE6,
              });
              eventBus.publish("price.updated", row.slab_address, {
                priceE6,
                markPriceE6: priceE6,
                indexPriceE6: priceE6,
                source: "oracle_prices",
                tx_signature: row.tx_signature ?? undefined,
              });
            } catch (err) {
              logger.error("oracle_prices insert handler failed", {
                error: err instanceof Error ? err.message : String(err),
              });
            }
          },
        )
        .subscribe((status, err) => {
          // Log every status transition so we can see where we are if a
          // SUBSCRIBED never lands. Supabase Realtime emits: CHANNEL_ERROR,
          // TIMED_OUT, CLOSED, SUBSCRIBED — plus occasional JOINING.
          this.lastStatus = status as BroadcasterStatus;
          const fields: Record<string, unknown> = { status, network };
          if (err) fields.error = err instanceof Error ? err.message : String(err);
          if (status === "SUBSCRIBED") {
            logger.info("oracle-price broadcaster subscribed", fields);
            this.reconnectAttempt = 0; // backoff resets once a connection actually succeeds
          } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
            logger.error("oracle-price broadcaster channel problem", fields);
            // Without this, the channel stays dead until process restart —
            // Realtime does not retry on its own once it reports one of
            // these terminal statuses.
            this.started = false;
            this.scheduleReconnect(network);
          } else {
            logger.info("oracle-price broadcaster status", fields);
          }
        });
    } catch (err) {
      logger.error("failed to start oracle-price broadcaster", {
        error: err instanceof Error ? err.message : String(err),
      });
      this.started = false;
      this.scheduleReconnect(network);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.channel) {
      try {
        await getSupabase().removeChannel(this.channel);
      } catch {
        /* ignore */
      }
      this.channel = null;
    }
    this.started = false;
    this.lastStatus = "stopped";
  }
}

// Singleton accessor so health.ts can read the same instance index.ts
// starts, regardless of module import/call order — index.ts currently
// registers routes (including healthRoutes(), which reads this) before it
// creates and starts the broadcaster.
let _instance: OraclePriceBroadcaster | null = null;

export function getOraclePriceBroadcaster(): OraclePriceBroadcaster {
  if (!_instance) _instance = new OraclePriceBroadcaster();
  return _instance;
}
