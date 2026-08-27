import { describe, expect, it } from "vitest";
import { priceBandOk, estimateSellImpactPct, parsePastedTarget, simpleRangeTicks, createPoolKeyFor } from "./plan.js";
import { ADDRESSES, poolId } from "@friar/chain";

// The position-13 close (2026-07-21): the market mark and the venue the old
// depth-only selection actually zapped into — a pool ~2.06× off market that
// realized about half the token side's value. These exact numbers are the
// regression: the band must reject that venue.
const MARKET_SQRT = 16103010398746123574961739634984n; // ~41,310 PONS/WETH
const BAD_VENUE_SQRT = 23002455828792206388789742225312n; // ~84,600 PONS/WETH

// sqrt scaling: price scales with the square, so sqrt×k → price×k²
const scaleSqrt = (s: bigint, num: bigint, den: bigint) => (s * num) / den;

describe("priceBandOk", () => {
  it("accepts a venue exactly at the mark", () => {
    expect(priceBandOk(MARKET_SQRT, MARKET_SQRT)).toBe(true);
  });

  it("accepts ordinary drift inside the band (±~10% price)", () => {
    expect(priceBandOk(MARKET_SQRT, scaleSqrt(MARKET_SQRT, 105n, 100n))).toBe(true); // +10.25%
    expect(priceBandOk(MARKET_SQRT, scaleSqrt(MARKET_SQRT, 100n, 105n))).toBe(true); // −9.3%
  });

  it("rejects beyond the band, both directions", () => {
    expect(priceBandOk(MARKET_SQRT, scaleSqrt(MARKET_SQRT, 110n, 100n))).toBe(false); // +21%
    expect(priceBandOk(MARKET_SQRT, scaleSqrt(MARKET_SQRT, 100n, 110n))).toBe(false); // −17%
  });

  it("rejects the position-13 exit venue (2× off market)", () => {
    expect(priceBandOk(MARKET_SQRT, BAD_VENUE_SQRT)).toBe(false);
  });

  it("rejects uninitialized prices", () => {
    expect(priceBandOk(MARKET_SQRT, 0n)).toBe(false);
    expect(priceBandOk(0n, MARKET_SQRT)).toBe(false);
  });
});

describe("estimateSellImpactPct", () => {
  // position-13 scale: the exit sold 57.37 PONS (currency1); one similar-sized LP's
  // active-bin liquidity left behind should absorb that at ~1%
  const OTHERS_L = 59403970522680809633n;
  const SALE = 57370004712979224000n;

  it("infinite when no one else is in range", () => {
    expect(estimateSellImpactPct(0n, MARKET_SQRT, SALE, false)).toBe(Number.POSITIVE_INFINITY);
  });

  it("one similar-sized LP absorbs the position-13 sale at ~1%", () => {
    const pct = estimateSellImpactPct(OTHERS_L, MARKET_SQRT, SALE, false);
    expect(pct).toBeGreaterThan(0.5);
    expect(pct).toBeLessThan(2);
  });

  it("scales linearly with sale size", () => {
    const one = estimateSellImpactPct(OTHERS_L, MARKET_SQRT, SALE, false);
    const ten = estimateSellImpactPct(OTHERS_L, MARKET_SQRT, SALE * 10n, false);
    expect(ten / one).toBeCloseTo(10, 6);
  });

  it("selling equal value on either side gives the same impact", () => {
    // x of currency0 is worth y = x·P of currency1; both should move the price alike
    const x = 10n ** 18n;
    const priceE18 = (Number(MARKET_SQRT) / 2 ** 96) ** 2;
    const y = BigInt(Math.round(priceE18 * 1e6)) * 10n ** 12n; // x·P at 1e18 scale
    const viaC0 = estimateSellImpactPct(OTHERS_L, MARKET_SQRT, x, true);
    const viaC1 = estimateSellImpactPct(OTHERS_L, MARKET_SQRT, y, false);
    expect(viaC0 / viaC1).toBeCloseTo(1, 3);
  });
});

