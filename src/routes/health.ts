import { Hono } from "hono";
import { getConnection, getSupabase, createLogger } from "@percolator/shared";
import { getWebSocketMetrics } from "./ws.js";

const logger = createLogger("api:health");
const startTime = Date.now();

export function healthRoutes(): Hono {
  const app = new Hono();

  /**
   * GET /health — Liveness probe.
   *
   * Railway and most container platforms use this for liveness checks.
   * This endpoint ALWAYS returns HTTP 200 as long as the process is alive.
   * External dependency failures (DB, RPC) are reflected in the body but do
   * NOT change the HTTP status — they must not cause Railway to restart a
   * healthy process in a restart loop.
   *
   * Use GET /ready for readiness (will return 503 when deps are down).
   */
  app.get("/health", async (c) => {
    const checks: { db: boolean; rpc: boolean } = { db: false, rpc: false };
    let status: "ok" | "degraded" | "down" = "ok";

    // Check RPC connectivity
    try {
      await getConnection().getSlot();
      checks.rpc = true;
    } catch (err) {
      logger.warn("RPC check failed", { error: err instanceof Error ? err.message : err });
      checks.rpc = false;
    }

    // Check Supabase connectivity
    try {
      await getSupabase().from("markets").select("id", { count: "exact", head: true });
      checks.db = true;
    } catch (err) {
      logger.warn("DB check failed", { error: err instanceof Error ? err.message : err });
      checks.db = false;
    }

    // Determine overall status for body (does not affect HTTP status code)
    const failedChecks = Object.values(checks).filter((v) => !v).length;
    if (failedChecks === 0) {
      status = "ok";
    } else if (failedChecks === Object.keys(checks).length) {
      status = "down";
    } else {
      status = "degraded";
    }

    const uptime = Math.floor((Date.now() - startTime) / 1000);

    // Always 200 — liveness probe must not trigger Railway restarts on dep failures.
    // The caller (percolator-launch /api/health proxy) reads the body to surface
    // detailed status to the admin dashboard.
    return c.json({ status, checks, uptime }, 200);
  });

  /**
   * GET /ready — Readiness probe.
   *
   * Returns 503 when either DB or RPC is unreachable.
   * Use this in load-balancer readiness checks (not Railway liveness).
   */
  app.get("/ready", async (c) => {
    const checks: { db: boolean; rpc: boolean } = { db: false, rpc: false };

    await Promise.allSettled([
      // getSlot() returns PromiseLike<void>, not a full Promise — wrap so .catch() is available
      Promise.resolve(getConnection().getSlot())
        .then(() => {
          checks.rpc = true;
        })
        .catch(() => {
          checks.rpc = false;
        }),
      // Supabase query chain also returns PromiseLike — same fix
      Promise.resolve(
        getSupabase()
          .from("markets")
          .select("id", { count: "exact", head: true }),
      )
        .then(() => {
          checks.db = true;
        })
        .catch(() => {
          checks.db = false;
        }),
    ]);

    const allOk = Object.values(checks).every(Boolean);
    return c.json(
      { ready: allOk, checks },
      allOk ? 200 : 503
    );
  });

  app.get("/ws/stats", async (c) => {
    try {
      const metrics = getWebSocketMetrics();
      return c.json(metrics);
    } catch (err) {
      logger.error("Failed to get WebSocket metrics", {
        error: err instanceof Error ? err.message : err,
      });
      return c.json({ error: "Failed to retrieve metrics" }, 500);
    }
  });

  return app;
}
