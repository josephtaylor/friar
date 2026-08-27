import { test, expect } from "vitest";
import { getSqrtPriceAtTick } from "../src/tickmath.js";
import { liquidityForAmount1, amountsForLiquidity } from "../src/liquidity.js";
import { computePosition, computeShape, valuePosition, bucketOf } from "../src/position.js";

test("tickmath: known anchors", () => {
  expect(getSqrtPriceAtTick(0)).toBe(79228162514264337593543950336n); // exactly 2^96
  // MIN/MAX from TickMath.sol constants
  expect(getSqrtPriceAtTick(-887272)).toBe(4295128739n);
  expect(getSqrtPriceAtTick(887272)).toBe(1461446703485210103287273052203988822378723970342n);
  // monotonic around zero, ~1.0001 per tick
  expect(getSqrtPriceAtTick(100) > 79228162514264337593543950336n).toBe(true);
  expect(getSqrtPriceAtTick(-100) < 79228162514264337593543950336n).toBe(true);
});

test("liquidity roundtrip: amount1 -> L -> amounts for below-spot bin", () => {
  const lower = -200;
  const upper = -100;
  const amount1 = 10n ** 18n;
  const L = liquidityForAmount1(getSqrtPriceAtTick(lower), getSqrtPriceAtTick(upper), amount1);
  // Price above the range: position should be ~all token1, within rounding dust
  const { amount0, amount1: got } = amountsForLiquidity(getSqrtPriceAtTick(0), lower, upper, L);
  expect(amount0).toBe(0n);
  const dust = amount1 - got;
  expect(dust >= 0n && dust < 10n ** 6n, `dust ${dust}`).toBe(true);
});

test("bucketOf floors toward -inf", () => {
  expect(bucketOf(-1, 100)).toBe(-1);
  expect(bucketOf(-100, 100)).toBe(-1);
  expect(bucketOf(-101, 100)).toBe(-2);
  expect(bucketOf(99, 100)).toBe(0);
});

test("bid position: contiguous descending bins, linear weights, budget conserved", () => {
  const total = 10n ** 19n;
  const bins = computePosition({
    side: "bid",
    spacing: 100,
    activeTick: 5,
    bins: 20,
    widthMultiples: 1,
    weights: "linear",
    totalAmount: total,
  });
  expect(bins.length).toBe(20);
  // first bin's top edge = active bucket's lower edge (waiting below spot)
  expect(bins[0]!.tickUpper).toBe(0);
  for (let i = 0; i < 20; i++) {
    expect(bins[i]!.tickUpper - bins[i]!.tickLower).toBe(100);
    if (i > 0) expect(bins[i]!.tickUpper).toBe(bins[i - 1]!.tickLower); // side by side
    if (i > 0) expect(bins[i]!.amount > bins[i - 1]!.amount).toBe(true); // heavier as it goes down
    expect(bins[i]!.liquidity > 0n).toBe(true);
  }
  const spent = bins.reduce((a, r) => a + r.amount, 0n);
  expect(total - spent >= 0n && total - spent < 100n, `unallocated ${total - spent}`).toBe(true);
});

test("valuePosition: below-spot bid position marks to ~all quote at open", () => {
  const total = 10n ** 19n;
  const bins = computePosition({
    side: "bid",
    spacing: 100,
    activeTick: 5,
    bins: 20,
    widthMultiples: 1,
    weights: "linear",
    totalAmount: total,
  });
  const { amount0, amount1 } = valuePosition(bins, getSqrtPriceAtTick(5));
  expect(amount0).toBe(0n); // nothing filled yet
  const dust = total - amount1;
  expect(dust >= 0n && dust < 10n ** 7n, `dust ${dust}`).toBe(true);
});

