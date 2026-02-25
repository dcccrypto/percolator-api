import type { Context, Next } from "hono";
import { timingSafeEqual, createHash } from "node:crypto";

/**
 * C2: API key auth middleware for mutation endpoints.
 * Checks `x-api-key` header against `API_AUTH_KEY` env var.
 * If `API_AUTH_KEY` is not set, allows all requests (dev mode).
 * Uses timing-safe comparison to prevent timing attacks.
 */
export function requireApiKey() {
  return async (c: Context, next: Next) => {
    const apiAuthKey = process.env.API_AUTH_KEY;
    if (!apiAuthKey) {
      // R2-S9: In production, reject all requests if auth key is not configured
      if (process.env.NODE_ENV === "production") {
        return c.json({ error: "Server misconfigured — auth key not set" }, 500);
      }
      return next();
    }
    
    const provided = c.req.header("x-api-key");
    if (!provided) {
      return c.json({ error: "Unauthorized: invalid or missing x-api-key" }, 401);
    }
    
    // Use timing-safe comparison to prevent timing attacks
    // Hash both values to ensure equal length for timingSafeEqual
    const providedHash = createHash("sha256").update(provided).digest();
    const expectedHash = createHash("sha256").update(apiAuthKey).digest();
    
    let isValid = false;
    try {
      isValid = timingSafeEqual(providedHash, expectedHash);
    } catch {
      // timingSafeEqual throws if buffers are different lengths (shouldn't happen with hashes)
      isValid = false;
    }
    
    if (!isValid) {
      return c.json({ error: "Unauthorized: invalid or missing x-api-key" }, 401);
    }
    
    return next();
  };
}
