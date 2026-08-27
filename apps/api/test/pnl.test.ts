import { test, expect } from "vitest";
import { getSqrtPriceAtTick, price1e18 } from "@friar/core";
import { summarizePosition, type PositionRow, type SnapshotRow } from "../src/pnl.js";
import { aggregateCandles, type CandleRow } from "../src/agg.js";

const baseRow: PositionRow = {
  position_id: 1,
  owner: "0xabc",
  pool_id: "0xpool",
  opened_ts: 1000,
  closed_ts: null,
  open_delta0: "0",
  open_delta1: "0",
  flow0: "0",
  flow1: "0",
  fees0: "0",
  fees1: "0",
  perf0: "0",
  perf1: "0",
};

const snapAt = (tick: number, over: Partial<SnapshotRow> = {}): SnapshotRow => ({
  ts: 2000,
  sqrt_price: getSqrtPriceAtTick(tick).toString(),
  market_sqrt_price: null,
  amount0: "0",
  amount1: "0",
  fees0: "0",
  fees1: "0",
  ...over,
});

test("pnl: open then unchanged = ~zero pnl", () => {
  // paid 10 quote in, holdings still worth 10 quote at tick 0 (price 1e18 = 1:1)
  const row = { ...baseRow, open_delta1: (-(10n * 10n ** 18n)).toString() };
  const snap = snapAt(0, { amount1: (10n * 10n ** 18n).toString() });
  const s = summarizePosition(row, snap, false);
  expect(s.pnlQuote).toBe("0");
  expect(s.feesNetQuote).toBe("0");
  expect(s.inventoryQuote).toBe("0");
});

test("pnl: fees net of perf fee decompose correctly", () => {
  // paid 10 in; holdings now 9 quote + unclaimed 0.5 quote fees; collected 1 quote fees
  // (received as flow) with 0.1 charged. price 1:1.
  const E = 10n ** 18n;
  const row = {
    ...baseRow,
    open_delta1: (-10n * E).toString(),
    flow1: ((9n * E) / 10n).toString(), // received 0.9 (fees minus perf fee)
    fees1: (1n * E).toString(), // gross collected
    perf1: (E / 10n).toString(),
  };
  const snap = snapAt(0, { amount1: (9n * E).toString(), fees1: (E / 2n).toString() });
  const s = summarizePosition(row, snap, false);
  // value = 9.5, cashflow = -10 + 0.9 = -9.1 -> pnl = 0.4
  expect(s.pnlQuote).toBe(((4n * E) / 10n).toString());
  // feesNet = gross 1.0 + unclaimed 0.5 - perf fee 0.1 = 1.4
  expect(s.feesNetQuote).toBe(((14n * E) / 10n).toString());
  // inventory = pnl - feesNet = -1.0 (the position bled principal)
  expect(s.inventoryQuote).toBe((-1n * E).toString());
  expect(s.perfFeeQuote).toBe((E / 10n).toString());
});

test("pnl: closed position values token-side fees, not quote-only", () => {
  // A closed position that earned fees on the TOKEN side (currency0) only. Quote = currency1.
  // The bug: passing snap=null gave px=0, and val() dropped the token leg -> "fees banked"
  // read ~half. The fix feeds a zero-holdings snapshot that still carries a price.
  const E = 10n ** 18n;
  const row = { ...baseRow, closed_ts: 3000, fees0: (3n * E).toString(), fees1: "0" };
  const closedSnap = snapAt(0, { amount0: "0", amount1: "0", fees0: "0", fees1: "0" }); // price 1:1, no holdings
  const s = summarizePosition(row, closedSnap, false);
  expect(s.feesNetQuote).toBe((3n * E).toString()); // token-side fee valued, not dropped
  expect(s.valueQuote).toBe("0"); // closed = nothing held on-chain

  // regression guard: the old snap=null path silently drops the token-side fee to zero
  expect(summarizePosition(row, null, false).feesNetQuote).toBe("0");
});

test("pnl: token0 holdings valued at snapshot price", () => {
  // 1 token0 held, price at tick 6932 ≈ 2.0 quote per token
  const snap = snapAt(6932, { amount0: (10n ** 18n).toString() });
  const s = summarizePosition(baseRow, snap, false);
  const px = price1e18(getSqrtPriceAtTick(6932));
  expect(s.valueQuote).toBe(px.toString()); // 1 token0 * px
  expect(BigInt(s.valueQuote) > (19n * 10n ** 17n)).toBe(true); // ~2.0
});

