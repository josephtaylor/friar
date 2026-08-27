import { test, expect } from "vitest";
import { sqrtPriceX96FromPrice, getTickAtSqrtPrice, getSqrtPriceAtTick } from "../src/index.js";

// Decode a seeded sqrtPriceX96 back to its human quote-per-token price at full float
// precision (NOT via price1e18, whose ×1e18 scaling quantizes extreme raw prices — a
// separate property of that marking primitive, not of the seed). This proves the seed's
// decimal factor + orientation are right, independently of the forward math.
function decodeQuotePerToken(sqrtP: bigint, tokenDecimals: number, quoteDecimals: number, quoteIs0: boolean): number {
  const poolPrice = (Number(sqrtP) / 2 ** 96) ** 2; // currency1_raw per currency0_raw
  const decFactor = 10 ** (tokenDecimals - quoteDecimals);
  return quoteIs0 ? decFactor / poolPrice : poolPrice * decFactor;
}

const CASES: Array<{ name: string; price: number; td: number; qd: number }> = [
  { name: "memecoin / WETH (18/18)", price: 0.00042, td: 18, qd: 18 },
  { name: "memecoin / USDG (18/6)", price: 0.00042, td: 18, qd: 6 },
  { name: "dollar-ish token / USDG (18/6)", price: 1.87, td: 18, qd: 6 },
  { name: "pricey token / USDG (18/6)", price: 2450, td: 18, qd: 6 },
  { name: "6-dec token / USDG (6/6)", price: 3.14, td: 6, qd: 6 },
  { name: "8-dec token / WETH (8/18)", price: 0.017, td: 8, qd: 18 },
];

test("sqrtPriceX96FromPrice: round-trips within 1e-6 across decimals & orientations", () => {
  for (const c of CASES) {
    for (const quoteIs0 of [true, false]) {
      const sqrtP = sqrtPriceX96FromPrice(c.price, c.td, c.qd, quoteIs0);
      // must be a valid v4 sqrt price (uint160, within tick bounds)
      expect(sqrtP > 4295128739n, `${c.name} q0=${quoteIs0}: below MIN`).toBe(true);
      expect(sqrtP < 1461446703485210103287273052203988822378723970342n, `${c.name} q0=${quoteIs0}: above MAX`).toBe(true);
      const back = decodeQuotePerToken(sqrtP, c.td, c.qd, quoteIs0);
      const relErr = Math.abs(back - c.price) / c.price;
      expect(relErr < 1e-6, `${c.name} q0=${quoteIs0}: ${back} vs ${c.price} (relErr ${relErr})`).toBe(true);

      // Position placement is tick-based (getTickAtSqrtPrice), and ticks stay precise even
      // where price1e18 would quantize — the seed lands within ~1 tick of a real tick.
      const tick = getTickAtSqrtPrice(sqrtP);
      expect(tick > -887272 && tick < 887272, `${c.name} q0=${quoteIs0}: tick ${tick} out of range`).toBe(true);
      const reSeed = Number(getSqrtPriceAtTick(tick)) / Number(sqrtP);
      expect(Math.abs(reSeed - 1) < 1e-4, `${c.name} q0=${quoteIs0}: tick round-trip off by ${reSeed}`).toBe(true);
    }
  }
});

test("sqrtPriceX96FromPrice: the 6-vs-18 decimal factor is not omitted", () => {
  // Same human price, WETH (18/18) vs USDG (18/6) quote, same orientation. The raw ratio
  // differs by 10^12, so the sqrt prices must differ by ~10^6 — proving the factor applies.
  const weth = sqrtPriceX96FromPrice(0.5, 18, 18, false);
  const usdg = sqrtPriceX96FromPrice(0.5, 18, 6, false);
  const ratio = Number(weth) / Number(usdg);
  expect(ratio > 9e5 && ratio < 1.1e6, `ratio ${ratio} — decimal factor missing?`).toBe(true);
});

test("sqrtPriceX96FromPrice: rejects non-positive price", () => {
  expect(() => sqrtPriceX96FromPrice(0, 18, 6, true)).toThrow();
  expect(() => sqrtPriceX96FromPrice(-1, 18, 6, true)).toThrow();
});
