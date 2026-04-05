import { Hono } from "hono";
import { PublicKey } from "@solana/web3.js";
import { validateSlab, isBlockedSlab } from "../middleware/validateSlab.js";
import { cacheMiddleware } from "../middleware/cache.js";
import { withDbCacheFallback } from "../middleware/db-cache-fallback.js";
import { fetchSlab, parseHeader, parseConfig, parseEngine } from "@percolator/sdk";
import { getConnection, getSupabase, getNetwork, createLogger, sanitizeSlabAddress, truncateErrorMessage } from "@percolator/shared";

const logger = createLogger("api:markets");

export function marketRoutes(): Hono {
  const app = new Hono();

  // GET /markets — list all markets from Supabase (uses markets_with_stats view for performance)
  app.get("/markets", async (c) => {
    const result = await withDbCacheFallback(
      "markets:all",
      async () => {
        // Use the markets_with_stats view for a single optimized query.
        // GH#1781: Exclude rows with null slab_address at the DB layer — these are
        // incomplete "zombie" market records (TEST x2, BREW, LOBSTAR) that have no
        // on-chain account and cannot be indexed. BLOCKED_MARKET_ADDRESSES.has(null)
        // is false so they would otherwise slip through the JS filter below.
        // Filter by network to prevent devnet/mainnet data mixing (PERC-8192).
        const { data, error } = await getSupabase()
          .from("markets_with_stats")
          .select("slab_address, mint_address, symbol, name, decimals, deployer, oracle_authority, initial_price_e6, max_leverage, trading_fee_bps, lp_collateral, matcher_context, status, logo_url, created_at, updated_at, total_open_interest, total_accounts, last_crank_slot, last_price, mark_price, index_price, funding_rate, net_lp_pos")
          .eq("network", getNetwork())
          .not("slab_address", "is", null);

        if (error) throw error;

        return (data ?? [])
          .filter((m) => !isBlockedSlab(m.slab_address))
          .map((m) => ({
          slabAddress: m.slab_address,
          mintAddress: m.mint_address,
          symbol: m.symbol,
          name: m.name,
          decimals: m.decimals,
          deployer: m.deployer,
          oracleAuthority: m.oracle_authority,
          initialPriceE6: m.initial_price_e6,
          maxLeverage: m.max_leverage,
          tradingFeeBps: m.trading_fee_bps,
          lpCollateral: m.lp_collateral,
          matcherContext: m.matcher_context,
          status: m.status,
          logoUrl: m.logo_url,
          createdAt: m.created_at,
          updatedAt: m.updated_at,
          // Stats from the view
          totalOpenInterest: m.total_open_interest ?? null,
          totalAccounts: m.total_accounts ?? null,
          lastCrankSlot: m.last_crank_slot ?? null,
          lastPrice: (m.last_price != null && Number.isFinite(m.last_price) && m.last_price > 0 && m.last_price <= 1_000_000_000) ? m.last_price : null,
          // Fallback chain: mark_price → initial_price_e6 (converted from E6 to USD).
          // Markets that haven't been cranked yet have null mark_price in the stats view,
          // but still have a valid initial_price_e6 from market creation.
          markPrice: (m.mark_price != null && Number.isFinite(m.mark_price) && m.mark_price > 0 && m.mark_price <= 1_000_000_000)
            ? m.mark_price
            : (m.initial_price_e6 != null && m.initial_price_e6 > 0)
              ? Number(m.initial_price_e6) / 1_000_000
              : null,
          indexPrice: (m.index_price != null && Number.isFinite(m.index_price) && m.index_price > 0 && m.index_price <= 1_000_000_000) ? m.index_price : null,
          fundingRate: (m.funding_rate != null && Number.isFinite(m.funding_rate) && Math.abs(m.funding_rate) <= 10_000) ? m.funding_rate : null,
          netLpPos: m.net_lp_pos ?? null,
        }));
      },
      c
    );
    
    // If result is a Response (error case), return it directly
    if (result instanceof Response) {
      return result;
    }
    
    return c.json({ markets: result });
  });

  // GET /markets/stats — all market stats from DB (filtered by network)
  app.get("/markets/stats", async (c) => {
    try {
      const { data, error } = await getSupabase()
        .from("markets_with_stats")
        .select("slab_address, total_open_interest, total_accounts, last_crank_slot, last_price, mark_price, index_price, funding_rate, net_lp_pos, updated_at")
        .eq("network", getNetwork())
        .not("slab_address", "is", null);
      if (error) throw error;
      return c.json({ stats: data ?? [] });
    } catch (err) {
      logger.error("Error fetching all market stats", {
        error: truncateErrorMessage(err instanceof Error ? err.message : String(err), 120),
      });
      return c.json({ error: "Failed to fetch market stats" }, 500);
    }
  });

  // GET /markets/:slab/stats — single market stats from DB
  app.get("/markets/:slab/stats", validateSlab, async (c) => {
    const slab = c.req.param("slab");
    try {
      const { data, error } = await getSupabase()
        .from("market_stats")
        .select("slab_address, total_open_interest, total_accounts, last_crank_slot, last_price, mark_price, index_price, funding_rate, net_lp_pos, updated_at")
        .eq("slab_address", slab)
        .single();
      if (error && error.code !== "PGRST116") throw error;
      return c.json({ stats: data ?? null });
    } catch (err) {
      logger.error("Error fetching market stats", {
        slab,
        error: truncateErrorMessage(err instanceof Error ? err.message : String(err), 120),
      });
      return c.json({ error: "Failed to fetch market stats" }, 500);
    }
  });

  // GET /markets/:slab — single market details (on-chain read) — 10s cache
  app.get("/markets/:slab", cacheMiddleware(10), validateSlab, async (c) => {
    const slab = c.req.param("slab");
    if (!slab) return c.json({ error: "slab required" }, 400);
    try {
      const connection = getConnection();
      const slabPubkey = new PublicKey(slab);
      const data = await fetchSlab(connection, slabPubkey);
      const header = parseHeader(data);
      const cfg = parseConfig(data);
      const engine = parseEngine(data);

      return c.json({
        slabAddress: slab,
        header: {
          magic: header.magic.toString(),
          version: header.version,
          admin: header.admin.toBase58(),
          resolved: header.resolved,
        },
        config: {
          collateralMint: cfg.collateralMint.toBase58(),
          vault: cfg.vaultPubkey.toBase58(),
          oracleAuthority: cfg.oracleAuthority.toBase58(),
          authorityPriceE6: cfg.authorityPriceE6.toString(),
        },
        engine: {
          vault: engine.vault.toString(),
          totalOpenInterest: engine.totalOpenInterest.toString(),
          numUsedAccounts: engine.numUsedAccounts,
          lastCrankSlot: engine.lastCrankSlot.toString(),
        },
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : "Unknown error";
      const isNotFound = detail.includes("not found") || detail.includes("Account does not exist");
      if (isNotFound) {
        return c.json({ error: "Market not found" }, 404);
      }
      logger.error("Market fetch error", {
        detail: truncateErrorMessage(detail, 120),
        path: c.req.path,
      });
      return c.json({ error: "Failed to fetch market data" }, 500);
    }
  });

  return app;
}
