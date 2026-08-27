// Which Friar pool a token row points at, and what base fee it quotes. Split from
// worker.ts so the selection rules are testable without a D1 handle.
import { ADDRESSES, FRIAR_V2_DEFAULT_CONFIG, deployedFeeTiers, feeTierForHook, isFriarHook } from "@friar/chain";

/** One pools-table row joined with its open (unclosed) manager-position count. */
export interface FriarPoolRow {
  pool_id: string;
  currency0: string;
  currency1: string;
  hooks: string;
  tick_spacing: number;
  open_n: number;
}

export interface FriarPoolPick {
  poolId: string;
  /** Base fee of THIS pool, pips. */
  baseFee: number;
  tier: boolean;
  openN: number;
}

export type FriarRails = { WETH?: FriarPoolPick; USDG?: FriarPoolPick };

/**
 * Base fee of a Friar pool in pips, by hook generation: tier hooks carry it as identity,
 * FriarV2 in its config, and the V1 hooks derive it from spacing (base% = 0.005 × spacing,
 * so pips = 50 × spacing). Null for a non-Friar hook — doubles as the "ours?" filter.
 */
export function friarBaseFeePips(hooks: string, tickSpacing: number): number | null {
  const tier = feeTierForHook(hooks);
  if (tier) return tier.pips;
  if (!isFriarHook(hooks)) return null;
  const h = hooks.toLowerCase();
  if (h === ADDRESSES.friarV2.toLowerCase()) return FRIAR_V2_DEFAULT_CONFIG.baseFeePips;
  return 50 * tickSpacing;
}

/** The base fee a NEW pool would quote today: the cheapest deployed tier. Pre-tier
 * fallback is the spacing-100 V1 floor, which keeps the old constant's behaviour. */
export function friarFloorPips(): number {
  const tiers = deployedFeeTiers();
  return tiers.length ? Math.min(...tiers.map((t) => t.pips)) : 5_000;
}

/**
 * Which of two Friar pools on the same token+rail the board should point at. Live
 * liquidity beats empty (an empty pool is a dead link even if it's ours), then the tier
 * generation beats V1 (tiers are the current venue), then more open positions.
 */
function better(a: FriarPoolPick, b: FriarPoolPick): FriarPoolPick {
  const score = (p: FriarPoolPick) => (p.openN > 0 ? 2 : 0) + (p.tier ? 1 : 0);
  if (score(b) !== score(a)) return score(b) > score(a) ? b : a;
  return b.openN > a.openN ? b : a;
}

/**
 * Every Friar pool, in the two shapes the token routes need: the board pointer per token
 * per quote rail, and a flat id set covering ALL generations — resolveIncumbent uses the
 * set so a Friar pool is never mistaken for its own incumbent. Stock tokens trade on the
 * USDG rail; memes on WETH.
 */
export function selectFriarPools(rows: FriarPoolRow[]): { byToken: Map<string, FriarRails>; ids: Set<string> } {
  const WETH = ADDRESSES.weth.toLowerCase();
  const USDG = ADDRESSES.usdg.toLowerCase();
  const byToken = new Map<string, FriarRails>();
  const ids = new Set<string>();
  for (const p of rows) {
    const baseFee = friarBaseFeePips(p.hooks, p.tick_spacing);
    if (baseFee == null) continue;
    ids.add(p.pool_id.toLowerCase());
    const pick: FriarPoolPick = {
      poolId: p.pool_id,
      baseFee,
      tier: feeTierForHook(p.hooks) !== undefined,
      openN: p.open_n,
    };
    const c0 = p.currency0.toLowerCase();
    const c1 = p.currency1.toLowerCase();
    for (const [railAddr, rail] of [
      [WETH, "WETH"],
      [USDG, "USDG"],
    ] as const) {
      const token = c0 === railAddr ? c1 : c1 === railAddr ? c0 : null;
      if (!token || token === WETH || token === USDG) continue; // skip the WETH/USDG corridor itself
      const e = byToken.get(token) ?? {};
      e[rail] = e[rail] ? better(e[rail], pick) : pick;
      byToken.set(token, e);
    }
  }
  return { byToken, ids };
}

/** The fields enrichToken reads off a token row. */
export interface TokenLike {
  address: string;
  quote: string | null;
  incumbent_fee: number | null;
}

/**
 * Annotate a raw token row with the Friar pool the board should link (or null — your
 * open creates it) and the base fee that pool quotes; without a pool, the fee a fresh
 * one would quote (the cheapest deployed tier). Shared by the board and the single-token
 * lookup so both answer identically for the same token.
 */
export function enrichToken<T extends TokenLike>(t: T, byToken: Map<string, FriarRails>) {
  const rails = byToken.get(t.address);
  const rail = t.quote === "USDG" ? "USDG" : "WETH";
  // matching rail first; any Friar pool on the other rail still counts as existing
  const pick = rails?.[rail] ?? rails?.[rail === "USDG" ? "WETH" : "USDG"] ?? null;
  const baseFee = pick?.baseFee ?? friarFloorPips();
  return {
    ...t,
    friarPoolId: pick?.poolId ?? null,
    friarBaseFee: baseFee,
    undercutsIncumbent: t.incumbent_fee != null ? baseFee < t.incumbent_fee : null,
  };
}
