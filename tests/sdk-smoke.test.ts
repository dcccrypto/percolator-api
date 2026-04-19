/**
 * SDK publish smoke test — runs against the *installed* @percolatorct/sdk package.
 *
 * Purpose: catch publish-time regressions (missing exports, bad tarball, files: glob
 * mistakes, dist/ not regenerated) that are invisible when pnpm uses a workspace link.
 *
 * This test does NOT make RPC calls. Everything is pure in-process computation so it
 * runs reliably in CI without any environment secrets.
 *
 * Pinned version: @percolatorct/sdk@1.0.0-beta.33
 * Update this comment when the workflow pins a new version.
 */

import { describe, it, expect } from "vitest";

// ── 1. Named-export existence ─────────────────────────────────────────────────
// Every symbol the API actually imports must resolve without throwing.
import {
  // solana/slab.ts  (used by markets.ts, adl.ts)
  fetchSlab,
  parseHeader,
  parseConfig,
  parseEngine,
  parseAllAccounts,
  detectSlabLayout,
  SLAB_MAGIC,
  ENGINE_OFF,
  ENGINE_MARK_PRICE_OFF,
  SLAB_TIERS_V12_17,
  // solana/adl.ts  (used by adl.ts route)
  rankAdlPositions,
  isAdlTriggered,
  buildAdlInstruction,
  parseAdlEvent,
  // solana/pda.ts
  deriveVaultAuthority,
  deriveInsuranceLpMint,
  deriveLpPda,
  derivePythPushOraclePDA,
  // config/program-ids.ts
  getProgramId,
  getMatcherProgramId,
  getCurrentNetwork,
  PROGRAM_IDS,
  // oracle/price-router.ts  (used by oracle-router.ts route)
  resolvePrice,
} from "@percolatorct/sdk";

// Type-only imports — these exercise the .d.ts surface without runtime cost.
import type {
  SlabHeader,
  MarketConfig,
  EngineState,
  SlabLayout,
  AdlRankingResult,
  AdlRankedPosition,
  PriceRouterResult,
} from "@percolatorct/sdk";

// ── 2. Constants ──────────────────────────────────────────────────────────────

describe("@percolatorct/sdk exports — constants", () => {
  it("SLAB_MAGIC is the PERCOLAT ASCII magic bigint", () => {
    // 0x504552434f4c4154n == "PERCOLAT" in little-endian u64
    expect(typeof SLAB_MAGIC).toBe("bigint");
    expect(SLAB_MAGIC).toBe(0x504552434f4c4154n);
  });

  it("ENGINE_OFF is 600 (post-PERC-1094 BPF layout)", () => {
    expect(ENGINE_OFF).toBe(600);
  });

  it("ENGINE_MARK_PRICE_OFF is 400", () => {
    expect(ENGINE_MARK_PRICE_OFF).toBe(400);
  });

  it("SLAB_TIERS_V12_17 is a non-empty object", () => {
    expect(typeof SLAB_TIERS_V12_17).toBe("object");
    expect(SLAB_TIERS_V12_17).not.toBeNull();
    expect(Object.keys(SLAB_TIERS_V12_17).length).toBeGreaterThan(0);
  });
});

// ── 3. parseHeader round-trip ─────────────────────────────────────────────────

/**
 * Build a minimal synthetic slab byte array.
 *
 * Header layout (V0, 72 bytes):
 *   [0..8]   magic   u64 LE  = 0x504552434f4c4154n
 *   [8..12]  version u32 LE  = 12 (v12.x)
 *   [12]     bump    u8      = 255
 *   [13]     flags   u8      = 0
 *   [14..16] padding
 *   [16..48] admin   [u8;32] = 11111...1 (system program)
 *   [48..56] nonce   u64 LE  = 42
 *   [56..64] lastThrUpdateSlot u64 LE = 999
 *   [64..72] reserved
 */
function buildMinimalSlabHeader(): Uint8Array {
  const buf = new Uint8Array(72);
  const dv = new DataView(buf.buffer);

  // magic: "PERCOLAT" little-endian u64
  // Low 32 bits: 0x4f4c4154 ("OLAT"), high 32 bits: 0x50455243 ("PERC")
  dv.setUint32(0, 0x4f4c4154, true);
  dv.setUint32(4, 0x50455243, true);

  // version = 12
  dv.setUint32(8, 12, true);
  // bump = 255
  buf[12] = 255;
  // flags = 0
  buf[13] = 0;
  // admin = all-ones (system program pubkey bytes start with 0x00, use 11..1 base58)
  // We use zeros here — parseHeader constructs a PublicKey, any 32-byte value is valid
  buf.fill(0, 16, 48);
  // nonce at offset 48 = 42n
  dv.setBigUint64(48, 42n, true);
  // lastThrUpdateSlot at offset 56 = 999n
  dv.setBigUint64(56, 999n, true);

  return buf;
}

describe("@percolatorct/sdk exports — parseHeader", () => {
  it("parseHeader is a function", () => {
    expect(typeof parseHeader).toBe("function");
  });

  it("parseHeader parses a synthetic header correctly", () => {
    const data = buildMinimalSlabHeader();
    const hdr: SlabHeader = parseHeader(data);

    expect(hdr.magic).toBe(SLAB_MAGIC);
    expect(hdr.version).toBe(12);
    expect(hdr.bump).toBe(255);
    expect(hdr.resolved).toBe(false);
    expect(hdr.paused).toBe(false);
    // admin is a PublicKey (32 zero bytes = system program)
    expect(typeof hdr.admin.toBase58).toBe("function");
  });

  it("parseHeader throws on data that is too short", () => {
    expect(() => parseHeader(new Uint8Array(8))).toThrow();
  });

  it("parseHeader throws on bad magic", () => {
    const data = buildMinimalSlabHeader();
    // corrupt magic byte 0
    data[0] = 0xff;
    expect(() => parseHeader(data)).toThrow(/magic/i);
  });
});