test("aggregateCandles: 5m from 1m, exact OHLC and volume", () => {
  const c = (ts: number, o: string, h: string, l: string, cl: string): CandleRow => ({
    ts,
    open: o,
    high: h,
    low: l,
    close: cl,
    vol0: "10",
    vol1: "20",
    swaps: 1,
  });
  const rows = [
    c(0, "100", "150", "90", "110"),
    c(60, "110", "200", "100", "180"),
    c(240, "180", "190", "60", "70"),
    c(300, "70", "80", "65", "75"), // next bucket
  ];
  const agg = aggregateCandles(rows, 300);
  expect(agg.length).toBe(2);
  expect(agg[0]).toMatchObject({ ts: 0, open: "100", high: "200", low: "60", close: "70", vol0: "30", vol1: "60", swaps: 3 });
  expect(agg[1]).toMatchObject({ ts: 300, open: "70", high: "80", low: "65", close: "75", swaps: 1 });
});

test("aggregateCandles: interval 60 passes through", () => {
  const rows: CandleRow[] = [
    { ts: 0, open: "1", high: "1", low: "1", close: "1", vol0: "1", vol1: "1", swaps: 1 },
  ];
  expect(aggregateCandles(rows, 60)).toEqual(rows);
});

// ---- a pool pinned at a swap limit is not a price (FLAMINGO #284, 2026-08-10) ----
//
// Real values off chain 4663. The FLAMINGO/WETH pool read slot0 = MAX_SQRT_PRICE-1, so
// price1e18 squared it to 3.4e38 token1 per token0 and the position's 6,930 unclaimed
// FLAMINGO of fees valued at 2.24e42 WETH. One row out of 244 closes, summed into the
// History tiles, rendered realized PnL / fees banked / per-deploy-30d as 1e42 garbage.
const FLAMINGO_284: PositionRow = {
  ...baseRow,
  position_id: 284,
  fees0: "6930095492451419954905", // 6,930 FLAMINGO
  fees1: "3761631214245518", // 0.00376 WETH
  perf0: "346504774622570997745",
  perf1: "188081560712275",
};
const PINNED_MAX = "1461446703485210103287273052203988822378723970341";

test("pnl: fees at a pinned MAX_SQRT pool value the quote leg only, not 1e42", () => {
  const snap: SnapshotRow = { ...snapAt(0), sqrt_price: PINNED_MAX, market_sqrt_price: null };
  const s = summarizePosition(FLAMINGO_284, snap, false); // WETH is currency1

  // quote leg only: fees1 - perf1, the token leg dropped as unpriceable
  expect(s.feesNetQuote).toBe("3573549653533243");
  expect(s.priceUsed).toBe("0");
  // the number the app actually rendered, which must never come back
  expect(BigInt(s.feesNetQuote) < 10n ** 21n).toBe(true);
});

test("pnl: a pinned MIN_SQRT pool is refused the same way", () => {
  const snap: SnapshotRow = { ...snapAt(0), sqrt_price: "4295128739", market_sqrt_price: null };
  expect(summarizePosition(FLAMINGO_284, snap, false).priceUsed).toBe("0");
});

test("pnl: a real market price on the same row still values both legs", () => {
  // ref venue answers, so market_sqrt_price wins over the pinned pool tick
  const snap: SnapshotRow = { ...snapAt(0), sqrt_price: PINNED_MAX, market_sqrt_price: getSqrtPriceAtTick(0).toString() };
  const s = summarizePosition(FLAMINGO_284, snap, false);
  expect(s.priceUsed).toBe(price1e18(getSqrtPriceAtTick(0)).toString());
  // both legs present: 6930 FLAMINGO at 1:1 dwarfs the 0.0038 WETH leg
  expect(BigInt(s.feesNetQuote) > 6000n * 10n ** 18n).toBe(true);
});

test("pnl: an ordinary price is untouched by the guard", () => {
  const snap: SnapshotRow = { ...snapAt(-60000), market_sqrt_price: null };
  expect(BigInt(summarizePosition(FLAMINGO_284, snap, false).priceUsed) > 0n).toBe(true);
});
