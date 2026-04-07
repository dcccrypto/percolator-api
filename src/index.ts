import "dotenv/config";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { compress } from "hono/compress";
import { bodyLimit } from "hono/body-limit";
import { serve } from "@hono/node-server";
import { createLogger, sendInfoAlert, getSupabase, sendCriticalAlert, truncateErrorMessage } from "@percolator/shared";
import { initSentry, sentryMiddleware, flushSentry } from "./middleware/sentry.js";
import * as Sentry from "@sentry/node";

// Initialize Sentry before anything else
initSentry();
import { healthRoutes } from "./routes/health.js";
import { marketRoutes } from "./routes/markets.js";
import { tradeRoutes } from "./routes/trades.js";
import { priceRoutes } from "./routes/prices.js";
import { fundingRoutes } from "./routes/funding.js";
import { crankStatusRoutes } from "./routes/crank.js";
import { oracleRouterRoutes } from "./routes/oracle-router.js";
import { insuranceRoutes } from "./routes/insurance.js";
import { openInterestRoutes } from "./routes/open-interest.js";
import { statsRoutes } from "./routes/stats.js";
import { chartRoutes } from "./routes/chart.js";
import { docsRoutes } from "./routes/docs.js";
import { adlRoutes } from "./routes/adl.js";
import { setupWebSocket } from "./routes/ws.js";
import { readRateLimit, writeRateLimit } from "./middleware/rate-limit.js";
import { ipBlocklist } from "./middleware/ip-blocklist.js";
import { cacheMiddleware } from "./middleware/cache.js";

const logger = createLogger("api");

const app = new Hono();

// CORS Configuration
const allowedOrigins = process.env.CORS_ORIGINS 
  ? process.env.CORS_ORIGINS.split(",").map(s => s.trim()).filter(Boolean)
  : ["http://localhost:3000", "http://localhost:3001"];

// In production, CORS_ORIGINS must be explicitly set
if (process.env.NODE_ENV === "production" && !process.env.CORS_ORIGINS) {
  logger.error("CORS_ORIGINS environment variable is required in production");
  process.exit(1);
}

logger.info("CORS allowed origins", { origins: allowedOrigins });

app.use("*", cors({
  origin: (origin) => {
    // Allow requests with no origin (like mobile apps or curl)
    if (!origin) return null;
    
    // Check if origin is in allowed list
    if (allowedOrigins.includes(origin)) {
      return origin;
    }

    // Support wildcard patterns (e.g. https://*.vercel.app)
    for (const allowed of allowedOrigins) {
      if (allowed.startsWith("https://*.")) {
        const wildcardDomain = allowed.slice("https://*.".length); // e.g. "vercel.app"
        try {
          const originUrl = new URL(origin);
          if (
            originUrl.protocol === "https:" &&
            originUrl.hostname.endsWith("." + wildcardDomain) &&
            originUrl.hostname.length > wildcardDomain.length + 1
          ) {
            return origin;
          }
        } catch {
          // Malformed origin — reject
        }
      }
    }
    
    // Reject disallowed origins
    logger.warn("CORS rejected origin", { origin });
    return null;
  },
  // Only allow GET + OPTIONS until write endpoints are implemented.
  // When mutation routes are added, expand this AND apply requireApiKey()
  // middleware to those routes. See middleware/auth.ts.
  allowMethods: ["GET", "OPTIONS"],
  allowHeaders: ["Content-Type", "x-api-key"],
}));

// Request body size limit — prevents large payload attacks.
// Applied globally so future write endpoints inherit a safe default.
app.use("*", bodyLimit({
  maxSize: 100 * 1024, // 100KB
  onError: (c) => c.json({ error: "Request body too large" }, 413),
}));

// Default-deny for mutation methods. Until write endpoints are added,
// reject any POST/PUT/DELETE/PATCH requests that reach the API.
// When write routes are needed, apply requireApiKey() from middleware/auth.ts
// to those specific routes and remove this global guard.
app.use("*", async (c, next) => {
  const method = c.req.method;
  if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
    logger.warn("Blocked mutation request (no write endpoints)", {
      method,
      path: c.req.path,
    });
    return c.json({ error: "Method not allowed" }, 405);
  }
  return next();
});