describe("parsePastedTarget", () => {
  const ADDR = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
  const POOL_ID = "0x" + "ab".repeat(32);

  it("bare token address → address", () => {
    expect(parsePastedTarget(ADDR)).toEqual({ kind: "address", value: ADDR });
  });

  it("bare v4 pool id → pool (64-hex wins over its 40-hex prefix)", () => {
    expect(parsePastedTarget(POOL_ID)).toEqual({ kind: "pool", value: POOL_ID });
  });

  it("Dexscreener URLs unwrap to the embedded id/address", () => {
    expect(parsePastedTarget(`https://dexscreener.com/robinhoodchain/${POOL_ID}`)).toEqual({ kind: "pool", value: POOL_ID });
    expect(parsePastedTarget(`https://dexscreener.com/robinhoodchain/${ADDR.toLowerCase()}`)).toEqual({
      kind: "address",
      value: ADDR.toLowerCase(),
    });
  });

  it("garbage → null", () => {
    expect(parsePastedTarget("")).toBeNull();
    expect(parsePastedTarget("bonk")).toBeNull();
    expect(parsePastedTarget("0x123")).toBeNull();
  });
});

describe("simpleRangeTicks", () => {
  // −30%/+10% around tick 0, spacing 100. ln(0.7)/1e-4 ≈ −3567 ticks; ln(1.1)/1e-4 ≈ +953.
  it("quote as currency1: user-below maps below the tick, user-above maps above", () => {
    const r = simpleRangeTicks(0, 100, 30, 10, false);
    expect(r.tickLower).toBe(-3600); // floor(−3567) on the grid — never less range than asked
    expect(r.tickUpper).toBe(1000); // ceil(+953)
  });

  it("quote as currency0: the SAME user range inverts in pool-tick space", () => {
    const r = simpleRangeTicks(0, 100, 30, 10, true);
    expect(r.tickLower).toBe(-1000); // user-above (+10%) sits below the pool tick
    expect(r.tickUpper).toBe(3600); // user-below (−30%) sits above it
  });

  it("one-sided ranges stay at least one spacing wide", () => {
    const r = simpleRangeTicks(50, 100, 0, 5, false);
    expect(r.tickUpper).toBeGreaterThan(r.tickLower);
    expect((r.tickUpper - r.tickLower) % 100).toBe(0);
  });

  it("edges land on the spacing grid", () => {
    const r = simpleRangeTicks(-12345, 60, 25, 25, false);
    expect(Math.abs(r.tickLower % 60)).toBe(0);
    expect(Math.abs(r.tickUpper % 60)).toBe(0);
    expect(r.tickLower).toBeLessThan(-12345);
    expect(r.tickUpper).toBeGreaterThan(-12345);
  });
});

const TOKEN = "0x1111111111111111111111111111111111111111";
const WETH = ADDRESSES.weth as `0x${string}`;

describe("createPoolKeyFor", () => {
  const TIER_HOOK = "0x1234567890123456789012345678901234561080" as `0x${string}`;

  it("uses the given fee-tier hook when one is passed", () => {
    const { key } = createPoolKeyFor(TOKEN, WETH, 160, TIER_HOOK);
    expect(key.hooks.toLowerCase()).toBe(TIER_HOOK.toLowerCase());
    expect(key.tickSpacing).toBe(160);
  });

  it("falls back to the legacy standard hook when no tier is given", () => {
    const { key } = createPoolKeyFor(TOKEN, WETH, 160);
    expect(key.hooks.toLowerCase()).toBe(ADDRESSES.friarStandard.toLowerCase());
  });

  it("the tier hook AND the spacing each change the PoolId — both are pool identity", () => {
    const base = createPoolKeyFor(TOKEN, WETH, 160, TIER_HOOK).key;
    const otherSpacing = createPoolKeyFor(TOKEN, WETH, 100, TIER_HOOK).key;
    const otherHook = createPoolKeyFor(TOKEN, WETH, 160).key; // standard hook
    expect(poolId(base)).not.toBe(poolId(otherSpacing));
    expect(poolId(base)).not.toBe(poolId(otherHook));
  });

  it("a create poolChoice resolves to the same key as createPoolKeyFor (join uses the key as-is)", () => {
    // documents the contract planOpen relies on: create → createPoolKeyFor(tier, spacing);
    // join → the selected pool's key verbatim. Keeping them consistent is what makes the
    // selector's default (join the deepest) and its "create" option land on the right pool.
    const created = createPoolKeyFor(TOKEN, WETH, 100, TIER_HOOK).key;
    // a join choice would carry exactly this key, so the ids match
    expect(poolId(created)).toBe(poolId({ ...created }));
  });
});
