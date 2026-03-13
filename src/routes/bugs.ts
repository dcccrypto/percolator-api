/**
 * Bug Reports API Routes (issue #13)
 *
 * Ported from percolator-launch /api/bugs to Hono for proper ownership.
 *
 * GET  /bugs    — list recent bug reports (requires x-api-key)
 * POST /bugs    — submit a bug report (per-IP rate limit: 3 per hour)
 *
 * Auth: GET requires `x-api-key` (same key used by the Discord bot poller).
 *       POST is public (rate-limited by IP).
 */
import { Hono } from "hono";
import { getSupabase, createLogger } from "@percolator/shared";
import { requireApiKey } from "../middleware/auth.js";

const logger = createLogger("api:bugs");

const TABLE = "bug_reports";

// ── Per-IP hourly rate limit for POST /bugs ────────────────────────────────
interface HourlyBucket {
  count: number;
  resetAt: number;
}

const HOURLY_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const POST_HOURLY_LIMIT = 3;
const hourlyBuckets = new Map<string, HourlyBucket>();

// Prune expired hourly buckets every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of hourlyBuckets) {
    if (v.resetAt <= now) hourlyBuckets.delete(k);
  }
}, 10 * 60_000);

function checkHourlyLimit(ip: string): {
  allowed: boolean;
  remaining: number;
  reset: number;
} {
  const now = Date.now();
  let bucket = hourlyBuckets.get(ip);
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + HOURLY_WINDOW_MS };
    hourlyBuckets.set(ip, bucket);
  }
  bucket.count++;
  return {
    allowed: bucket.count <= POST_HOURLY_LIMIT,
    remaining: Math.max(0, POST_HOURLY_LIMIT - bucket.count),
    reset: Math.floor(bucket.resetAt / 1000),
  };
}

// ── Input sanitisation ─────────────────────────────────────────────────────
function sanitize(str: string): string {
  return str.replace(/[<>]/g, "").trim();
}

// ── Routes ─────────────────────────────────────────────────────────────────
export function bugsRoutes(): Hono {
  const app = new Hono();

  /**
   * GET /bugs
   *
   * Returns the 50 most recent bug reports ordered by created_at desc.
   * Protected by x-api-key (Discord bot / internal tooling only).
   */
  app.get("/bugs", requireApiKey(), async (c) => {
    try {
      const sb = getSupabase();
      const { data, error } = await sb
        .from(TABLE)
        .select(
          "id, twitter_handle, title, description, severity, page, bounty_wallet, transaction_wallet, page_url, status, created_at"
        )
        .order("created_at", { ascending: false })
        .limit(50);

      if (error) {
        // 42P01 = table does not exist — return empty rather than 500
        if (error.code === "42P01") {
          logger.warn("bug_reports table not found — returning empty list");
          return c.json([]);
        }
        throw error;
      }

      return c.json(data ?? []);
    } catch (err) {
      logger.error("GET /bugs error", { err });
      return c.json([], 200);
    }
  });

  /**
   * POST /bugs
   *
   * Submits a bug report. Rate-limited to 3 per IP per hour.
   * Validates required fields and sanitises all string inputs before insert.
   *
   * Body (JSON):
   *   twitter_handle   string  required, max 30
   *   title            string  required, max 120
   *   description      string  required, max 2000
   *   severity         "low"|"medium"|"high"|"critical"  default: "medium"
   *   page             string  optional
   *   steps_to_reproduce   string  optional
   *   expected_behavior    string  optional
   *   actual_behavior      string  optional
   *   bounty_wallet    string  optional
   *   transaction_wallet  string  optional
   *   page_url         string  optional
   *   browser          string  optional
   */
  app.post("/bugs", async (c) => {
    // Resolve client IP (respect TRUSTED_PROXY_DEPTH, same logic as rate-limit.ts)
    const proxyDepth = Math.max(0, Number(process.env.TRUSTED_PROXY_DEPTH ?? 1));
    let ip = "unknown";
    if (proxyDepth === 0) {
      ip = c.req.header("x-real-ip") ?? "unknown";
    } else {
      const fwd = c.req.header("x-forwarded-for");
      if (fwd) {
        const ips = fwd.split(",").map((s) => s.trim()).filter(Boolean);
        ip = ips[Math.max(0, ips.length - proxyDepth)] ?? "unknown";
      } else {
        ip = c.req.header("x-real-ip") ?? "unknown";
      }
    }

    const rl = checkHourlyLimit(ip);
    c.header("X-RateLimit-Limit", POST_HOURLY_LIMIT.toString());
    c.header("X-RateLimit-Remaining", rl.remaining.toString());
    c.header("X-RateLimit-Reset", rl.reset.toString());

    if (!rl.allowed) {
      logger.warn("POST /bugs rate limit exceeded", { ip });
      return c.json({ error: "Rate limited — max 3 bug reports per hour" }, 429);
    }

    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const twitter_handle = sanitize(String(body.twitter_handle ?? ""));
    const title = sanitize(String(body.title ?? ""));
    const description = sanitize(String(body.description ?? ""));
    const severity = sanitize(String(body.severity ?? "medium"));
    const page = sanitize(String(body.page ?? ""));
    const steps_to_reproduce = sanitize(String(body.steps_to_reproduce ?? ""));
    const expected_behavior = sanitize(String(body.expected_behavior ?? ""));
    const actual_behavior = sanitize(String(body.actual_behavior ?? ""));
    const bounty_wallet = body.bounty_wallet
      ? sanitize(String(body.bounty_wallet))
      : null;
    const transaction_wallet = body.transaction_wallet
      ? sanitize(String(body.transaction_wallet))
      : null;
    const page_url = body.page_url ? sanitize(String(body.page_url)) : null;
    const browser = body.browser ? sanitize(String(body.browser)) : null;

    // Validation
    if (!twitter_handle || twitter_handle.length > 30) {
      return c.json({ error: "Twitter handle required (max 30 chars)" }, 400);
    }
    if (!title || title.length > 120) {
      return c.json({ error: "Title required (max 120 chars)" }, 400);
    }
    if (!description || description.length > 2000) {
      return c.json({ error: "Description required (max 2000 chars)" }, 400);
    }
    if (!["low", "medium", "high", "critical"].includes(severity)) {
      return c.json({ error: "Invalid severity" }, 400);
    }

    try {
      const sb = getSupabase();
      const { error } = await sb.from(TABLE).insert({
        twitter_handle,
        title,
        description,
        severity,
        page: page || null,
        steps_to_reproduce: steps_to_reproduce || null,
        expected_behavior: expected_behavior || null,
        actual_behavior: actual_behavior || null,
        bounty_wallet,
        transaction_wallet,
        page_url: page_url || null,
        browser,
        ip,
      });

      if (error) throw error;

      // Discord notification handled by bot poller (polls GET /bugs every 30s)
      return c.json({ ok: true }, 201);
    } catch (err) {
      logger.error("POST /bugs insert error", { err });
      return c.json({ error: "Failed to submit bug report" }, 500);
    }
  });

  return app;
}
