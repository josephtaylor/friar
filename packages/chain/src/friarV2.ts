// FriarV2 per-pool fee configuration and the presets the app opens with.
//
// V2's break from the V1 pair (friarStandard/friarCalm) is that fee behaviour is no longer
// baked into the hook address. A single hook now reads a per-pool `PoolConfig`, registered
// before `initialize` and frozen at it. Two things that used to be hook-level choices are
// now pool-level:
//   - base fee: `baseFeePips`, independent of tickSpacing (V1 tied base% = 0.005 × spacing)
//   - surge aggressiveness: `variableFeeControl`, which was the ONLY difference between the
//     standard (40k) and calm (20k) V1 hooks
//
// So "which hook" collapses into "which config", and the standard/calm split lives on as
// two presets rather than two deployments. See tuck/src/FriarV2.sol (PoolConfig) and
// tuck/docs/V2-MEASUREMENTS.md.
import type { Address } from "viem";
import { DYNAMIC_FEE_FLAG, type PoolKey } from "./poolKey.ts";
import { ADDRESSES } from "./chain.ts";

/** Mirrors FriarV2.PoolConfig. `locked` is set true by the hook at `afterInitialize`; it is
 *  never part of what a caller proposes, so it is intentionally absent here — the config the
 *  UI registers is the six tunable fields, and the manager asserts the frozen copy matches
 *  with `locked` normalised to true. */
export interface FriarV2Config {
  /** base fee in v4 pips (1e6 = 100%), independent of tickSpacing */
  baseFeePips: number;
  /** LB filterPeriod (seconds): swaps closer together than this build the accumulator */
  filterPeriod: number;
  /** LB decayPeriod (seconds) */
  decayPeriod: number;
  /** LB reductionFactor (bps) */
  reductionFactor: number;
  /** LB variableFeeControl — the surge multiplier; the standard/calm dial */
  variableFeeControl: number;
  /** price displacement in TICKS at which the surge saturates (spacing-invariant) */
  maxVolatilityTicks: number;
}

/**
 * The hook's on-chain `defaultConfig()` — the config a pool adopts when nobody registers
 * one. Pinned here as a constant and asserted against chain in friarV2.test.ts, so a redeploy
 * that changes the default fails the suite instead of silently drifting from what the UI
 * proposes. Read 2026-07-31 from 0x188D…5080.
 */
export const FRIAR_V2_DEFAULT_CONFIG: FriarV2Config = {
  baseFeePips: 9_000, // 0.90%
  filterPeriod: 10,
  decayPeriod: 600,
  reductionFactor: 5_000,
  variableFeeControl: 40_000,
  maxVolatilityTicks: 7_000,
};

/**
 * The tick-spacing choices the open flow offers when CREATING a pool. Spacing is the only
 * pool parameter that lives on the PoolKey, so every distinct value is a separate pool —
 * this is the axis that fragments liquidity. Constraining it to a short canonical list (a
 * dropdown, not a free number) keeps a pair's depth converging on a handful of pools instead
 * of a smear. Base fee, by contrast, lives in the off-key config and never forks a pool, so
 * it stays a free input.
 *
 * `binPct` is the approximate width of one bin at this spacing (1.0001^spacing − 1), shown
 * so an LP reads spacing as concentration rather than a bare tick count. The surge params
 * (variableFeeControl etc.) are NOT a user choice — they stay at the on-chain default.
 */
export interface FriarV2Spacing {
  value: number;
  /** approximate width of one bin, e.g. "1.6%" */
  binPct: string;
}

export const FRIAR_V2_SPACINGS: readonly FriarV2Spacing[] = [
  { value: 50, binPct: "0.5%" },
  { value: 100, binPct: "1.0%" },
  { value: 160, binPct: "1.6%" },
  { value: 320, binPct: "3.3%" },
] as const;

/**
 * A FriarV2 PoolKey for a pair at a chosen spacing. The fee field is always the dynamic
 * flag (the hook supplies the real fee); `baseFeePips` lives in the config, NOT here.
 * Currencies sort by address, so `quoteIs0` is independent of spacing or config.
 */
export function friarV2PoolKey(
  token: Address,
  quote: Address,
  spacing: number,
): { key: PoolKey; quoteIs0: boolean } {
  const quoteIs0 = quote.toLowerCase() < token.toLowerCase();
  const [currency0, currency1] = quoteIs0 ? [quote, token] : [token, quote];
  return {
    key: {
      currency0,
      currency1,
      fee: DYNAMIC_FEE_FLAG,
      tickSpacing: spacing,
      hooks: ADDRESSES.friarV2 as Address,
    },
    quoteIs0,
  };
}