// ── 4. detectSlabLayout ───────────────────────────────────────────────────────

describe("@percolatorct/sdk exports — detectSlabLayout", () => {
  it("detectSlabLayout is a function", () => {
    expect(typeof detectSlabLayout).toBe("function");
  });

  it("returns null for unknown size (e.g. 1 byte)", () => {
    const result = detectSlabLayout(1);
    expect(result).toBeNull();
  });
});

// ── 5. ADL exports ────────────────────────────────────────────────────────────

describe("@percolatorct/sdk exports — ADL", () => {
  it("rankAdlPositions is a function", () => {
    expect(typeof rankAdlPositions).toBe("function");
  });

  it("isAdlTriggered is a function", () => {
    expect(typeof isAdlTriggered).toBe("function");
  });

  it("buildAdlInstruction is a function", () => {
    expect(typeof buildAdlInstruction).toBe("function");
  });

  it("parseAdlEvent returns null for empty log array", () => {
    const result = parseAdlEvent([]);
    expect(result).toBeNull();
  });

  it("parseAdlEvent returns null for non-matching logs", () => {
    const result = parseAdlEvent(["Program log: some unrelated log"]);
    expect(result).toBeNull();
  });
});

// ── 6. PDA derivation ────────────────────────────────────────────────────────

import { PublicKey } from "@solana/web3.js";

describe("@percolatorct/sdk exports — PDA derivation", () => {
  const DUMMY_PROGRAM = new PublicKey("11111111111111111111111111111111");
  const DUMMY_SLAB = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

  it("deriveVaultAuthority returns [PublicKey, number]", () => {
    const [pda, bump] = deriveVaultAuthority(DUMMY_PROGRAM, DUMMY_SLAB);
    expect(pda).toBeInstanceOf(PublicKey);
    expect(typeof bump).toBe("number");
    expect(bump).toBeGreaterThanOrEqual(0);
    expect(bump).toBeLessThanOrEqual(255);
  });

  it("deriveInsuranceLpMint returns [PublicKey, number]", () => {
    const [pda, bump] = deriveInsuranceLpMint(DUMMY_PROGRAM, DUMMY_SLAB);
    expect(pda).toBeInstanceOf(PublicKey);
    expect(typeof bump).toBe("number");
  });

  it("deriveLpPda returns [PublicKey, number]", () => {
    const [pda, bump] = deriveLpPda(DUMMY_PROGRAM, DUMMY_SLAB, 0);
    expect(pda).toBeInstanceOf(PublicKey);
    expect(typeof bump).toBe("number");
  });

  it("deriveLpPda is deterministic", () => {
    const [a] = deriveLpPda(DUMMY_PROGRAM, DUMMY_SLAB, 0);
    const [b] = deriveLpPda(DUMMY_PROGRAM, DUMMY_SLAB, 0);
    expect(a.toBase58()).toBe(b.toBase58());
  });

  it("deriveLpPda differs across indices", () => {
    const [a] = deriveLpPda(DUMMY_PROGRAM, DUMMY_SLAB, 0);
    const [b] = deriveLpPda(DUMMY_PROGRAM, DUMMY_SLAB, 1);
    expect(a.toBase58()).not.toBe(b.toBase58());
  });

  it("derivePythPushOraclePDA accepts a 64-char hex feed id", () => {
    // SOL/USD feed id (Pyth)
    const feedId = "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";
    const [pda, bump] = derivePythPushOraclePDA(feedId);
    expect(pda).toBeInstanceOf(PublicKey);
    expect(typeof bump).toBe("number");
  });
});

// ── 7. Program IDs ────────────────────────────────────────────────────────────

describe("@percolatorct/sdk exports — program IDs", () => {
  it("getProgramId returns a valid PublicKey for devnet", () => {
    const id = getProgramId("devnet");
    expect(id).toBeInstanceOf(PublicKey);
    expect(id.toBase58().length).toBeGreaterThan(0);
  });

  it("getMatcherProgramId returns a valid PublicKey for devnet", () => {
    const id = getMatcherProgramId("devnet");
    expect(id).toBeInstanceOf(PublicKey);
  });

  it("PROGRAM_IDS has devnet and mainnet keys", () => {
    expect(PROGRAM_IDS).toHaveProperty("devnet");
    expect(PROGRAM_IDS).toHaveProperty("mainnet");
  });

  it("getCurrentNetwork returns devnet or mainnet", () => {
    const net = getCurrentNetwork();
    expect(["devnet", "mainnet"]).toContain(net);
  });
});

// ── 8. fetchSlab / parseEngine / parseConfig / resolvePrice are functions ─────

describe("@percolatorct/sdk exports — function shapes", () => {
  it("fetchSlab is a function", () => {
    expect(typeof fetchSlab).toBe("function");
  });

  it("parseConfig is a function", () => {
    expect(typeof parseConfig).toBe("function");
  });

  it("parseEngine is a function", () => {
    expect(typeof parseEngine).toBe("function");
  });

  it("parseAllAccounts is a function", () => {
    expect(typeof parseAllAccounts).toBe("function");
  });

  it("resolvePrice is a function", () => {
    expect(typeof resolvePrice).toBe("function");
  });
});
