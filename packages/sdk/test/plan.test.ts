import { describe, expect, it } from "vitest";
import { getSqrtPriceAtTick, valuePosition } from "@friar/core";
import { ADDRESSES, FEE_TIERS, feeTierForHook } from "@friar/chain";
import { planOpen, poolKeyFor, DEFAULT_SPACING, STABLE_RAIL_SPACING, defaultSpacingFor } from "../src/plan.ts";
import type { PoolState } from "../src/types.ts";

const WETH = ADDRESSES.weth as `0x${string}`;
const USDG = ADDRESSES.usdg as `0x${string}`;
// an arbitrary "token" address that sorts above WETH so quoteIs0 = true
const TOKEN_HI = "0xffffffffffffffffffffffffffffffffffffffff" as const;

const liveState = (tick: number): PoolState => ({
  live: true,
  sqrtPriceX96: getSqrtPriceAtTick(tick) + 1n, // strictly inside the active bucket
  tick,
  lpFee: 5000,
});

describe("anchorSqrtPriceX96", () => {
  it("re-anchors a live plan away from a pinned pool price (the stale-empty-pool case)", () => {
    const marketTick = 200_000;
    const pinned = liveState(100_000); // pool frozen far below market — an emptied pool's lie
    const anchored = planOpen(
      {
        token: TOKEN_HI,
        shape: "spot",
        depthBelowPct: 20,
        depthAbovePct: 0,
        amountQuote: 10n ** 18n,
        amountBase: 0n,
        anchorSqrtPriceX96: getSqrtPriceAtTick(marketTick) + 1n,
      },
      pinned,
    );
    // bins land around MARKET, not the pinned pool tick (quoteIs0: bids sit above in raw ticks)
    const ticks = anchored.bins.map((b) => b.tickLower);
    expect(Math.min(...ticks)).toBeGreaterThan(190_000);
    // without the anchor, the same input plans around the pinned price
    const stale = planOpen(
      { token: TOKEN_HI, shape: "spot", depthBelowPct: 20, depthAbovePct: 0, amountQuote: 10n ** 18n, amountBase: 0n },
      pinned,
    );
    expect(Math.max(...stale.bins.map((b) => b.tickUpper))).toBeLessThan(190_000);
  });
});

describe("poolKeyFor", () => {
  it("sorts currencies and flags quote orientation", () => {
    const { key, quoteIs0 } = poolKeyFor(TOKEN_HI, WETH);
    expect(quoteIs0).toBe(true);
    expect(key.currency0.toLowerCase()).toBe(WETH.toLowerCase());
    expect(key.currency1).toBe(TOKEN_HI);
    expect(key.tickSpacing).toBe(DEFAULT_SPACING);
    expect(key.hooks).toBe(ADDRESSES.friarStandard);
  });

  it("defaults quote to WETH", () => {
    const a = poolKeyFor(TOKEN_HI);
    const b = poolKeyFor(TOKEN_HI, WETH);
    expect(a.key).toEqual(b.key);
  });

  it("opens a fee-tier pool under the given FriarTier hook (base fee is the hook)", () => {
    const tier = FEE_TIERS.find((t) => t.pct === 5);
    // FEE_TIERS carry the deployed hook addresses; the 5% tier hook goes onto the key
    if (tier?.hook) {
      const { key } = poolKeyFor(TOKEN_HI, WETH, 160, tier.hook);
      expect(key.hooks.toLowerCase()).toBe(tier.hook.toLowerCase());
      expect(feeTierForHook(key.hooks)?.pct).toBe(5);
    }
    // and the default stays the legacy standard hook
    expect(poolKeyFor(TOKEN_HI, WETH).key.hooks).toBe(ADDRESSES.friarStandard);
  });
});

