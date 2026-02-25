import { PublicKey } from "@solana/web3.js";
import type { Context, Next } from "hono";
import { sanitizeSlabAddress } from "@percolator/shared";

/**
 * Hono middleware that validates the `:slab` route param is a valid Solana public key.
 * Returns 400 if invalid.
 */
export async function validateSlab(c: Context, next: Next) {
  const slab = c.req.param("slab");
  if (!slab) return next();

  // First sanitize the input
  const sanitized = sanitizeSlabAddress(slab);
  if (!sanitized) {
    return c.json({ error: "Invalid slab address" }, 400);
  }

  // Then validate it's a valid Solana public key
  try {
    new PublicKey(sanitized);
  } catch {
    return c.json({ error: "Invalid slab address" }, 400);
  }

  return next();
}
