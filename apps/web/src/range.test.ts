// Regression: a fully-breached pool pins its sqrtPrice EXACTLY at the range-edge
// boundary; rounding that through getTickAtSqrtPrice lands back inside the range's
// last tick, which read as "in range 100%" while every ask was sold. rangeInfo must
// judge on sqrtPrice with inclusive edges.
import { describe, it, expect } from "vitest";
import { getSqrtPriceAtTick, getTickAtSqrtPrice } from "@friar/core";
import { ADDRESSES } from "@friar/chain";
import { rangeInfo } from "./range.js";
import type { ApiPositionDetail } from "./api.js";

const WETH = ADDRESSES.weth;
const TOKEN_HIGH = "0xFFfFfFffFFfffFFfFFfFFFFFffFFFffffFfFFFfF"; // > WETH → quoteIs0
const TOKEN_LOW = "0x0000000000000000000000000000000000000001"; // < WETH → !quoteIs0

const MIN = -1000;
const MAX = 1000;

function detail(currency0: string, currency1: string, sqrtPrice: bigint, marketSqrt: bigint | null = null): ApiPositionDetail {
  return {
    position_id: 1,
  manager: null,
    owner: "0x0000000000000000000000000000000000000002",
    pool_id: "0x00",
    opened_ts: 0,
    closed_ts: null,
    currency0,
    currency1,
    fees0: "0",
    fees1: "0",
    perf0: "0",
    perf1: "0",
    summary: {
      valueQuote: "0",
      cashflowQuote: "0",
      pnlQuote: "0",
      feesNetQuote: "0",
      inventoryQuote: "0",
      perfFeeQuote: "0",
      unclaimedFees0: "0",
      unclaimedFees1: "0",
      priceUsed: "0",
      markedAt: null,
    },
    bins: [
      { bin_index: 0, tick_lower: MIN, tick_upper: 0, liquidity: "1000" },
      { bin_index: 1, tick_lower: 0, tick_upper: MAX, liquidity: "1000" },
    ],
    events: [],
    latestSnapshot: {
      ts: 0,
      sqrt_price: sqrtPrice.toString(),
      market_sqrt_price: marketSqrt?.toString() ?? null,
      amount0: "0",
      amount1: "0",
      fees0: "0",
      fees1: "0",
    },
  };
}

describe("rangeInfo breach detection", () => {
  it("quoteIs0: pool pinned exactly at the bottom tick edge = pumped out ABOVE", () => {
    // the sanity of the regression itself: the pinned sqrt rounds back to MIN ("in range" by tick)
    expect(getTickAtSqrtPrice(getSqrtPriceAtTick(MIN))).toBe(MIN);
    const r = rangeInfo(detail(WETH, TOKEN_HIGH, getSqrtPriceAtTick(MIN)), null);
    expect(r.status).toBe("above");
  });

  it("quoteIs0: strictly inside the bottom tick is still IN range", () => {
    const r = rangeInfo(detail(WETH, TOKEN_HIGH, getSqrtPriceAtTick(MIN) + 1n), null);
    expect(r.status).toBe("in");
  });

  it("quoteIs0: pinned at the top tick edge = dumped out BELOW", () => {
    const r = rangeInfo(detail(WETH, TOKEN_HIGH, getSqrtPriceAtTick(MAX)), null);
    expect(r.status).toBe("below");
  });

  it("!quoteIs0: pinned at the top edge = ABOVE, bottom edge = BELOW", () => {
    expect(rangeInfo(detail(TOKEN_LOW, WETH, getSqrtPriceAtTick(MAX)), null).status).toBe("above");
    expect(rangeInfo(detail(TOKEN_LOW, WETH, getSqrtPriceAtTick(MIN)), null).status).toBe("below");
  });

  it("market price overrides a lying in-range pool tick", () => {
    // pool sqrt mid-range, but the true market has run 500 ticks past the bottom edge
    const r = rangeInfo(detail(WETH, TOKEN_HIGH, getSqrtPriceAtTick(0), getSqrtPriceAtTick(MIN - 500)), null);
    expect(r.status).toBe("above");
    expect(r.pinned).toBe(true);
  });

  it("live sqrt (bigint) is judged when there is no market ref", () => {
    const d = detail(WETH, TOKEN_HIGH, getSqrtPriceAtTick(0));
    d.latestSnapshot = null; // no snapshot at all — live slot0 only
    expect(rangeInfo(d, getSqrtPriceAtTick(MIN)).status).toBe("above");
    expect(rangeInfo(d, getSqrtPriceAtTick(0)).status).toBe("in");
  });
});
