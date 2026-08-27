// BigInt port of Uniswap's TickMath.getSqrtPriceAtTick (Q64.96), bit-exact.
// Reference: v4-core/src/libraries/TickMath.sol (MIT).

const MAX_UINT256 = (1n << 256n) - 1n;

const MULTIPLIERS: ReadonlyArray<readonly [bigint, bigint]> = [
  [0x1n, 0xfffcb933bd6fad37aa2d162d1a594001n],
  [0x2n, 0xfff97272373d413259a46990580e213an],
  [0x4n, 0xfff2e50f5f656932ef12357cf3c7fdccn],
  [0x8n, 0xffe5caca7e10e4e61c3624eaa0941cd0n],
  [0x10n, 0xffcb9843d60f6159c9db58835c926644n],
  [0x20n, 0xff973b41fa98c081472e6896dfb254c0n],
  [0x40n, 0xff2ea16466c96a3843ec78b326b52861n],
  [0x80n, 0xfe5dee046a99a2a811c461f1969c3053n],
  [0x100n, 0xfcbe86c7900a88aedcffc83b479aa3a4n],
  [0x200n, 0xf987a7253ac413176f2b074cf7815e54n],
  [0x400n, 0xf3392b0822b70005940c7a398e4b70f3n],
  [0x800n, 0xe7159475a2c29b7443b29c7fa6e889d9n],
  [0x1000n, 0xd097f3bdfd2022b8845ad8f792aa5825n],
  [0x2000n, 0xa9f746462d870fdf8a65dc1f90e061e5n],
  [0x4000n, 0x70d869a156d2a1b890bb3df62baf32f7n],
  [0x8000n, 0x31be135f97d08fd981231505542fcfa6n],
  [0x10000n, 0x9aa508b5b7a84e1c677de54f3e99bc9n],
  [0x20000n, 0x5d6af8dedb81196699c329225ee604n],
  [0x40000n, 0x2216e584f5fa1ea926041bedfe98n],
  [0x80000n, 0x48a170391f7dc42444e8fa2n],
];

export const MIN_TICK = -887272;
export const MAX_TICK = 887272;

export function getSqrtPriceAtTick(tick: number): bigint {
  if (tick < MIN_TICK || tick > MAX_TICK) throw new Error(`tick out of range: ${tick}`);
  const absTick = BigInt(tick < 0 ? -tick : tick);

  let price = 1n << 128n;
  for (const [mask, mul] of MULTIPLIERS) {
    if (absTick & mask) price = (price * mul) >> 128n;
  }
  if (tick > 0) price = MAX_UINT256 / price;

  // Round up to Q64.96 exactly like the Solidity implementation.
  return (price >> 32n) + ((price & ((1n << 32n) - 1n)) === 0n ? 0n : 1n);
}

// Approximate inverse (float log): fine for anchoring plans; exact tick comes from
// the pool itself once it exists. Accurate to ±1 tick, and bucketing absorbs that.
export function getTickAtSqrtPrice(sqrtPriceX96: bigint): number {
  const ratio = Number(sqrtPriceX96) / 2 ** 96;
  return Math.round(Math.log(ratio * ratio) / Math.log(1.0001));
}

/**
 * Seed a pool's sqrtPriceX96 from a HUMAN price quoted as `quotePerToken` (WETH- or
 * USDG-per-token), given each side's ERC-20 decimals and the pool's currency ordering.
 *
 * Uniswap encodes `currency1_raw / currency0_raw`; the human price is in whole tokens,
 * so the raw ratio differs by 10^(tokenDecimals − quoteDecimals). With a WETH quote both
 * sides are 18 decimals and the factor is 1 (why this was invisible before); with a USDG
 * quote (6 decimals) the factor is 10^12 — omit it and the pool mints ~a trillion× off.
 * Pure + tested precisely because a wrong seed is an unrecoverable mispricing.
 */
export function sqrtPriceX96FromPrice(
  quotePerToken: number,
  tokenDecimals: number,
  quoteDecimals: number,
  quoteIs0: boolean,
): bigint {
  if (!(quotePerToken > 0) || !Number.isFinite(quotePerToken)) throw new Error("price must be positive & finite");
  const decFactor = 10 ** (tokenDecimals - quoteDecimals);
  // poolPrice = currency1_raw per currency0_raw:
  //   quoteIs0  → currency0=quote, currency1=token → token_raw/quote_raw = decFactor / P
  //   !quoteIs0 → currency0=token, currency1=quote → quote_raw/token_raw = P / decFactor
  const poolPrice = quoteIs0 ? decFactor / quotePerToken : quotePerToken / decFactor;
  // sqrtPriceX96 = sqrt(poolPrice) · 2^96, staged through 2^48 to keep the float mantissa
  // sane across the ~24 orders of magnitude a 6-vs-18-decimal pair can span.
  return BigInt(Math.round(Math.sqrt(poolPrice) * 2 ** 48)) * 2n ** 48n;
}
