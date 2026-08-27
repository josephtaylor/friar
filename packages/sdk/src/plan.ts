// Position planning: shape spec → the exact structs open/openNew take. Pure given a
// PoolState — the FriarClient wrapper fetches state and delegates here.
//
// v1 planning is no-swap only (deposit both tokens at the ratio the shape implies;
// single-sided shapes need just one). Swap-in zaps are a passthrough on buildOpen for
// callers who assemble their own SwapIn — agents that hold only one token can swap
// through their own venue first.
import { ADDRESSES, DYNAMIC_FEE_FLAG, classifyHook, type HookVerdict, type PoolKey } from "@friar/chain";
import {
  binsForDepth,
  computeShape,
  getSqrtPriceAtTick,
  liquidityForAmount0,
  liquidityForAmount1,
  simpleRangeTicks,
  valuePosition,
  type PlannedBin,
} from "@friar/core";
import type { Address } from "viem";
import type { ContractBin, OpenPlan, PlanOpenInput, PlanSimpleOpenInput, PoolRef, PoolState, SwapIn } from "./types.ts";

/**
 * Base fee is `baseFactor × binStep`, and binStep IS the pool's tickSpacing — so with the
 * hooks' immutable `baseFactor 5000`, **the base fee is chosen when the pool is created**:
 * `base% = 0.005 × tickSpacing` (0.50% @ 100, 0.80% @ 160, 1.00% @ 200). No new hook is
 * needed to retune it; the hooklist allowlists the hook, not the pool.
 *
 * Default moved 100 → 160 (0.50% → 0.80% base) on 2026-07-25. USDG-rail pairs (stock/RWA
 * tokens, tight ranges) keep 100, since 160 gives 1.61%-wide bins.
 */
export const DEFAULT_SPACING = 160;
export const STABLE_RAIL_SPACING = 100;
export const MAX_BINS = 100;

export const defaultSpacingFor = (quote: Address): number =>
  quote.toLowerCase() === (ADDRESSES.usdg as Address).toLowerCase() ? STABLE_RAIL_SPACING : DEFAULT_SPACING;

/** Canonical PoolKey for a token/quote pair on the standard Friar hook.
 *
 * NOTE: a pool's tickSpacing is immutable, so for a token that already has a Friar pool at
 * a different spacing this key names a DIFFERENT (possibly uninitialized) pool. Opening
 * there would split depth, and routing on 4663 is decided by depth, not fee. Callers that
 * can read the chain should resolve the existing pool and pass it as `{pool}` instead;
 * `poolById`/`fetchPoolKeyById` exist for exactly that. */
export function poolKeyFor(
  token: Address,
  quote: Address = ADDRESSES.weth as Address,
  spacing = defaultSpacingFor(quote),
  feeHook?: Address,
): { key: PoolKey; quoteIs0: boolean } {
  const quoteIs0 = quote.toLowerCase() < token.toLowerCase();
  const [currency0, currency1] = quoteIs0 ? [quote, token] : [token, quote];
  // feeHook = a chosen FriarTier fee-tier hook (base fee lives in the hook); the legacy
  // standard hook is the default. base fee is off the PoolKey either way, so the verb is
  // plain open/openNew, never a configured open.
  const hooks = feeHook ?? (ADDRESSES.friarStandard as Address);
  return {
    key: { currency0, currency1, fee: DYNAMIC_FEE_FLAG, tickSpacing: spacing, hooks },
    quoteIs0,
  };
}

export function disabledSwapIn(venue: PoolKey): SwapIn {
  return { enabled: false, venue, zeroForOne: false, amountIn: 0n, minAmountOut: 0n, sqrtPriceLimitX96: 0n };
}

/**
 * Resolve a PoolRef to a concrete pool + orientation. Brought pools are hook-screened:
 * a hook that runs on liquidity REMOVAL can block or tax exits, so it throws here —
 * money-out is non-negotiable. Add-hooks pass with a warn-level verdict (the open can
 * only revert or cost more, and pay caps bound that).
 */