describe("planOpen", () => {
  const base = {
    token: TOKEN_HI,
    quote: WETH,
    shape: "spot" as const,
    depthBelowPct: 20,
    depthAbovePct: 20,
    amountQuote: 10n ** 18n,
    amountBase: 10n ** 18n,
  };

  it("plans a two-sided spot with an active bin against a live pool", () => {
    const plan = planOpen(base, liveState(0));
    expect(plan.poolLive).toBe(true);
    expect(plan.initSqrtPriceX96).toBeNull();
    expect(plan.contractBins.length).toBeGreaterThan(2);
    expect(plan.bins.some((b) => b.side === "active")).toBe(true);
    // deposit needed matches marking the planned bins at the pool price
    const needs = valuePosition(plan.contractBins, plan.state.sqrtPriceX96);
    expect(plan.needs0).toBe(needs.amount0);
    expect(plan.needs1).toBe(needs.amount1);
    expect(plan.maxPay0).toBe((needs.amount0 * 101n) / 100n);
    // budget conservation: needs never exceed what the caller offered per side
    // (quote is currency0 here)
    expect(plan.needs0 <= base.amountQuote).toBe(true);
    expect(plan.needs1 <= base.amountBase).toBe(true);
    expect(plan.swapIn.enabled).toBe(false);
  });

  it("plans single-sided bids needing only the quote token", () => {
    const plan = planOpen({ ...base, depthAbovePct: 0, amountBase: 0n }, liveState(0));
    // quoteIs0 → bids live above the... no: bids are quote side = currency0 here
    expect(plan.needs1).toBe(0n);
    expect(plan.needs0).toBeGreaterThan(0n);
    expect(plan.bins.every((b) => b.side === "bid")).toBe(true);
  });

  it("routes a dead pool to openNew with the supplied init price", () => {
    const init = getSqrtPriceAtTick(-2000);
    const plan = planOpen(
      { ...base, initSqrtPriceX96: init },
      { live: false, sqrtPriceX96: 0n, tick: 0, lpFee: 0 },
    );
    expect(plan.poolLive).toBe(false);
    expect(plan.initSqrtPriceX96).toBe(init);
  });

  it("rejects a dead pool without an init price", () => {
    expect(() => planOpen(base, { live: false, sqrtPriceX96: 0n, tick: 0, lpFee: 0 })).toThrow(/initSqrtPriceX96/);
  });

  it("rejects zero-bin and over-wide plans", () => {
    expect(() => planOpen({ ...base, depthBelowPct: 0, depthAbovePct: 0 }, liveState(0))).toThrow(/zero bins/);
    expect(() => planOpen({ ...base, depthBelowPct: 99.9, depthAbovePct: 400 }, liveState(0))).toThrow(/too many bins/);
  });

  it("rejects a side with bins but no budget", () => {
    expect(() => planOpen({ ...base, amountBase: 0n }, liveState(0))).toThrow(/amountBase/);
  });

  it("USDG outranks nothing here but orients as quote when currency0", () => {
    const { quoteIs0 } = poolKeyFor(TOKEN_HI, USDG);
    expect(quoteIs0).toBe(true); // USDG sorts below the high token address
  });
});

