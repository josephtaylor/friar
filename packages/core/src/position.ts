// Position computation: compile a shape spec into exact per-bin ranges + liquidity.
// Pure math; the chain layer consumes the output.
import { getSqrtPriceAtTick, MIN_TICK, MAX_TICK } from "./tickmath.ts";
import { amountsForLiquidity } from "./liquidity.ts";
import type { Amounts } from "./liquidity.ts";

export type Side = "bid" | "ask";
export type WeightScheme = "flat" | "linear" | "taper" | "exp";
export type Shape = "spot" | "curve" | "bidask";

export interface PositionSpec {
  /** bid = below spot (all quote), ask = above spot (all base) — in POOL orientation. */
  side: Side;
  /** pool tickSpacing */
  spacing: number;
  /** current pool tick */
  activeTick: number;
  /** number of bins */
  bins: number;
  /** bin widths in spacings (scalar or per-bin; deep bins may be coarser) */
  widthMultiples?: number | number[];
  /** allocation scheme, growing away from spot for bid-ask */
  weights?: WeightScheme | number[];
  /** for "exp": per-bin multiplier (e.g. 1.15) */
  growth?: number;
  /** total quote (bid) or base (ask) to deploy */
  totalAmount: bigint;
  /** spacings between spot and first bin (0 = touch active bucket edge) */
  startOffset?: number;
}

export interface PlannedBin {
  tickLower: number;
  tickUpper: number;
  weight: number;
  amount: bigint;
  liquidity: bigint;
  /** user-semantic side tag (attached by computeShape); "active" = the mixed spot bin */
  side?: Side | "active";
}

export interface ShapeSpec {
  shape: Shape;
  spacing: number;
  activeTick: number;
  /** either may be 0 */
  bidBins?: number;
  askBins?: number;
  /** budget for the bid side (quote token) */
  amountQuote?: bigint;
  /** budget for the ask side (base token) */
  amountBase?: bigint;
  widthMultiples?: number | number[];
  growth?: number;
  startOffset?: number;
  /** quote sorted as currency0: user bid/ask maps to the inverted pool side */
  quoteIs0?: boolean;
  /** live pool sqrt price; supply it to fill the active bucket (mixed bin) for continuity */
  sqrtPriceX96?: bigint;
  /** override active-bucket fill (default: fill when sqrtPriceX96 is in-range and both legs exist) */
  fillActive?: boolean;
}

/**
 * The single bin's tick range for a "simple" (one-range, v3-style) position. The %
 * depths are in USER price terms (quote per token), so when the quote sorts as
 * currency0 the pool-tick direction inverts: user-below-price = pool-ticks-above.
 * Edges round OUTWARD to the spacing grid (you never get less range than you asked
 * for), clamped to the tick domain.
 */
export function simpleRangeTicks(
  tick: number,
  spacing: number,
  belowPct: number,
  abovePct: number,
  quoteIs0: boolean,
): { tickLower: number; tickUpper: number } {
  const T = 1e-4; // log-price per tick, same convention as binsForDepth
  const ticksBelow = belowPct > 0 ? -Math.log(1 - Math.min(belowPct, 99.99) / 100) / T : 0;
  const ticksAbove = abovePct > 0 ? Math.log(1 + abovePct / 100) / T : 0;
  const [dnTicks, upTicks] = quoteIs0 ? [ticksAbove, ticksBelow] : [ticksBelow, ticksAbove];
  let tickLower = Math.floor((tick - dnTicks) / spacing) * spacing;
  let tickUpper = Math.ceil((tick + upTicks) / spacing) * spacing;

  // One-sided ranges (a depth of 0 on one side) are bid-only/ask-only by intent —
  // snap the near edge to the active bucket's boundary so the range never straddles
  // spot (a straddling edge would demand dust of the other token). Meteora bid/ask
  // convention: bids fill below the active bin, asks above.
  const bucket = bucketOf(tick, spacing) * spacing; // active bucket floor
  if (abovePct <= 0) {
    if (quoteIs0) tickLower = Math.max(tickLower, bucket + spacing);
    else tickUpper = Math.min(tickUpper, bucket);
  }
  if (belowPct <= 0) {
    if (quoteIs0) tickUpper = Math.min(tickUpper, bucket);
    else tickLower = Math.max(tickLower, bucket + spacing);
  }

  tickLower = Math.max(tickLower, Math.ceil(MIN_TICK / spacing) * spacing);
  tickUpper = Math.min(tickUpper, Math.floor(MAX_TICK / spacing) * spacing);
  if (tickUpper <= tickLower) {
    // degenerate (tiny depth): grow one spacing AWAY from spot — the snapped edge stays
    const pinnedUpper = (abovePct <= 0 && !quoteIs0) || (belowPct <= 0 && quoteIs0);
    if (pinnedUpper) tickLower = tickUpper - spacing;
    else tickUpper = tickLower + spacing;
  }
  return { tickLower, tickUpper };
}