test("valuePosition: after a dump through half the position, holds mixed inventory", () => {
  const total = 10n ** 19n;
  const bins = computePosition({
    side: "bid",
    spacing: 100,
    activeTick: 5,
    bins: 20,
    widthMultiples: 1,
    weights: "linear",
    totalAmount: total,
  });
  // price fell to tick -1000 (10 bins deep)
  const { amount0, amount1 } = valuePosition(bins, getSqrtPriceAtTick(-1000));
  expect(amount0 > 0n, "should hold bought token").toBe(true);
  expect(amount1 > 0n, "deeper bins still quote").toBe(true);
  const { amount1: allQuote } = valuePosition(bins, getSqrtPriceAtTick(5));
  expect(amount1 < allQuote, "some quote converted").toBe(true);
});

test("coarser deep bins via widthMultiples array", () => {
  const bins = computePosition({
    side: "bid",
    spacing: 100,
    activeTick: 0,
    bins: 4,
    widthMultiples: [1, 1, 2, 3],
    weights: "flat",
    totalAmount: 10n ** 18n,
  });
  expect(bins[2]!.tickUpper - bins[2]!.tickLower).toBe(200);
  expect(bins[3]!.tickUpper - bins[3]!.tickLower).toBe(300);
  expect(bins[3]!.tickLower).toBe(-700); // 100+100+200+300 below spot edge
});

test("computeShape: two-sided bidask — quote bids below, token asks above, heavy at edges", () => {
  const { bids, asks } = computeShape({
    shape: "bidask",
    spacing: 100,
    activeTick: 50,
    bidBins: 10,
    askBins: 10,
    amountQuote: 10n ** 19n,
    amountBase: 5n * 10n ** 21n,
  });
  expect(bids.length).toBe(10);
  expect(asks.length).toBe(10);
  expect(bids[0]!.tickUpper).toBe(0); // bids start at active bucket's floor
  expect(asks[0]!.tickLower).toBe(100); // asks start at active bucket's ceiling
  expect(bids[9]!.amount > bids[0]!.amount, "bid weight grows away from spot").toBe(true);
  expect(asks[9]!.amount > asks[0]!.amount, "ask weight grows away from spot").toBe(true);
  for (const r of asks) expect(r.liquidity > 0n).toBe(true);
});

test("computeShape: sqrtPriceX96 fills the active bucket with a continuous mixed bin", () => {
  const amountQuote = 10n ** 19n;
  const amountBase = 5n * 10n ** 21n;
  const sqrtPriceX96 = getSqrtPriceAtTick(50); // live price inside the [0,100] active bucket
  const { bids, asks, active } = computeShape({
    shape: "bidask",
    spacing: 100,
    activeTick: 50,
    sqrtPriceX96,
    bidBins: 10,
    askBins: 10,
    amountQuote,
    amountBase,
  });
  // one mixed bin, spanning exactly the active bucket, bridging the two legs with no gap
  expect(active.length).toBe(1);
  expect(active[0]!.tickLower).toBe(0);
  expect(active[0]!.tickUpper).toBe(100);
  expect(active[0]!.side).toBe("active");
  expect(bids[0]!.tickUpper).toBe(active[0]!.tickLower); // bid leg meets the active bin
  expect(asks[0]!.tickLower).toBe(active[0]!.tickUpper); // active bin meets the ask leg
  // the active bin genuinely holds BOTH tokens at the live price
  const amt = amountsForLiquidity(sqrtPriceX96, 0, 100, active[0]!.liquidity);
  expect(amt.amount0 > 0n).toBe(true);
  expect(amt.amount1 > 0n).toBe(true);
  // budget-neutral: quote (currency1) and base (currency0) each stay within their budget
  const quoteUsed = bids.reduce((s, r) => s + amountsForLiquidity(sqrtPriceX96, r.tickLower, r.tickUpper, r.liquidity).amount1, 0n) + amt.amount1;
  const baseUsed = asks.reduce((s, r) => s + amountsForLiquidity(sqrtPriceX96, r.tickLower, r.tickUpper, r.liquidity).amount0, 0n) + amt.amount0;
  expect(quoteUsed <= amountQuote).toBe(true);
  expect(baseUsed <= amountBase).toBe(true);
});

