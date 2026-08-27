// Uniswap v4 encodes a hook's permissions in the LOW 14 BITS of its address, so a
// pool's hook can be classified client-side with zero RPC calls. Mirrors
// v4-core/src/libraries/Hooks.sol flag constants.
import type { Address } from "viem";
import { ADDRESSES } from "./chain.ts";
import { isFriarTierHook } from "./feeTiers.ts";

export const HOOK_FLAGS = {
  beforeInitialize: 1 << 13,
  afterInitialize: 1 << 12,
  beforeAddLiquidity: 1 << 11,
  afterAddLiquidity: 1 << 10,
  beforeRemoveLiquidity: 1 << 9,
  afterRemoveLiquidity: 1 << 8,
  beforeSwap: 1 << 7,
  afterSwap: 1 << 6,
  beforeDonate: 1 << 5,
  afterDonate: 1 << 4,
  beforeSwapReturnsDelta: 1 << 3,
  afterSwapReturnsDelta: 1 << 2,
  afterAddLiquidityReturnsDelta: 1 << 1,
  afterRemoveLiquidityReturnsDelta: 1 << 0,
} as const;

export type HookFlag = keyof typeof HOOK_FLAGS;

const ZERO_ADDR = "0x0000000000000000000000000000000000000000";
const ALL_HOOK_MASK = (1n << 14n) - 1n;

/** Permission flags encoded in a hook address. */
export function hookPermissions(hooks: Address): HookFlag[] {
  const bits = Number(BigInt(hooks) & ALL_HOOK_MASK);
  return (Object.keys(HOOK_FLAGS) as HookFlag[]).filter((f) => (bits & HOOK_FLAGS[f]) !== 0);
}

export interface HookVerdict {
  level: "ok" | "warn" | "block";
  flags: HookFlag[];
  reasons: string[];
}

/** Any Friar hook, across all generations: the V1 spacing-era pair (standard/calm),
 * FriarV2, and the deployed FriarTier fee-tier hooks. The one predicate for "is this
 * pool ours" — per-generation checks belong behind this, not copied at call sites. */
export function isFriarHook(hooks: string): boolean {
  const h = hooks.toLowerCase();
  return (
    h === ADDRESSES.friarStandard.toLowerCase() ||
    h === ADDRESSES.friarCalm.toLowerCase() ||
    h === ADDRESSES.friarV2.toLowerCase() ||
    isFriarTierHook(h)
  );
}

/**
 * Exit-safety-first policy for LPing a pool with an arbitrary hook:
 * - block: the hook runs on liquidity REMOVAL — it can revert (trap funds) or take
 *   deltas (tax the exit). Money-out is non-negotiable, so these pools are refused.
 * - warn: the hook runs on liquidity ADDS — it may reject the open or surcharge entry;
 *   recoverable (the open reverts / pay caps bound the cost), so allowed with a warning.
 * - ok: hookless, a Friar hook, or swap/donate/init-only permissions — the hook can
 *   never touch LP principal.
 */
export function classifyHook(hooks: Address): HookVerdict {
  const h = hooks.toLowerCase();
  const flags = h === ZERO_ADDR ? [] : hookPermissions(hooks);
  if (h === ZERO_ADDR) return { level: "ok", flags, reasons: [] };
  if (isFriarHook(h)) return { level: "ok", flags, reasons: [] };
  if (
    flags.includes("beforeRemoveLiquidity") ||
    flags.includes("afterRemoveLiquidity") ||
    flags.includes("afterRemoveLiquidityReturnsDelta")
  ) {
    return {
      level: "block",
      flags,
      reasons: ["this pool's hook runs on liquidity removal — it could block or tax your exit, trapping funds"],
    };
  }
  if (
    flags.includes("beforeAddLiquidity") ||
    flags.includes("afterAddLiquidity") ||
    flags.includes("afterAddLiquidityReturnsDelta")
  ) {
    return {
      level: "warn",
      flags,
      reasons: ["this pool's hook runs on liquidity adds — the open may be rejected or surcharged (pay caps still protect you)"],
    };
  }
  return { level: "ok", flags, reasons: [] };
}

/**
 * Can this hook alter the SWAPPER's balance delta?
 *
 * Only the two returns-delta swap bits allow it — v4-core zeroes the hook delta otherwise
 * (`callHookWithReturnDelta` returns 0 without the flag, and `beforeSwap` only parses a
 * delta under BEFORE_SWAP_RETURNS_DELTA). A hook with plain beforeSwap/afterSwap (dynamic
 * fees, oracles, MEV logic — Friar itself) cannot touch the swap's accounting at all.
 *
 * This is deliberately a WARNING, not a block: on Robinhood Chain the dominant launchpad
 * hook holds `afterSwapReturnsDelta` to collect its swap fee, so screening these out would
 * exclude the primary liquidity for exactly the tokens people LP. The real protection is
 * the manager's `maxPay0/1` caps, which bound what any venue can charge regardless of hook.
 */
export function hookTakesSwapDelta(hooks: Address): boolean {
  if (hooks.toLowerCase() === ZERO_ADDR) return false;
  const flags = hookPermissions(hooks);
  return flags.includes("beforeSwapReturnsDelta") || flags.includes("afterSwapReturnsDelta");
}
