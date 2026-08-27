// BigInt ports of v4-periphery LiquidityAmounts (MIT) — same truncation semantics.
import { getSqrtPriceAtTick } from "./tickmath.ts";

const Q96 = 1n << 96n;

export interface Amounts {
  amount0: bigint;
  amount1: bigint;
}

// L from token1 (the quote side when the range is entirely below spot).
export function liquidityForAmount1(sqrtA: bigint, sqrtB: bigint, amount1: bigint): bigint {
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA];
  return (amount1 * Q96) / (sqrtB - sqrtA);
}

// L from token0 (the token side when the range is entirely above spot).
export function liquidityForAmount0(sqrtA: bigint, sqrtB: bigint, amount0: bigint): bigint {
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA];
  const intermediate = (sqrtA * sqrtB) / Q96;
  return (amount0 * intermediate) / (sqrtB - sqrtA);
}

// Token amounts currently backing liquidity L in [tickLower, tickUpper] at sqrtP.
export function amountsForLiquidity(sqrtP: bigint, tickLower: number, tickUpper: number, L: bigint): Amounts {
  const sqrtA = getSqrtPriceAtTick(tickLower);
  const sqrtB = getSqrtPriceAtTick(tickUpper);
  if (sqrtP <= sqrtA) {
    return { amount0: amount0Delta(sqrtA, sqrtB, L), amount1: 0n };
  } else if (sqrtP < sqrtB) {
    return { amount0: amount0Delta(sqrtP, sqrtB, L), amount1: amount1Delta(sqrtA, sqrtP, L) };
  }
  return { amount0: 0n, amount1: amount1Delta(sqrtA, sqrtB, L) };
}

function amount0Delta(sqrtA: bigint, sqrtB: bigint, L: bigint): bigint {
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA];
  return ((L << 96n) * (sqrtB - sqrtA)) / sqrtB / sqrtA;
}

function amount1Delta(sqrtA: bigint, sqrtB: bigint, L: bigint): bigint {
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA];
  return (L * (sqrtB - sqrtA)) / Q96;
}
