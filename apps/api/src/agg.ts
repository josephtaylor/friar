// Aggregate 1-minute candles to coarser intervals, bigint-exact. Pure.
export interface CandleRow {
  ts: number;
  open: string;
  high: string;
  low: string;
  close: string;
  vol0: string;
  vol1: string;
  swaps: number;
  // dynamic-fee stats, pips — NULL on v3 pools and rows indexed before the fee columns
  // existed (avg over a window = Σfee_sum / Σfee_n, never fee_sum/swaps)
  fee_sum: number | null;
  fee_n: number | null;
  fee_max: number | null;
}

export function aggregateCandles(rows: ReadonlyArray<CandleRow>, intervalS: number): CandleRow[] {
  if (intervalS <= 60) return [...rows];
  const out = new Map<number, CandleRow & { _h: bigint; _l: bigint; _v0: bigint; _v1: bigint }>();
  for (const r of rows) {
    // rows must be in ascending ts order (the query guarantees it)
    const bucket = Math.floor(r.ts / intervalS) * intervalS;
    const cur = out.get(bucket);
    if (!cur) {
      out.set(bucket, {
        ...r,
        ts: bucket,
        _h: BigInt(r.high),
        _l: BigInt(r.low),
        _v0: BigInt(r.vol0),
        _v1: BigInt(r.vol1),
      });
    } else {
      cur.close = r.close;
      const h = BigInt(r.high);
      const l = BigInt(r.low);
      if (h > cur._h) {
        cur._h = h;
        cur.high = r.high;
      }
      if (l < cur._l) {
        cur._l = l;
        cur.low = r.low;
      }
      cur._v0 += BigInt(r.vol0);
      cur._v1 += BigInt(r.vol1);
      cur.vol0 = cur._v0.toString();
      cur.vol1 = cur._v1.toString();
      cur.swaps += r.swaps;
      if (r.fee_n != null && r.fee_n > 0) {
        cur.fee_sum = (cur.fee_sum ?? 0) + (r.fee_sum ?? 0);
        cur.fee_n = (cur.fee_n ?? 0) + r.fee_n;
        if (r.fee_max != null && (cur.fee_max == null || r.fee_max > cur.fee_max)) cur.fee_max = r.fee_max;
      }
    }
  }
  return [...out.values()]
    .sort((a, b) => a.ts - b.ts)
    .map(({ _h, _l, _v0, _v1, ...rest }) => rest);
}