// IP Blocklist Middleware — runs after CORS, before rate-limiting and auth.
// Configure via IP_BLOCKLIST env var (comma-separated IPs or CIDRs).
// Example: IP_BLOCKLIST=88.97.223.158,10.0.0.0/8
app.use("*", ipBlocklist());

// Compression Middleware (gzip/brotli for JSON responses)
app.use("*", compress());

// Sentry error tracking middleware
app.use("*", sentryMiddleware());

// Security Headers Middleware
app.use("*", async (c, next) => {
  await next();
  
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
  c.header("X-XSS-Protection", "0");
  c.header("Referrer-Policy", "strict-origin-when-cross-origin");
  c.header("X-DNS-Prefetch-Control", "off");
  c.header("X-Download-Options", "noopen");
  c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=(), magnetometer=(), gyroscope=(), accelerometer=()");
  
  c.header("Content-Security-Policy", "default-src 'none'; script-src 'self' unpkg.com; style-src 'self' unpkg.com 'unsafe-inline'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'");
  
  // Always send HSTS in production (proxy terminates TLS so x-forwarded-proto may be stripped by a MitM)
  if (process.env.NODE_ENV === "production") {
    c.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  } else {
    const proto = c.req.header("x-forwarded-proto") || "http";
    if (proto === "https") {
      c.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }
  }

  // Prevent CDNs/proxies from caching responses by default.
  // Financial data endpoints (prices, funding, trades, stats) must not be
  // served stale by intermediate proxies.  Endpoints that intentionally
  // cache (e.g. /chart, cacheMiddleware routes) set their own
  // Cache-Control header which will already be present on the response.
  if (!c.res.headers.has("Cache-Control")) {
    c.header("Cache-Control", "no-store");
  }
});

// Rate Limiting Middleware
app.use("*", async (c, next) => {
  if (c.req.method === "GET" || c.req.method === "HEAD" || c.req.method === "OPTIONS") {
    return readRateLimit()(c, next);
  }
  return writeRateLimit()(c, next);
});

// Response Caching Middleware (applied per-route)
// Cache read-heavy endpoints with varying TTLs:
// - /markets — 30s TTL
app.use("/markets", cacheMiddleware(30));
// - /stats — 60s TTL
app.use("/stats", cacheMiddleware(60));
// - /funding/global — 60s TTL
app.use("/funding/global", cacheMiddleware(60));

// Dynamic route caching (with path parameters) applied in route handlers
// - /markets/:slab — 10s TTL (handled in route)
// - /open-interest/:slab — 15s TTL (handled in route)
// - /funding/:slab — 30s TTL (handled in route)

app.route("/", healthRoutes());
app.route("/", marketRoutes());
app.route("/", tradeRoutes());
app.route("/", priceRoutes());
app.route("/", fundingRoutes());
app.route("/", crankStatusRoutes());
app.route("/", oracleRouterRoutes());
app.route("/", insuranceRoutes());
app.route("/", openInterestRoutes());
app.route("/", statsRoutes());
app.route("/", chartRoutes());
app.route("/", adlRoutes());
app.route("/", docsRoutes());

app.get("/", (c) => c.json({ 
  name: "@percolator/api", 
  version: "0.1.0",
  docs: "/docs"
}));

// Global error handler
app.onError((err, c) => {
  logger.error("Unhandled error", {
    error: truncateErrorMessage(err.message, 120),
    stack: truncateErrorMessage(err.stack ?? "", 500),
    endpoint: c.req.path,
    method: c.req.method
  });
  
  // Report to Sentry (sentryMiddleware may have already captured it,
  // but this ensures errors from middleware chain are also caught)
  try {
    Sentry.captureException(err, {
      tags: {
        endpoint: c.req.path,
        method: c.req.method,
        handler: "onError",
      },
    });
  } catch (_sentryErr) {}
  
  // Truncate error message for API response (details only in development)
  const showDetails = process.env.NODE_ENV !== "production";
  return c.json({
    error: "Internal server error",
    ...(showDetails && { details: truncateErrorMessage(err.message, 200) })
  }, 500);
});

