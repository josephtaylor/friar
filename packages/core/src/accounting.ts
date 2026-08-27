// Position-unit accounting: unclaimed fees from fee-growth deltas, mark-to-market,
// and the number this project answers to — fees earned vs inventory delta (LVR).
import { amountsForLiquidity } from "./liquidity.ts";
import type { Side } from "./position.ts";

const Q128 = 1n << 128n;
const MOD256 = 1n << 256n;
const E18 = 10n ** 18n;

// v4 fee growth arithmetic wraps at 2^256; the delta is taken modulo, like the core.
const wrapSub = (a: bigint, b: bigint): bigint => (a - b + MOD256) % MOD256;

export interface FeeGrowthInside {
  feeGrowthInside0X128: bigint;
  feeGrowthInside1X128: bigint;
}

export interface FeeGrowthLast {
  feeGrowthInside0LastX128: bigint;
  feeGrowthInside1LastX128: bigint;
}

/** Unclaimed fees for one bin given current inside growth and the position's last snapshot. */
export function unclaimedFees(
  liquidity: bigint,
  insideNow: FeeGrowthInside,
  insideLast: FeeGrowthLast,
): { fees0: bigint; fees1: bigint } {
  return {
    fees0: (wrapSub(insideNow.feeGrowthInside0X128, insideLast.feeGrowthInside0LastX128) * liquidity) / Q128,
    fees1: (wrapSub(insideNow.feeGrowthInside1X128, insideLast.feeGrowthInside1LastX128) * liquidity) / Q128,
  };
}

export interface MarkableBin {
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
  fees0?: bigint;
  fees1?: bigint;
}

export interface Mark {
  amount0: bigint;
  amount1: bigint;
  fees0: bigint;
  fees1: bigint;
}

/**
 * Mark a position unit to market: totals of principal + fees across bins at sqrtP.
 * NOTE: pass the TRUE market sqrtP, not a breached pool's frozen tick.
 */
export function markPosition(bins: ReadonlyArray<MarkableBin>, sqrtP: bigint): Mark {
  let amount0 = 0n;
  let amount1 = 0n;
  let fees0 = 0n;
  let fees1 = 0n;
  for (const r of bins) {
    const a = amountsForLiquidity(sqrtP, r.tickLower, r.tickUpper, r.liquidity);
    amount0 += a.amount0;
    amount1 += a.amount1;
    fees0 += r.fees0 ?? 0n;
    fees1 += r.fees1 ?? 0n;
  }
  return { amount0, amount1, fees0, fees1 };
}

/** price of token0 in token1 terms from sqrtPriceX96, scaled 1e18. */
export function price1e18(sqrtPriceX96: bigint): bigint {
  return (sqrtPriceX96 * sqrtPriceX96 * E18) >> 192n;
}

/** v4's swap-price limits. A pool sitting ON one of them has been pushed to the end of
 *  its range by a swap; the value is a boundary, not a quote. */
export const MIN_SQRT_PRICE = 4295128739n;
export const MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342n;

/**
 * `price1e18` for MARKING, which returns 0n ("no usable price") instead of a number that
 * is arithmetically real and economically meaningless.
 *
 * A pool pinned at a swap limit is not a price. FLAMINGO/WETH read slot0 =
 * MAX_SQRT_PRICE-1, which squares to 3.4e38 token1 per token0, and position #284's 6,930
 * unclaimed FLAMINGO of fees were then valued at 2.24e42 WETH. That single row is summed
 * into the History tiles, so realized PnL, fees banked and per-deploy 30d all rendered as
 * 1e42-scale garbage off one position out of 244.
 *
 * Returning 0 is not a fallback price, it is the absence of one, and every caller already
 * has that branch: `summarizePosition` drops the token leg and values the quote leg only
 * (the same degradation as a missing snapshot), and the indexer's NAV pass puts the owner
 * in `navSkipOwners` rather than recording a lie. Both are honest understatements; the
 * alternative is a number 43 orders of magnitude wrong that poisons every aggregate it
 * touches.
 *
 * Deliberately narrow. This tests for a price AT a limit, not merely a large one, because
 * "implausibly extreme" is an economic judgement that belongs nowhere near tick math. All
 * six affected positions read exactly MAX_SQRT_PRICE-1. A pool breached to somewhere short
 * of the limit still marks on its own tick, which is what `market_sqrt_price` (the true
 * market read, when a ref venue exists) is there to correct — see the CASHCAT lesson.
 */