export function resolvePoolRef(ref: PoolRef): { key: PoolKey; quoteIs0: boolean; hookVerdict: HookVerdict | null } {
  if (ref.pool) {
    const key = ref.pool;
    const verdict = classifyHook(key.hooks as Address);
    if (verdict.level === "block") {
      throw new Error(`refusing pool with unsafe hook: ${verdict.reasons[0] ?? "removal-hook permissions"}`);
    }
    const c0 = key.currency0.toLowerCase();
    const c1 = key.currency1.toLowerCase();
    let quoteIs0: boolean;
    if (ref.quote) {
      const q = ref.quote.toLowerCase();
      if (q === c0) quoteIs0 = true;
      else if (q === c1) quoteIs0 = false;
      else throw new Error("quote is not one of the supplied pool's currencies");
    } else {
      // default orientation: dollar rail beats ETH rail beats sorting convention
      const usdg = ADDRESSES.usdg.toLowerCase();
      const weth = ADDRESSES.weth.toLowerCase();
      quoteIs0 = c0 === usdg ? true : c1 === usdg ? false : c0 === weth;
    }
    return { key, quoteIs0, hookVerdict: verdict };
  }
  if (!ref.token) throw new Error("supply either `pool` (bring-your-own-pool) or `token`");
  const { key, quoteIs0 } = poolKeyFor(ref.token, ref.quote, ref.spacing, ref.feeHook);
  return { key, quoteIs0, hookVerdict: null };
}

export function toContractBins(bins: ReadonlyArray<PlannedBin>): ContractBin[] {
  return bins.map((b) => ({ tickLower: b.tickLower, tickUpper: b.tickUpper, liquidity: b.liquidity }));
}

/** Plan a shaped open against a known pool state. Throws on shapes the contract would
 * reject. Takes either the standard Friar pool (`token`) or any v4 pool (`pool`). */
export function planOpen(input: PlanOpenInput, state: PoolState): OpenPlan {
  const { key, quoteIs0, hookVerdict } = resolvePoolRef(input);
  const spacing = key.tickSpacing;

  if (input.pool && !state.live) throw new Error("brought pool is not initialized on-chain");
  const sqrtPriceX96 = state.live ? (input.anchorSqrtPriceX96 ?? state.sqrtPriceX96) : input.initSqrtPriceX96;
  if (sqrtPriceX96 === undefined || sqrtPriceX96 === null || sqrtPriceX96 <= 0n) {
    throw new Error("pool is not live: supply initSqrtPriceX96 to plan an openNew");
  }
  const activeTick = state.live && input.anchorSqrtPriceX96 === undefined ? state.tick : sqrtTickApprox(sqrtPriceX96);

  const bidBins = binsForDepth(input.depthBelowPct, spacing, "bid");
  const askBins = binsForDepth(input.depthAbovePct, spacing, "ask");
  if (bidBins + askBins === 0) throw new Error("zero bins: increase depthBelowPct/depthAbovePct");
  if (bidBins + askBins > MAX_BINS) {
    throw new Error(`too many bins (${bidBins + askBins} > ${MAX_BINS}): shrink depth or use a wider spacing`);
  }
  if (bidBins > 0 && input.amountQuote <= 0n) throw new Error("bids planned but amountQuote is 0");
  if (askBins > 0 && input.amountBase <= 0n) throw new Error("asks planned but amountBase is 0");

  const { bids, asks, active } = computeShape({
    shape: input.shape,
    spacing,
    activeTick,
    bidBins,
    askBins,
    amountQuote: input.amountQuote,
    amountBase: input.amountBase,
    quoteIs0,
    sqrtPriceX96,
    ...(input.growth !== undefined ? { growth: input.growth } : {}),
  });
  // contract order doesn't matter; keep chart order (deep bid → active → high ask)
  const bins = [...bids].reverse().concat(active, asks);
  const contractBins = toContractBins(bins).filter((b) => b.liquidity > 0n);
  if (contractBins.length === 0) throw new Error("all planned bins have zero liquidity: budget too small");

  // Exact deposit the manager pulls = value of all bins at the current price.
  const needs = valuePosition(contractBins, sqrtPriceX96);
  const maxPay0 = (needs.amount0 * 101n) / 100n;
  const maxPay1 = (needs.amount1 * 101n) / 100n;

  const verb = state.live ? "open" : "openNew";
  const sideWords = [
    bidBins > 0 ? `${bidBins} bid bins ${input.depthBelowPct}% down` : null,
    active.length > 0 ? "1 active bin" : null,
    askBins > 0 ? `${askBins} ask bins ${input.depthAbovePct}% up` : null,
  ].filter(Boolean);
  const summary = `${verb} ${input.shape} position: ${sideWords.join(" + ")} (${contractBins.length} bins on-chain)`;

  return {
    key,
    quoteIs0,
    poolLive: state.live,
    initSqrtPriceX96: state.live ? null : sqrtPriceX96,
    state,
    bins,
    contractBins,
    needs0: needs.amount0,
    needs1: needs.amount1,
    maxPay0,
    maxPay1,
    swapIn: disabledSwapIn(key),
    hookVerdict,
    summary,
  };
}