/** Bins needed to cover a % price depth on one side (how traders think → bin count). */
export function binsForDepth(depthPct: number, spacing: number, side: Side): number {
  if (depthPct <= 0) return 0;
  const ticks = side === "bid" ? -Math.log(1 - depthPct / 100) : Math.log(1 + depthPct / 100);
  return Math.ceil(ticks / (spacing * 1e-4));
}

export function bucketOf(tick: number, spacing: number): number {
  let b = Math.trunc(tick / spacing);
  if (tick < 0 && tick % spacing !== 0) b--;
  return b;
}

/** Deposit a single-sided bin needs to hold liquidity L: quote for a bid bin (below spot,
 * priced at its top edge → all token1), base for an ask bin (above spot → all token0). */
function depositForL(side: Side, tickLower: number, tickUpper: number, L: bigint): bigint {
  const sqrtP = side === "bid" ? getSqrtPriceAtTick(tickUpper) : getSqrtPriceAtTick(tickLower);
  const a = amountsForLiquidity(sqrtP, tickLower, tickUpper, L);
  return side === "bid" ? a.amount1 : a.amount0;
}

// Reference liquidity for the allocation math; it cancels out, only relative scale matters.
const LREF = 1n << 96n;

/** Compute a one-sided position from a spec. Returns contiguous bins walking away from spot.
 *
 * Liquidity is distributed across bins in proportion to the shape weights, THEN scaled so
 * the total deposit consumes ~the whole budget. This is Meteora semantics: a "flat" (Spot)
 * shape is UNIFORM LIQUIDITY per bin — not uniform value. (Splitting the budget by weight,
 * as before, made Spot uneven in L, because L per unit value depends on the bin's price.) */
export function computePosition(spec: PositionSpec): PlannedBin[] {
  const { side, spacing, activeTick, bins, totalAmount } = spec;
  const startOffset = spec.startOffset ?? 0;
  const widths = Array.isArray(spec.widthMultiples)
    ? spec.widthMultiples
    : Array<number>(bins).fill(spec.widthMultiples ?? 1);
  if (widths.length !== bins) throw new Error("widthMultiples length != bins");

  const weights = computeWeights(spec, bins);
  const activeBucket = bucketOf(activeTick, spacing);

  // Pass 1: bin geometry + each bin's deposit cost for a reference liquidity, so the shape
  // weights can be turned into a liquidity distribution rather than a value split.
  let edge = side === "bid" ? (activeBucket - startOffset) * spacing : (activeBucket + 1 + startOffset) * spacing;
  const geom = weights.map((weight, i) => {
    const width = widths[i]! * spacing;
    const [tickLower, tickUpper] = side === "bid" ? [edge - width, edge] : [edge, edge + width];
    edge = side === "bid" ? tickLower : tickUpper;
    return { tickLower, tickUpper, weight, w: BigInt(Math.round(weight * 1e9)), cost: depositForL(side, tickLower, tickUpper, LREF) };
  });

  // L_i = LREF · budget · w_i / Σ(w_j·cost_j)  →  L ∝ weight, and Σ deposits ≈ budget.
  const denom = geom.reduce((a, g) => a + g.w * g.cost, 0n);
  return geom.map((g) => {
    const liquidity = denom > 0n ? (LREF * totalAmount * g.w) / denom : 0n;
    return { tickLower: g.tickLower, tickUpper: g.tickUpper, weight: g.weight, amount: depositForL(side, g.tickLower, g.tickUpper, liquidity), liquidity };
  });
}

function computeWeights(spec: PositionSpec, n: number): number[] {
  if (Array.isArray(spec.weights)) {
    if (spec.weights.length !== n) throw new Error("weights length != bins");
    return spec.weights;
  }
  switch (spec.weights ?? "flat") {
    case "flat":
      return Array<number>(n).fill(1);
    case "linear": // 1, 2, 3, ... growing away from spot (classic bid-ask wing)
      return Array.from({ length: n }, (_, i) => i + 1);
    case "taper": // n, n-1, ... heaviest near spot (curve wing)
      return Array.from({ length: n }, (_, i) => n - i);
    case "exp": {
      const g = spec.growth ?? 1.15;
      return Array.from({ length: n }, (_, i) => g ** i);
    }
    default:
      throw new Error(`unknown weights: ${String(spec.weights)}`);
  }
}

const SHAPE_WEIGHTS: Record<Shape, WeightScheme> = { spot: "flat", curve: "taper", bidask: "linear" };