describe("planSimpleOpen / resolvePoolRef", async () => {
  const { planSimpleOpen, resolvePoolRef } = await import("../src/plan.ts");
  const { HOOK_FLAGS } = await import("@friar/chain");
  const hookAddr = (bits: number) => `0x${(0xabcdn * 2n ** 14n + BigInt(bits)).toString(16).padStart(40, "0")}` as `0x${string}`;
  const ZERO = "0x0000000000000000000000000000000000000000" as const;
  const byoPool = {
    currency0: USDG,
    currency1: TOKEN_HI,
    fee: 3000,
    tickSpacing: 60,
    hooks: ZERO,
  };

  it("one bin straddling spot needs both tokens; caps are needs + 1%", () => {
    const state = liveState(0);
    const plan = planSimpleOpen(
      { token: TOKEN_HI, quote: WETH, depthBelowPct: 20, depthAbovePct: 20, amountQuote: 10n ** 18n, amountBase: 10n ** 18n },
      state,
    );
    expect(plan.contractBins.length).toBe(1);
    expect(plan.bins[0]!.side).toBe("active");
    expect(plan.needs0 > 0n && plan.needs1 > 0n).toBe(true);
    expect(plan.maxPay0).toBe((plan.needs0 * 101n) / 100n);
    expect(plan.hookVerdict).toBeNull();
    expect(plan.summary).toContain("simple");
  });

  it("range edges land on the pool's own tick spacing for brought pools", () => {
    const plan = planSimpleOpen(
      { pool: byoPool, depthBelowPct: 15, depthAbovePct: 5, amountQuote: 10n ** 18n, amountBase: 10n ** 18n },
      liveState(0),
    );
    expect(Math.abs(plan.bins[0]!.tickLower % 60)).toBe(0);
    expect(Math.abs(plan.bins[0]!.tickUpper % 60)).toBe(0);
    expect(plan.hookVerdict?.level).toBe("ok");
  });

  it("brought pool orientation: USDG side is the quote by default", () => {
    const { quoteIs0 } = resolvePoolRef({ pool: byoPool });
    expect(quoteIs0).toBe(true); // USDG is currency0
  });

  it("explicit quote must be a side of the brought pool", () => {
    expect(() => resolvePoolRef({ pool: byoPool, quote: WETH })).toThrow(/not one of the supplied pool/);
  });

  it("refuses pools whose hook runs on liquidity removal", () => {
    const risky = { ...byoPool, hooks: hookAddr(HOOK_FLAGS.beforeRemoveLiquidity) };
    expect(() => resolvePoolRef({ pool: risky })).toThrow(/unsafe hook/);
  });

  it("needs either pool or token", () => {
    expect(() => resolvePoolRef({})).toThrow(/pool.*or.*token/);
  });

  it("one-sided range below spot needs only the quote side", () => {
    const plan = planSimpleOpen(
      { token: TOKEN_HI, quote: WETH, depthBelowPct: 25, depthAbovePct: 0, amountQuote: 10n ** 18n, amountBase: 0n },
      liveState(0),
    );
    expect(plan.contractBins.length).toBe(1);
    // TOKEN_HI/WETH sorts WETH as currency0 (quoteIs0): user-below = pool-above = all currency0 = quote only
    expect(plan.needs0 > 0n).toBe(true);
    expect(plan.needs1).toBe(0n);
  });
});

// The base fee is `baseFactor x binStep` with binStep == tickSpacing, and baseFactor is
// immutable at 5000 on both deployed hooks — so these constants ARE the fee schedule of
// every pool the SDK creates. Guard them: a silent edit here re-prices new pools.
describe("default spacing == the base fee of a newly created pool", () => {
  const basePips = (spacing: number) => 50 * spacing; // baseFactor 5000 x spacing x 1e10 / 1e12

  it("WETH-rail pairs default to a 0.80% base (spacing 160)", () => {
    expect(DEFAULT_SPACING).toBe(160);
    expect(basePips(DEFAULT_SPACING)).toBe(8_000); // 0.80%
    expect(defaultSpacingFor(WETH)).toBe(160);
    expect(poolKeyFor(TOKEN_HI, WETH).key.tickSpacing).toBe(160);
  });

  it("USDG-rail pairs stay finer, at a 0.50% base (spacing 100)", () => {
    expect(STABLE_RAIL_SPACING).toBe(100);
    expect(basePips(STABLE_RAIL_SPACING)).toBe(5_000); // 0.50%
    expect(defaultSpacingFor(USDG)).toBe(100);
    expect(poolKeyFor(TOKEN_HI, USDG).key.tickSpacing).toBe(100);
  });

  it("an explicit spacing still wins", () => {
    expect(poolKeyFor(TOKEN_HI, WETH, 200).key.tickSpacing).toBe(200);
  });
});