/**
 * Plan a "simple" open: ONE bin spanning [-below%, +above%] around the current price —
 * a v3-style single range. Pays the manager's simple fee tier (1% of fees earned vs 10%
 * for shaped). Deposit-both semantics like planOpen: the binding side sets the
 * liquidity, the other side's surplus is never pulled.
 */
export function planSimpleOpen(input: PlanSimpleOpenInput, state: PoolState): OpenPlan {
  const { key, quoteIs0, hookVerdict } = resolvePoolRef(input);
  const spacing = key.tickSpacing;

  if (input.pool && !state.live) throw new Error("brought pool is not initialized on-chain");
  const sqrtPriceX96 = state.live ? (input.anchorSqrtPriceX96 ?? state.sqrtPriceX96) : input.initSqrtPriceX96;
  if (sqrtPriceX96 === undefined || sqrtPriceX96 === null || sqrtPriceX96 <= 0n) {
    throw new Error("pool is not live: supply initSqrtPriceX96 to plan an openNew");
  }
  if (input.depthBelowPct <= 0 && input.depthAbovePct <= 0) {
    throw new Error("zero range: set depthBelowPct and/or depthAbovePct");
  }
  const activeTick = state.live && input.anchorSqrtPriceX96 === undefined ? state.tick : sqrtTickApprox(sqrtPriceX96);

  const { tickLower, tickUpper } = simpleRangeTicks(
    activeTick,
    spacing,
    input.depthBelowPct,
    input.depthAbovePct,
    quoteIs0,
  );
  const sqrtA = getSqrtPriceAtTick(tickLower);
  const sqrtB = getSqrtPriceAtTick(tickUpper);

  // liquidity from the two budgets: whichever side the range needs binds it
  const a0 = quoteIs0 ? input.amountQuote : input.amountBase;
  const a1 = quoteIs0 ? input.amountBase : input.amountQuote;
  let liquidity: bigint;
  if (sqrtPriceX96 <= sqrtA) liquidity = liquidityForAmount0(sqrtA, sqrtB, a0);
  else if (sqrtPriceX96 >= sqrtB) liquidity = liquidityForAmount1(sqrtA, sqrtB, a1);
  else {
    const l0 = liquidityForAmount0(sqrtPriceX96, sqrtB, a0);
    const l1 = liquidityForAmount1(sqrtA, sqrtPriceX96, a1);
    liquidity = l0 < l1 ? l0 : l1;
  }
  if (liquidity <= 0n) throw new Error("amounts too small for this range");

  const side: PlannedBin["side"] =
    sqrtPriceX96 <= sqrtA ? (quoteIs0 ? "bid" : "ask") : sqrtPriceX96 >= sqrtB ? (quoteIs0 ? "ask" : "bid") : "active";
  const bins: PlannedBin[] = [{ tickLower, tickUpper, weight: 1, amount: input.amountQuote, liquidity, side }];
  const contractBins = toContractBins(bins);

  const needs = valuePosition(contractBins, sqrtPriceX96);
  const maxPay0 = (needs.amount0 * 101n) / 100n;
  const maxPay1 = (needs.amount1 * 101n) / 100n;

  const verb = state.live ? "open" : "openNew";
  const summary = `${verb} simple position: one range −${input.depthBelowPct}%/+${input.depthAbovePct}% (1 bin, simple fee tier)`;

  return {
    key,
    quoteIs0,
    poolLive: state.live,
    initSqrtPriceX96: state.live ? null : sqrtPriceX96,
    state,
    bins,
    contractBins,
    needs0: needs.amount0,
    needs1: needs.amount1,
    maxPay0,
    maxPay1,
    swapIn: disabledSwapIn(key),
    hookVerdict,
    summary,
  };
}

// tick from sqrtPriceX96, float log — plenty for choosing the active bucket of a
// not-yet-initialized pool (the contract initializes at the exact sqrtPrice we pass).
function sqrtTickApprox(sqrtPriceX96: bigint): number {
  const ratio = Number(sqrtPriceX96) / 2 ** 96;
  return Math.floor(Math.log(ratio * ratio) / Math.log(1.0001));
}
