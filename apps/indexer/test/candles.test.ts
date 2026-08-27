import { test, expect } from "vitest";
import { getSqrtPriceAtTick, price1e18 } from "@friar/core";
import { foldCandles } from "../src/candles.js";
import type { DecodedSwap } from "../src/decode.js";

const POOL = "0xabc" as const;

function swap(ts: number, tick: number, amount0: bigint, amount1: bigint, fee: number | null = 5000): DecodedSwap {
  return { poolId: POOL, block: 1n, ts, amount0, amount1, sqrtPriceX96: getSqrtPriceAtTick(tick), tick, fee };
}

test("foldCandles: single bucket OHLC + volumes", () => {
  const swaps = [
    swap(60, 0, -100n, 90n), // open at tick 0
    swap(70, 500, -50n, 45n), // high
    swap(80, -300, 200n, -180n), // low
    swap(110, 100, -10n, 9n), // close
  ];
  const candles = foldCandles(swaps);
  expect(candles.length).toBe(1);
  const c = candles[0]!;
  expect(c.ts).toBe(60);
  expect(c.open).toBe(price1e18(getSqrtPriceAtTick(0)));
  expect(c.high).toBe(price1e18(getSqrtPriceAtTick(500)));
  expect(c.low).toBe(price1e18(getSqrtPriceAtTick(-300)));
  expect(c.close).toBe(price1e18(getSqrtPriceAtTick(100)));
  expect(c.vol0).toBe(360n); // |−100|+|−50|+|200|+|−10|
  expect(c.vol1).toBe(324n);
  expect(c.swaps).toBe(4);
});

test("foldCandles: bucket boundaries split at the minute", () => {
  const candles = foldCandles([swap(59, 0, 1n, -1n), swap(60, 10, 1n, -1n), swap(119, 20, 1n, -1n), swap(120, 30, 1n, -1n)]);
  expect(candles.map((c) => c.ts)).toEqual([0, 60, 120]);
  expect(candles[1]!.swaps).toBe(2);
  expect(candles[1]!.open).toBe(price1e18(getSqrtPriceAtTick(10)));
  expect(candles[1]!.close).toBe(price1e18(getSqrtPriceAtTick(20)));
});

test("foldCandles: multiple pools stay separate", () => {
  const a = swap(0, 0, 1n, -1n);
  const b = { ...swap(0, 100, 1n, -1n), poolId: "0xdef" as const };
  const candles = foldCandles([a, b]);
  expect(candles.length).toBe(2);
  expect(new Set(candles.map((c) => c.poolId)).size).toBe(2);
});

test("foldCandles: fee stats track v4 fees and ignore v3 nulls", () => {
  const c = foldCandles([
    swap(0, 0, 1n, -1n, 5000), // calm
    swap(10, 0, 1n, -1n, 21000), // surge
    swap(20, 0, 1n, -1n, null), // v3 swap — no per-swap fee
  ])[0]!;
  expect(c.swaps).toBe(3);
  expect(c.feeSum).toBe(26000);
  expect(c.feeN).toBe(2); // only fee-bearing swaps count toward the average
  expect(c.feeMax).toBe(21000);
});

test("foldCandles: all-v3 bucket has no fee stats", () => {
  const c = foldCandles([swap(0, 0, 1n, -1n, null), swap(10, 0, 1n, -1n, null)])[0]!;
  expect(c.feeSum).toBe(0);
  expect(c.feeN).toBe(0);
  expect(c.feeMax).toBeNull();
});