test("computeShape: no sqrtPriceX96 leaves the active bucket empty (legacy)", () => {
  const { bids, asks, active } = computeShape({
    shape: "bidask",
    spacing: 100,
    activeTick: 50,
    bidBins: 10,
    askBins: 10,
    amountQuote: 10n ** 19n,
    amountBase: 5n * 10n ** 21n,
  });
  expect(active.length).toBe(0);
  expect(bids[0]!.tickUpper).toBe(0);
  expect(asks[0]!.tickLower).toBe(100); // the 100-tick active bucket stays a gap
});

test("computeShape: curve concentrates near active; spot is flat", () => {
  const curve = computeShape({
    shape: "curve",
    spacing: 100,
    activeTick: 0,
    bidBins: 5,
    askBins: 0,
    amountQuote: 10n ** 18n,
  });
  expect(curve.bids[0]!.amount > curve.bids[4]!.amount, "curve heaviest near spot").toBe(true);
  const spot = computeShape({
    shape: "spot",
    spacing: 100,
    activeTick: 0,
    bidBins: 5,
    askBins: 0,
    amountQuote: 10n ** 18n,
  });
  // Meteora semantics: a Spot is uniform LIQUIDITY per bin (not uniform value).
  const Ls = spot.bids.map((r) => r.liquidity);
  expect(Ls.every((l) => l === Ls[0])).toBe(true);
});

test("computeShape: active bin sits flush with its neighbours (Spot flat across spot)", () => {
  const s = computeShape({
    shape: "spot",
    spacing: 100,
    activeTick: 50, // spot mid-bucket → active bin straddles price
    bidBins: 6,
    askBins: 6,
    amountQuote: 10n ** 18n,
    amountBase: 10n ** 18n,
    sqrtPriceX96: getSqrtPriceAtTick(50),
  });
  expect(s.active.length).toBe(1);
  const a = s.active[0]!;
  // liquidity matches the innermost wings (flush), not short/tall
  expect(a.liquidity).toBe(s.bids[0]!.liquidity < s.asks[0]!.liquidity ? s.bids[0]!.liquidity : s.asks[0]!.liquidity);
  // and it genuinely straddles: holds BOTH tokens at the live price
  const { amount0, amount1 } = amountsForLiquidity(getSqrtPriceAtTick(50), a.tickLower, a.tickUpper, a.liquidity);
  expect(amount0 > 0n && amount1 > 0n).toBe(true);
});

test("computeShape: one-sided ask-only above active works", () => {
  const { bids, asks } = computeShape({
    shape: "spot",
    spacing: 100,
    activeTick: -70,
    bidBins: 0,
    askBins: 8,
    amountBase: 10n ** 20n,
  });
  expect(bids.length).toBe(0);
  expect(asks.length).toBe(8);
  for (let i = 1; i < 8; i++) expect(asks[i]!.tickLower).toBe(asks[i - 1]!.tickUpper);
});

test("orientation: quoteIs0 flips user bids to above-active pool ranges", () => {
  const { bids } = computeShape({
    shape: "bidask",
    spacing: 100,
    activeTick: 50,
    quoteIs0: true,
    bidBins: 5,
    askBins: 0,
    amountQuote: 10n ** 18n,
  });
  // user "bid" (buy token with quote) when quote=currency0 lives ABOVE the active tick
  expect(bids[0]!.tickLower).toBe(100);
  for (const r of bids) expect(r.tickLower >= 100).toBe(true);
  expect(bids[0]!.side).toBe("bid"); // user semantics preserved
});

test("orientation: positionStatus maps waiting/filled correctly when quoteIs0", async () => {
  const { positionStatus } = await import("../src/accounting.js");
  const { bids } = computeShape({
    shape: "spot",
    spacing: 100,
    activeTick: 50,
    quoteIs0: true,
    bidBins: 5,
    askBins: 0,
    amountQuote: 10n ** 18n,
  });
  // price below all bins: bids all still quote (currency0) = waiting
  expect(positionStatus(bids, 50, true).counts.waiting).toBe(5);
  // price pumped through all bins (tick above): all converted to token = filled
  expect(positionStatus(bids, 10_000, true).counts.filled).toBe(5);
});
