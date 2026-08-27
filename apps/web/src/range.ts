// Range verdicts — shared by cards, detail, and the LIVE strip. Judged against the
// MARKET price, never the pool's own tick: a breached pool's tick pins at the range
// edge and lies (the CASHCAT lesson that cost real money once).
import { getSqrtPriceAtTick, getTickAtSqrtPrice } from "@friar/core";
import type { ApiPositionDetail } from "./api.js";
import { splitPair } from "./tokens.js";

export interface RangeInfo {
  span: { min: number; max: number } | null;
  poolTick: number | null;
  marketTick: number | null;
  judgeTick: number | null;
  pinned: boolean;
  quoteIs0: boolean;
  status: "in" | "below" | "above" | null;
  down: number | null; // fraction drop to breach down
  up: number | null; // fraction pump to breach up
  rangePct: number | null; // % up the range (user orientation)
}

export function rangeInfo(d: ApiPositionDetail, liveSqrt: bigint | null): RangeInfo {
  const { quoteIs0 } = splitPair(d.currency0, d.currency1);
  const span = d.bins.length
    ? { min: Math.min(...d.bins.map((b) => b.tick_lower)), max: Math.max(...d.bins.map((b) => b.tick_upper)) }
    : null;
  const marketSqrt = d.latestSnapshot?.market_sqrt_price ? BigInt(d.latestSnapshot.market_sqrt_price) : null;
  const poolSqrt = liveSqrt ?? (d.latestSnapshot ? BigInt(d.latestSnapshot.sqrt_price) : null);
  const judgeSqrt = marketSqrt ?? poolSqrt;
  const marketTick = marketSqrt !== null ? getTickAtSqrtPrice(marketSqrt) : null;
  const poolTick = poolSqrt !== null ? getTickAtSqrtPrice(poolSqrt) : null;
  const judgeTick = judgeSqrt !== null ? getTickAtSqrtPrice(judgeSqrt) : null;
  const pinned = marketTick !== null && poolTick !== null && marketTick !== poolTick;

  if (judgeSqrt === null || judgeTick === null || span === null) {
    return { span, poolTick, marketTick, judgeTick, pinned, quoteIs0, status: null, down: null, up: null, rangePct: null };
  }

  // Breach is judged on sqrtPrice against the EXACT edge boundaries, inclusive — a pool
  // whose liquidity is fully consumed pins at precisely sqrtAt(edge), and rounding that
  // through getTickAtSqrtPrice puts it back inside the range's last tick ("in range 100%"
  // while every ask is sold). Ticks are only used for the % displays below.
  const rawBelowMin = judgeSqrt <= getSqrtPriceAtTick(span.min);
  const rawAboveMax = judgeSqrt >= getSqrtPriceAtTick(span.max);
  const above = quoteIs0 ? rawBelowMin : rawAboveMax;
  const below = quoteIs0 ? rawAboveMax : rawBelowMin;
  const status: RangeInfo["status"] = d.closed_ts !== null ? null : above ? "above" : below ? "below" : "in";

  const headroom = !quoteIs0
    ? { down: 1 - Math.pow(1.0001, span.min - judgeTick), up: Math.pow(1.0001, span.max - judgeTick) - 1 }
    : { down: 1 - Math.pow(1.0001, judgeTick - span.max), up: Math.pow(1.0001, judgeTick - span.min) - 1 };

  const rawPct = Math.max(0, Math.min(100, Math.round(((judgeTick - span.min) / (span.max - span.min || 1)) * 100)));
  const rangePct = quoteIs0 ? 100 - rawPct : rawPct;

  return {
    span,
    poolTick,
    marketTick,
    judgeTick,
    pinned,
    quoteIs0,
    status,
    down: Math.max(0, headroom.down),
    up: Math.max(0, headroom.up),
    rangePct,
  };
}

export function statusChip(status: RangeInfo["status"], closed = false): { label: string; cls: string } {
  if (closed) return { label: "CLOSED", cls: "chip-closed" };
  switch (status) {
    case "in":
      return { label: "IN RANGE", cls: "chip-in" };
    case "below":
      return { label: "BELOW RANGE", cls: "chip-below" };
    case "above":
      return { label: "ABOVE RANGE", cls: "chip-above" };
    default:
      return { label: "—", cls: "chip-closed" };
  }
}

/** Compact breach summary for cards. */
export function breachText(r: RangeInfo): string {
  if (r.status === "below") return "price below range — bids all filled";
  if (r.status === "above") return "price above range — asks sold out";
  if (r.down !== null && r.up !== null) return `${(r.down * 100).toFixed(0)}% drop / ${(r.up * 100).toFixed(0)}% pump to breach`;
  return "marking…";
}