/**
 * Meteora-style shaped deployment: Spot | Curve | Bid-Ask, below and/or above the
 * active bin. Two-sided shapes take independent per-side budgets (bids are quote,
 * asks are base). When a live in-range price (`sqrtPriceX96`) is supplied the active
 * bucket is filled with a single mixed bin so the book is continuous through spot —
 * the highest-fee real estate. Without a price it is left empty (legacy behaviour).
 */
export function computeShape(spec: ShapeSpec): { bids: PlannedBin[]; asks: PlannedBin[]; active: PlannedBin[] } {
  const weights = SHAPE_WEIGHTS[spec.shape];
  if (!weights) throw new Error(`unknown shape: ${spec.shape}`);

  const flip = spec.quoteIs0 ?? false; // quote sorted as currency0: user bid/ask maps to inverted pool side
  const bidBins = spec.bidBins ?? 0;
  const askBins = spec.askBins ?? 0;
  const amountQuote = spec.amountQuote ?? 0n;
  const amountBase = spec.amountBase ?? 0n;

  const activeBucket = bucketOf(spec.activeTick, spec.spacing);
  const tickLower = activeBucket * spec.spacing;
  const tickUpper = (activeBucket + 1) * spec.spacing;
  const sqrtA = getSqrtPriceAtTick(tickLower);
  const sqrtB = getSqrtPriceAtTick(tickUpper);
  const sqrtP = spec.sqrtPriceX96;
  const doFill =
    (spec.fillActive ?? true) && sqrtP !== undefined && sqrtP > sqrtA && sqrtP < sqrtB && bidBins > 0 && askBins > 0;

  const side = (s: Side, bins: number, totalAmount: bigint): PlannedBin[] =>
    bins > 0
      ? computePosition({
          side: flip ? (s === "bid" ? "ask" : "bid") : s,
          spacing: spec.spacing,
          activeTick: spec.activeTick,
          bins,
          widthMultiples: spec.widthMultiples ?? 1,
          weights,
          ...(spec.growth !== undefined ? { growth: spec.growth } : {}),
          totalAmount,
          startOffset: spec.startOffset ?? 0,
        }).map((r) => ({ ...r, side: s }))
      : [];

  // The active bucket straddles spot, so one bin holds BOTH tokens: currency1 backs
  // [sqrtA, sqrtP], currency0 backs [sqrtP, sqrtB]. Size it to sit FLUSH with its
  // neighbours — its liquidity matches the innermost wing bin (min of the two sides so it
  // can't overrun either budget), and its token split follows the live price. Reserve
  // budget for it up front (at the full-budget innermost L, an upper bound), size the
  // wings on what's left, then pin its liquidity to the FINAL innermost so it lines up
  // exactly (a Spot is then flat straight across spot).
  let reservedQuote = 0n;
  let reservedBase = 0n;
  if (doFill && sqrtP !== undefined) {
    const tb = side("bid", bidBins, amountQuote);
    const ta = side("ask", askBins, amountBase);
    const reserveL = min(tb[0]?.liquidity ?? 0n, ta[0]?.liquidity ?? 0n);
    if (reserveL > 0n) {
      const amt = amountsForLiquidity(sqrtP, tickLower, tickUpper, reserveL);
      reservedQuote = flip ? amt.amount0 : amt.amount1;
      reservedBase = flip ? amt.amount1 : amt.amount0;
    }
  }

  const bids = side("bid", bidBins, amountQuote - reservedQuote);
  const asks = side("ask", askBins, amountBase - reservedBase);

  const active: PlannedBin[] = [];
  if (doFill && sqrtP !== undefined && bids.length > 0 && asks.length > 0) {
    const L = min(bids[0]!.liquidity, asks[0]!.liquidity); // flush with the shorter neighbour
    if (L > 0n) {
      const amt = amountsForLiquidity(sqrtP, tickLower, tickUpper, L);
      active.push({ tickLower, tickUpper, weight: 0, amount: flip ? amt.amount0 : amt.amount1, liquidity: L, side: "active" });
    }
  }

  return { bids, asks, active };
}

const min = (a: bigint, b: bigint): bigint => (a < b ? a : b);

/** Mark a position to market at the current pool price: sums per-bin token amounts. */
export function valuePosition(
  binList: ReadonlyArray<Pick<PlannedBin, "tickLower" | "tickUpper" | "liquidity">>,
  sqrtP: bigint,
): Amounts {
  let amount0 = 0n;
  let amount1 = 0n;
  for (const r of binList) {
    const a = amountsForLiquidity(sqrtP, r.tickLower, r.tickUpper, r.liquidity);
    amount0 += a.amount0;
    amount1 += a.amount1;
  }
  return { amount0, amount1 };
}
