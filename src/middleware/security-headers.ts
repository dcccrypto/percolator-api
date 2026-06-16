import { createMiddleware } from "hono/factory";

const DEFAULT_CONTENT_SECURITY_POLICY =
  "default-src 'none'; script-src 'self' unpkg.com; style-src 'self' unpkg.com 'unsafe-inline'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'";

const PERMISSIONS_POLICY =
  "camera=(), microphone=(), geolocation=(), payment=(), usb=(), magnetometer=(), gyroscope=(), accelerometer=()";

/**
 * Applies global security headers without overwriting route-specific headers.
 *
 * Some routes, such as /docs, need a more specific Content-Security-Policy
 * to allow hashed inline initialization scripts without using unsafe-inline.
 */
export function securityHeaders() {
  return createMiddleware(async (c, next) => {
    await next();

    c.header("X-Content-Type-Options", "nosniff");
    c.header("X-Frame-Options", "DENY");
    c.header("X-XSS-Protection", "0");
    c.header("Referrer-Policy", "strict-origin-when-cross-origin");
    c.header("X-DNS-Prefetch-Control", "off");
    c.header("X-Download-Options", "noopen");
    c.header("Permissions-Policy", PERMISSIONS_POLICY);

    if (!c.res.headers.has("Content-Security-Policy")) {
      c.header("Content-Security-Policy", DEFAULT_CONTENT_SECURITY_POLICY);
    }

    if (process.env.NODE_ENV === "production") {
      c.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    } else {
      const proto = c.req.header("x-forwarded-proto") || "http";
      if (proto === "https") {
        c.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
      }
    }

    if (!c.res.headers.has("Cache-Control")) {
      c.header("Cache-Control", "no-store");
    }
  });
}