export function markPrice1e18(sqrtPriceX96: bigint): bigint {
  if (sqrtPriceX96 <= MIN_SQRT_PRICE + 1n || sqrtPriceX96 >= MAX_SQRT_PRICE - 1n) return 0n;
  return price1e18(sqrtPriceX96);
}

export interface Decomposition {
  /** fee income valued in quote */
  feesQuote: bigint;
  /** (current value of principal) − basis: the LVR/IL term */
  inventoryDelta: bigint;
  /** feesQuote + inventoryDelta */
  pnl: bigint;
  principalQuote: bigint;
}

/**
 * The verdict decomposition for a position opened with `basisQuote` of quote token.
 * Positive pnl with negative inventoryDelta = fees beating adverse selection.
 */
export function decompose(mark: Mark, sqrtP: bigint, basisQuote: bigint, quoteIs0 = false): Decomposition {
  const px = price1e18(sqrtP);
  const val = quoteIs0
    ? (a0: bigint, a1: bigint) => a0 + (a1 * E18) / px
    : (a0: bigint, a1: bigint) => a1 + (a0 * px) / E18;
  const feesQuote = val(mark.fees0, mark.fees1);
  const principalQuote = val(mark.amount0, mark.amount1);
  const inventoryDelta = principalQuote - basisQuote;
  return { feesQuote, inventoryDelta, pnl: feesQuote + inventoryDelta, principalQuote };
}

export type BinState = "waiting" | "active" | "filled";

export interface StatusBin {
  tickLower: number;
  tickUpper: number;
  side?: Side | "active";
}

export interface PositionStatus<T extends StatusBin> {
  minTick: number;
  maxTick: number;
  location: "above" | "below" | "in-range";
  pctFromBottom: number;
  counts: Record<BinState, number>;
  states: Array<T & { state: BinState }>;
}

/**
 * Meteora-style position status. Bin states by composition at current tick, mapped
 * through the bin's side:
 *   bid:  price above bin = waiting (still quote) | inside = active | below = filled (bought)
 *   ask:  price below bin = waiting (still base)  | inside = active | above = filled (sold)
 * Span = lowest tickLower .. highest tickUpper across all bins.
 */
export function positionStatus<T extends StatusBin>(
  bins: ReadonlyArray<T>,
  tick: number,
  quoteIs0 = false,
): PositionStatus<T> {
  const minTick = Math.min(...bins.map((r) => r.tickLower));
  const maxTick = Math.max(...bins.map((r) => r.tickUpper));

  const states = bins.map((r) => {
    // "active" (the mixed spot bin) reports "active" while in range (composition mixed);
    // once price fully exits its one bucket it falls through the non-bid branch below.
    const side = r.side ?? "bid";
    let composition: "allToken0" | "allToken1" | "mixed";
    if (tick >= r.tickUpper) composition = "allToken1";
    else if (tick < r.tickLower) composition = "allToken0";
    else composition = "mixed";
    const stillQuote = quoteIs0 ? "allToken0" : "allToken1";
    const state: BinState =
      composition === "mixed"
        ? "active"
        : side === "bid"
          ? composition === stillQuote
            ? "waiting"
            : "filled"
          : composition === stillQuote
            ? "filled"
            : "waiting";
    return { ...r, state };
  });

  const counts: Record<BinState, number> = { waiting: 0, active: 0, filled: 0 };
  for (const s of states) counts[s.state]++;

  // location/pct are USER-price oriented: when quote is currency0, price runs
  // inverse to ticks, so tick-space above/below and the percentage flip.
  let location: "above" | "below" | "in-range" = tick >= maxTick ? "above" : tick < minTick ? "below" : "in-range";
  let pctFromBottom =
    location === "above" ? 100 : location === "below" ? 0 : Math.round(((tick - minTick) / (maxTick - minTick)) * 100);
  if (quoteIs0) {
    location = location === "above" ? "below" : location === "below" ? "above" : "in-range";
    pctFromBottom = 100 - pctFromBottom;
  }

  return { minTick, maxTick, location, pctFromBottom, counts, states };
}

/** One-line position bar in chart orientation: lowest USER price left, highest right.
 * When quote is currency0, the token's price runs INVERSE to ticks — flip the sort. */
export function positionBar(states: ReadonlyArray<StatusBin & { state: BinState }>, quoteIs0 = false): string {
  const glyph: Record<BinState, string> = { waiting: "░", active: "▓", filled: "█" };
  const ordered = [...states].sort((a, b) => a.tickUpper - b.tickUpper);
  if (quoteIs0) ordered.reverse();
  return ordered.map((s) => glyph[s.state]).join("");
}
