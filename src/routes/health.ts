import { Hono } from "hono";
import { getConnection, getSupabase, createLogger, truncateErrorMessage } from "@percolator/shared";
import { withRpcTimeout, HEALTH_RPC_TIMEOUT_MS } from "../utils/rpc-timeout.js";
import { getWebSocketMetrics } from "./ws.js";
import { requireApiKey } from "../middleware/auth.js";

const logger = createLogger("api:health");
const startTime = Date.now();

const HEALTH_CACHE_TTL_MS = 5_000;
let cachedHealth: { body: unknown; statusCode: number; checkedAt: number } | null = null;

/** @internal Reset cache — used by tests to ensure isolation */
export function __resetHealthCache(): void {
  cachedHealth = null;
}

export function healthRoutes(): Hono {
  const app = new Hono();
  
  app.get("/health", async (c) => {
    if (cachedHealth && Date.now() - cachedHealth.checkedAt < HEALTH_CACHE_TTL_MS) {
      return c.json(cachedHealth.body, cachedHealth.statusCode as 200 | 503);
    }
    const checks: { db: boolean; rpc: boolean; ws: boolean } = { db: false, rpc: false, ws: false };
    let status: "ok" | "degraded" | "down" = "ok";
    
    // Check RPC connectivity
    try {
      await withRpcTimeout(getConnection().getSlot(), "healthcheck:getSlot", HEALTH_RPC_TIMEOUT_MS);
      checks.rpc = true;
    } catch (err) {
      logger.error("RPC check failed", { error: truncateErrorMessage(err instanceof Error ? err.message : err, 120) });
      checks.rpc = false;
    }
    
    // Check Supabase connectivity
    // PERC-693: Supabase client doesn't throw on query errors — check { error } explicitly
    try {
      const { error: dbError } = await getSupabase().from("markets").select("id", { count: "exact", head: true });
      if (dbError) {
        throw new Error(dbError.message ?? "Supabase query failed");
      }
      checks.db = true;
    } catch (err) {
      logger.error("DB check failed", { error: truncateErrorMessage(err instanceof Error ? err.message : err, 120) });
      checks.db = false;
    }
    
    // Check WebSocket subsystem — saturated WS means new clients can't connect
    try {
      const wsMetrics = getWebSocketMetrics();
      const utilization = wsMetrics.totalConnections / wsMetrics.limits.maxGlobalConnections;
      checks.ws = utilization < 0.95; // degraded if >95% of connection slots used
    } catch {
      checks.ws = false;
    }

    // Determine overall status
    const failedChecks = Object.values(checks).filter(v => !v).length;
    if (failedChecks === 0) {
      status = "ok";
    } else if (failedChecks === Object.keys(checks).length) {
      status = "down";
    } else {
      status = "degraded";
    }
    
    const uptime = Math.floor((Date.now() - startTime) / 1000);
    const statusCode = status === "down" ? 503 : 200;
    
    const body = { status, checks, uptime };
    cachedHealth = { body, statusCode, checkedAt: Date.now() };
    return c.json(body, statusCode as 200 | 503);
  });
  
  app.get("/ws/stats", requireApiKey(), async (c) => {
    try {
      const metrics = getWebSocketMetrics();
      return c.json(metrics);
    } catch (err) {
      logger.error("Failed to get WebSocket metrics", { error: truncateErrorMessage(err instanceof Error ? err.message : err, 120) });
      return c.json({ error: "Failed to retrieve metrics" }, 500);
    }
  });
  
  return app;
}
