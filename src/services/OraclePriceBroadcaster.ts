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

              eventBus.publish("price.updated", row.slab_address, {
                priceE6,
                // For a Hyperp, mark and index converge on the oracle value
                // pushed here. The frontend uses whichever the ws.ts handler
                // formats into the outbound JSON.
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
        .subscribe((status) => {
          if (status === "SUBSCRIBED") {
            logger.info("oracle-price broadcaster subscribed", { network });
          } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
            logger.error("oracle-price broadcaster channel status", { status, network });
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
