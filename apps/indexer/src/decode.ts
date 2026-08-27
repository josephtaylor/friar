// Event fragments + normalization. Pure — no Workers imports, unit-testable.
import type { Hex } from "viem";

/** Uniswap v4 PoolManager Swap event. */
export const poolManagerSwapEvent = {
  type: "event",
  name: "Swap",
  inputs: [
    { name: "id", type: "bytes32", indexed: true },
    { name: "sender", type: "address", indexed: true },
    { name: "amount0", type: "int128", indexed: false },
    { name: "amount1", type: "int128", indexed: false },
    { name: "sqrtPriceX96", type: "uint160", indexed: false },
    { name: "liquidity", type: "uint128", indexed: false },
    { name: "tick", type: "int24", indexed: false },
    { name: "fee", type: "uint24", indexed: false },
  ],
} as const;

/** Uniswap v3 pool Swap event (emitted per-pool, not by a singleton). */
export const v3SwapEvent = {
  type: "event",
  name: "Swap",
  inputs: [
    { name: "sender", type: "address", indexed: true },
    { name: "recipient", type: "address", indexed: true },
    { name: "amount0", type: "int256", indexed: false },
    { name: "amount1", type: "int256", indexed: false },
    { name: "sqrtPriceX96", type: "uint160", indexed: false },
    { name: "liquidity", type: "uint128", indexed: false },
    { name: "tick", type: "int24", indexed: false },
  ],
} as const;

export interface DecodedSwap {
  /** v4 PoolId (our pools) or v3 pool address (incumbent venues) */
  poolId: Hex;
  block: bigint;
  ts: number;
  amount0: bigint;
  amount1: bigint;
  sqrtPriceX96: bigint;
  tick: number;
  /** per-swap fee in pips (10000 = 1%) — v4 Swap events only; null for v3 (static tier) */
  fee: number | null;
}

/** JSON.stringify with bigint → decimal string. */
export function jsonWithBigints(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
}
