import { test, expect } from "vitest";
import {
  unclaimedFees,
  markPosition,
  decompose,
  price1e18,
  markPrice1e18,
  MIN_SQRT_PRICE,
  MAX_SQRT_PRICE,
  positionStatus,
  positionBar,
} from "../src/accounting.js";
import { computePosition } from "../src/position.js";
import { getSqrtPriceAtTick } from "../src/tickmath.js";

const Q128 = 1n << 128n;

test("unclaimedFees: growth delta times liquidity", () => {
  const L = 10n ** 18n;
  const last = { feeGrowthInside0LastX128: 5n * Q128, feeGrowthInside1LastX128: 0n };
  const now = { feeGrowthInside0X128: 7n * Q128, feeGrowthInside1X128: 3n * Q128 };
  const { fees0, fees1 } = unclaimedFees(L, now, last);
  expect(fees0).toBe(2n * 10n ** 18n);
  expect(fees1).toBe(3n * 10n ** 18n);
});

test("unclaimedFees: handles 2^256 wraparound like core", () => {
  const L = 1n;
  const last = { feeGrowthInside0LastX128: (1n << 256n) - Q128, feeGrowthInside1LastX128: 0n };
  const now = { feeGrowthInside0X128: Q128, feeGrowthInside1X128: 0n };
  const { fees0 } = unclaimedFees(L, now, last);
  expect(fees0).toBe(2n); // wrapped delta = 2 * Q128 -> 2 wei per unit L
});

test("decompose: unfilled position at open = zero fees, ~zero inventory delta", () => {
  const total = 10n ** 19n;
  const bins = computePosition({
    side: "bid",
    spacing: 100,
    activeTick: 5,
    bins: 20,
    widthMultiples: 1,
    weights: "linear",
    totalAmount: total,
  }).map((r) => ({ ...r, fees0: 0n, fees1: 0n }));
  const sqrtP = getSqrtPriceAtTick(5);
  const mark = markPosition(bins, sqrtP);
  const d = decompose(mark, sqrtP, total);
  expect(d.feesQuote).toBe(0n);
  expect(d.inventoryDelta <= 0n && -d.inventoryDelta < 10n ** 8n, `dust ${d.inventoryDelta}`).toBe(true);
});

test("decompose: dump halfway = negative inventory delta, fees offset", () => {
  const total = 10n ** 19n;
  const bins = computePosition({
    side: "bid",
    spacing: 100,
    activeTick: 5,
    bins: 20,
    widthMultiples: 1,
    weights: "linear",
    totalAmount: total,
  }).map((r) => ({ ...r, fees0: 0n, fees1: 10n ** 15n })); // pretend 0.001 quote fees per bin
  const sqrtDump = getSqrtPriceAtTick(-1000);
  const mark = markPosition(bins, sqrtDump);
  const d = decompose(mark, sqrtDump, total);
  expect(d.inventoryDelta < 0n, "bought into a falling market = paper loss").toBe(true);
  expect(d.feesQuote).toBe(20n * 10n ** 15n);
  expect(d.pnl).toBe(d.feesQuote + d.inventoryDelta);
});

test("price1e18 at tick 0 is 1e18", () => {
  expect(price1e18(getSqrtPriceAtTick(0))).toBe(10n ** 18n);
});

test("positionStatus: bid position lifecycle — waiting, partial fill, blown through", () => {
  const bins = computePosition({
    side: "bid",
    spacing: 100,
    activeTick: 5,
    bins: 10,
    widthMultiples: 1,
    weights: "linear",
    totalAmount: 10n ** 18n,
  }).map((r) => ({ ...r, side: "bid" as const }));

  // price above the whole position: everything waiting
  let s = positionStatus(bins, 50);
  expect(s.location).toBe("above");
  expect(s.counts.waiting).toBe(10);
  expect(s.pctFromBottom).toBe(100);

  // price 4.5 bins deep: bins span 0..-1000; tick -450 is inside bin [-500,-400]
  s = positionStatus(bins, -450);
  expect(s.location).toBe("in-range");
  expect(s.counts.active).toBe(1);
  expect(s.counts.filled).toBe(4); // bins above -400: price fell through them, bought
  expect(s.counts.waiting).toBe(5); // bins at/below -500: still quote, still waiting
  expect(s.pctFromBottom).toBe(55);
  expect(positionBar(s.states)).toBe("░░░░░▓████"); // chart order: deep waiting bids → active → bought

  // dumped through everything
  s = positionStatus(bins, -2000);
  expect(s.location).toBe("below");
  expect(s.counts.filled).toBe(10);
  expect(positionBar(s.states)).toBe("██████████");
});

test("positionStatus: ask side mapping inverts", () => {
  const asks = computePosition({
    side: "ask",
    spacing: 100,
    activeTick: -5,
    bins: 5,
    widthMultiples: 1,
    weights: "flat",
    totalAmount: 10n ** 18n,
  }).map((r) => ({ ...r, side: "ask" as const }));
  // price below all asks: waiting; price above all: filled (sold out)
  expect(positionStatus(asks, -50).counts.waiting).toBe(5);
  expect(positionStatus(asks, 10_000).counts.filled).toBe(5);
});

// ---- markPrice1e18: the limits are boundaries, not quotes ----
test("markPrice1e18 refuses a pool pinned at a swap limit", () => {
  expect(markPrice1e18(MAX_SQRT_PRICE - 1n)).toBe(0n);
  expect(markPrice1e18(MIN_SQRT_PRICE + 1n)).toBe(0n);
  // price1e18 itself is unchanged: it is tick math and still answers
  expect(price1e18(MAX_SQRT_PRICE - 1n) > 0n).toBe(true);
});

test("markPrice1e18 agrees with price1e18 everywhere in normal range", () => {
  for (const tick of [-200000, -60000, -887, 0, 887, 60000, 200000]) {
    const sqrt = getSqrtPriceAtTick(tick);
    expect(markPrice1e18(sqrt)).toBe(price1e18(sqrt));
  }
});
