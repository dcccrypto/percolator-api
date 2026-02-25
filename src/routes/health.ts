import { Hono } from "hono";
import { getConnection, getSupabase, createLogger } from "@percolator/shared";
import { getWebSocketMetrics } from "./ws.js";

const logger = createLogger("api:health");
const startTime = Date.now();

export function healthRoutes(): Hono {
  const app = new Hono();
  
  app.get("/health", async (c) => {
    const checks: { db: boolean; rpc: boolean } = { db: false, rpc: false };
    let status: "ok" | "degraded" | "down" = "ok";
    
    // Check RPC connectivity
    try {
      await getConnection().getSlot();
      checks.rpc = true;
    } catch (err) {
      logger.error("RPC check failed", { error: err instanceof Error ? err.message : err });
      checks.rpc = false;
    }
    
    // Check Supabase connectivity
    try {
      await getSupabase().from("markets").select("id", { count: "exact", head: true });
      checks.db = true;
    } catch (err) {
      logger.error("DB check failed", { error: err instanceof Error ? err.message : err });
      checks.db = false;
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
    
    return c.json({ status, checks, uptime }, statusCode);
  });
  
  app.get("/ws/stats", async (c) => {
    try {
      const metrics = getWebSocketMetrics();
      return c.json(metrics);
    } catch (err) {
      logger.error("Failed to get WebSocket metrics", { error: err instanceof Error ? err.message : err });
      return c.json({ error: "Failed to retrieve metrics" }, 500);
    }
  });
  
  return app;
}