// Validate NODE_ENV at startup — require it to be set to prevent accidental
// information disclosure when deploying without an explicit NODE_ENV
const validNodeEnvs = ["production", "development", "test"];
if (!process.env.NODE_ENV || !validNodeEnvs.includes(process.env.NODE_ENV)) {
  logger.error("NODE_ENV must be explicitly set to one of: production, development, test", {
    nodeEnv: process.env.NODE_ENV ?? "(unset)",
    validOptions: validNodeEnvs.join(", ")
  });
  throw new Error(`NODE_ENV must be explicitly set. Got: ${process.env.NODE_ENV ?? "(unset)"}. Must be one of: ${validNodeEnvs.join(", ")}`);
}

const port = Number(process.env.API_PORT ?? 3001);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  logger.error("Invalid API_PORT: must be an integer between 1 and 65535", { apiPort: process.env.API_PORT });
  process.exit(1);
}

// Database connectivity pre-flight check with retry
const DB_VERIFY_MAX_RETRIES = 3;
const DB_VERIFY_BASE_DELAY_MS = 2_000;

async function verifyDatabaseConnection(): Promise<void> {
  for (let attempt = 1; attempt <= DB_VERIFY_MAX_RETRIES; attempt++) {
    try {
      logger.info("Verifying database connectivity...", { attempt, maxRetries: DB_VERIFY_MAX_RETRIES });
      
      const { count, error } = await getSupabase()
        .from("markets")
        .select("id", { count: "exact", head: true });
      
      if (error) {
        throw error;
      }
      
      logger.info("✓ Database connection verified", { marketCount: count });
      return;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);

      if (attempt < DB_VERIFY_MAX_RETRIES) {
        const delay = DB_VERIFY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
        logger.warn(`Database connection attempt ${attempt}/${DB_VERIFY_MAX_RETRIES} failed, retrying in ${delay}ms`, {
          error: errorMsg,
        });
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }

      logger.error("✗ Database connection failed after all retries", {
        error: errorMsg,
        attempts: DB_VERIFY_MAX_RETRIES,
        supabaseUrl: process.env.SUPABASE_URL ? "configured" : "not configured",
        supabaseServiceKey: process.env.SUPABASE_SERVICE_KEY ? "configured" : "not configured"
      });
      
      try {
        await sendCriticalAlert("API startup failed: Database connection failed", [
          { name: "Error", value: errorMsg.slice(0, 200), inline: false },
          { name: "Reason", value: `API cannot start — database unreachable after ${DB_VERIFY_MAX_RETRIES} attempts`, inline: false },
        ]);
      } catch (alertErr) {
        logger.error("Failed to send critical alert", { error: alertErr });
      }
      
      process.exit(1);
    }
  }
}

// Verify database before starting server
await verifyDatabaseConnection();

const server = serve({ fetch: app.fetch, port }, async (info) => {
  logger.info("Percolator API started", { port: info.port });
  
  // Send startup alert
  await sendInfoAlert("API service started", [
    { name: "Port", value: info.port.toString(), inline: true },
  ]);
});

const wss = setupWebSocket(server as unknown as import("node:http").Server);

const SHUTDOWN_TIMEOUT_MS = 10_000;

async function shutdown(signal: string): Promise<void> {
  logger.info("Shutdown initiated", { signal });

  // Force-exit if graceful shutdown takes too long
  const forceExit = setTimeout(() => {
    logger.error("Graceful shutdown timed out, forcing exit");
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  forceExit.unref();
  
  try {
    // Flush Sentry events before shutting down
    await flushSentry(2000);
    
    // Send shutdown alert
    await sendInfoAlert("API service shutting down", [
      { name: "Signal", value: signal, inline: true },
    ]);

    // Terminate all active WebSocket connections so they don't hold the server open
    for (const client of wss.clients) {
      client.close(1001, "Server shutting down");
    }
    
    // Close WebSocket server (stops accepting new connections)
    logger.info("Closing WebSocket server");
    await new Promise<void>((resolve, reject) => {
      wss.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    logger.info("WebSocket server closed");
    
    // Close HTTP server (stops accepting new requests)
    logger.info("Closing HTTP server");
    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    logger.info("HTTP server closed");
    
    // Note: Supabase client doesn't need explicit cleanup (connection pooling handled automatically)
    
    logger.info("Shutdown complete");
    process.exit(0);
  } catch (err) {
    logger.error("Error during shutdown", { error: err });
    process.exit(1);
  }
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

export { app };
