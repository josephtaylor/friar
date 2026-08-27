import { test, expect } from "vitest";
import { aggregateCandles, type CandleRow } from "../src/agg.js";

function row(ts: number, overrides: Partial<CandleRow> = {}): CandleRow {
  return {
    ts,
    open: "100",
    high: "110",
    low: "90",
    close: "105",
    vol0: "10",
    vol1: "10",
    swaps: 1,
    fee_sum: null,
    fee_n: null,
    fee_max: null,
    ...overrides,
  };
}

test("aggregateCandles: fee stats merge across minute rows", () => {
  const out = aggregateCandles(
    [
      row(0, { fee_sum: 5000, fee_n: 1, fee_max: 5000 }),
      row(60, { fee_sum: 40000, fee_n: 2, fee_max: 30000 }),
      row(120), // pre-migration row — NULL fee columns must not poison the window
    ],
    300,
  );
  expect(out.length).toBe(1);
  const c = out[0]!;
  expect(c.fee_sum).toBe(45000);
  expect(c.fee_n).toBe(3); // avg = 45000/3 = 15000 pips = 1.5%
  expect(c.fee_max).toBe(30000);
  expect(c.swaps).toBe(3);
});

test("aggregateCandles: all-null fee window stays null", () => {
  const out = aggregateCandles([row(0), row(60)], 300);
  expect(out[0]!.fee_sum).toBeNull();
  expect(out[0]!.fee_n).toBeNull();
  expect(out[0]!.fee_max).toBeNull();
});

test("aggregateCandles: interval <= 60 passes rows through untouched", () => {
  const rows = [row(0, { fee_sum: 7000, fee_n: 1, fee_max: 7000 })];
  expect(aggregateCandles(rows, 60)).toEqual(rows);
});
