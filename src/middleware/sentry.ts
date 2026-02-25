import * as Sentry from "@sentry/node";
import type { MiddlewareHandler } from "hono";

/**
 * Initialize Sentry for the API server.
 * Call once at startup, before any routes are registered.
 */
export function initSentry(): void {
  const dsn = process.env.SENTRY_DSN;
  
  if (!dsn) {
    console.info("[sentry] SENTRY_DSN not set — error tracking disabled");
    return;
  }

  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV || "development",
    release: process.env.API_VERSION || "api@0.1.0",
    
    // Performance monitoring
    tracesSampleRate: 0.1, // 10% of transactions
    
    // Don't send PII
    sendDefaultPii: false,
    
    // Filter out health check noise
    beforeSend(event) {
      // Don't report 404s or expected client errors
      if (event.tags?.["http.status_code"] === "404") return null;
      return event;
    },
    
    integrations: [
      // Auto-instrument HTTP requests
      Sentry.httpIntegration(),
    ],
  });

  console.info("[sentry] Initialized for API server");
}

/**
 * Hono middleware that wraps each request in a Sentry transaction
 * and reports unhandled errors.
 */
export function sentryMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    const dsn = process.env.SENTRY_DSN;
    if (!dsn) return next();

    return Sentry.withScope(async (scope) => {
      // Set request context
      scope.setTag("http.method", c.req.method);
      scope.setTag("http.path", c.req.path);
      
      // Set API key user if present (pseudonymous)
      const apiKey = c.req.header("x-api-key");
      if (apiKey) {
        scope.setUser({ id: `api-key:${apiKey.slice(0, 8)}...` });
      }

      try {
        await next();

        // Tag response status
        const status = c.res.status;
        scope.setTag("http.status_code", String(status));

        // Report 5xx errors
        if (status >= 500) {
          Sentry.captureMessage(`API ${status} on ${c.req.method} ${c.req.path}`, "error");
        }
      } catch (err) {
        // Capture unhandled route errors
        Sentry.captureException(err, {
          tags: {
            endpoint: c.req.path,
            method: c.req.method,
          },
        });
        throw err; // Re-throw so Hono's onError handler still fires
      }
    });
  };
}

/**
 * Flush Sentry events before shutdown.
 * Call during graceful shutdown to ensure events are sent.
 */
export async function flushSentry(timeoutMs = 2000): Promise<void> {
  await Sentry.flush(timeoutMs);
}
