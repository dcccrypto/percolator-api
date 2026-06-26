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

export class OraclePriceBroadcaster {
  private channel: RealtimeChannel | null = null;
  private started = false;

  async start(): Promise<void> {
    if (this.started) return;
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
              // oracle_prices carries only a single push price per row — there is
              // no separate mark/index price in this event source. Previously this
              // hardcoded markPriceE6/indexPriceE6 to the same oracle price, so
              // every live WS tick reported markPrice === indexPrice === oracle
              // price, contradicting the genuinely distinct values the same
              // channel sends from market_stats on initial subscribe (ws.ts
              // flushPriceUpdate's own `markPriceE6 ? ... : undefined` check
              // already exists to omit these fields when not genuinely known —
              // it was just never reachable because this was always truthy).
              eventBus.publish("price.updated", row.slab_address, {
                priceE6,
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
          const fields: Record<string, unknown> = { status, network };
          if (err) fields.error = err instanceof Error ? err.message : String(err);
          if (status === "SUBSCRIBED") {
            logger.info("oracle-price broadcaster subscribed", fields);
          } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
            logger.error("oracle-price broadcaster channel problem", fields);
          } else {
            logger.info("oracle-price broadcaster status", fields);
          }
        });
    } catch (err) {
      logger.error("failed to start oracle-price broadcaster", {
        error: err instanceof Error ? err.message : String(err),
      });
      this.started = false;
    }
  }

  async stop(): Promise<void> {
    if (this.channel) {
      try {
        await getSupabase().removeChannel(this.channel);
      } catch {
        /* ignore */
      }
      this.channel = null;
    }
    this.started = false;
  }
}
