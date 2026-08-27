// Fold decoded swaps into per-minute OHLC candles. Pure — unit-testable.
import { price1e18 } from "@friar/core";
import type { DecodedSwap } from "./decode.js";

export const CANDLE_INTERVAL_S = 60;

export interface CandleAgg {
  poolId: string;
  ts: number; // bucket start, epoch seconds
  open: bigint;
  high: bigint;
  low: bigint;
  close: bigint;
  vol0: bigint;
  vol1: bigint;
  swaps: number;
  // Dynamic-fee tracking (v4 swaps carry the fee; v3 don't). feeN counts the swaps that
  // actually contributed to feeSum, so avg = feeSum/feeN stays exact even when a bucket
  // merges with a pre-migration row whose fee columns are NULL.
  feeSum: number;
  feeN: number;
  feeMax: number | null;
}

const abs = (x: bigint): bigint => (x < 0n ? -x : x);

/**
 * Fold swaps (chronological) into candle aggregates keyed by pool+minute.
 * Merging into existing D1 rows: open keeps the stored value (earlier), close takes
 * the incoming one (later), high/low are max/min, volumes and counts add — polls
 * process blocks in order, so "stored is earlier, incoming is later" always holds.
 */
export function foldCandles(swaps: ReadonlyArray<DecodedSwap>, intervalS = CANDLE_INTERVAL_S): CandleAgg[] {
  const buckets = new Map<string, CandleAgg>();
  for (const s of swaps) {
    const ts = Math.floor(s.ts / intervalS) * intervalS;
    const key = `${s.poolId}:${ts}`;
    const px = price1e18(s.sqrtPriceX96);
    const existing = buckets.get(key);
    if (!existing) {
      buckets.set(key, {
        poolId: s.poolId,
        ts,
        open: px,
        high: px,
        low: px,
        close: px,
        vol0: abs(s.amount0),
        vol1: abs(s.amount1),
        swaps: 1,
        feeSum: s.fee ?? 0,
        feeN: s.fee != null ? 1 : 0,
        feeMax: s.fee,
      });
    } else {
      existing.close = px;
      if (px > existing.high) existing.high = px;
      if (px < existing.low) existing.low = px;
      existing.vol0 += abs(s.amount0);
      existing.vol1 += abs(s.amount1);
      existing.swaps += 1;
      if (s.fee != null) {
        existing.feeSum += s.fee;
        existing.feeN += 1;
        if (existing.feeMax === null || s.fee > existing.feeMax) existing.feeMax = s.fee;
      }
    }
  }
  return [...buckets.values()].sort((a, b) => a.ts - b.ts);
}
