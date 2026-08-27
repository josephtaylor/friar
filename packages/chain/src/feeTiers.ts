// The FriarTier fee-tier set: one deployed hook per base fee. Because base fee is a hook
// immutable (not off-key config), a pool's fee is part of its on-chain identity, and base
// fee varies independently of bin width. See tuck/src/FriarTier.sol.
//
// This is a DISCRETE, KNOWN set — we deploy the hooks — which is exactly what makes the pool
// list and the open selector tractable: the universe of Friar pools for a pair is the
// bounded grid {these tiers} × {FRIAR_V2_SPACINGS}, enumerable with no discovery guesswork.
import type { Address } from "viem";

export interface FeeTier {
  /** base fee as a percent, e.g. 0.3 */
  pct: number;
  /** base fee in v4 pips (10_000 = 1%), the hook's immutable */
  pips: number;
  /**
   * The deployed FriarTier hook for this base fee. `null` until the tier set is deployed
   * (DeployFriarTiers.s.sol) and the addresses are pasted back here. While null the tier is
   * "not yet live": `deployedFeeTiers()` filters it out, so the open flow shows no tier
   * dropdown and keeps its pre-tier behaviour. Filling these is the whole cutover to the
   * tier venue — no code change, just addresses.
   */
  hook: Address | null;
}

/**
 * The shipped tiers: 0.30 / 0.80 / 1 / 2 / 5%. Frozen — matches the immutable base fees in
 * DeployFriarTiers.s.sol (3000 / 8000 / 10000 / 20000 / 50000 pips). Addresses are filled
 * from the deploy broadcast log; the deploy is deterministic given the committed bytecode,
 * but Solidity's appended metadata hash means any edit to FriarTier.sol shifts them, so take
 * them from the actual run, not a prediction.
 */
export const FEE_TIERS: readonly FeeTier[] = [
  { pct: 0.3, pips: 3_000, hook: "0xE46D00C0355684cC96ab678CB2Fc04c7165e9080" },
  { pct: 0.8, pips: 8_000, hook: "0x52A0a0A79ad3aA73AB207117972FA488432A1080" },
  { pct: 1, pips: 10_000, hook: "0x1B780830Ed629eb9e6De573957A121fD317C1080" },
  { pct: 2, pips: 20_000, hook: "0x8b1256ed9b20Ac387151e956498eC9FD0e291080" },
  { pct: 5, pips: 50_000, hook: "0x35b59db64335C22840d98Be894B8F3E1e2EfD080" },
] as const;

/** Tiers whose hook is deployed. Empty pre-deploy, which keeps the tier UI dormant. */
export function deployedFeeTiers(): FeeTier[] {
  return FEE_TIERS.filter((t) => t.hook !== null);
}

/** The tier a hook address belongs to, or undefined. Case-insensitive. */
export function feeTierForHook(hook: string | null | undefined): FeeTier | undefined {
  if (!hook) return undefined;
  const h = hook.toLowerCase();
  return FEE_TIERS.find((t) => t.hook !== null && t.hook.toLowerCase() === h);
}

/** Is this address one of the deployed FriarTier hooks? */
export function isFriarTierHook(hook: string | null | undefined): boolean {
  return feeTierForHook(hook) !== undefined;
}

/** All deployed tier hook addresses — for indexer log filters and the pool-grid scan. */
export function feeTierHooks(): Address[] {
  return FEE_TIERS.filter((t): t is FeeTier & { hook: Address } => t.hook !== null).map((t) => t.hook);
}
