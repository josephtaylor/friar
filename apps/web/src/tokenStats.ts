// How a token row is read: window selection and the derived fee/TVL.
//
// Shared because the board is no longer the only place that shows these numbers — the
// creation screen shows the same figures for a pasted contract address. A fee/TVL that
// means one thing on the board and another on the screen where you commit money would be
// worse than not showing it at all, so there is one definition and no second copy.
import type { ApiToken } from "./api.js";

export type Tf = "1h" | "6h" | "24h";
export type Kind = "all" | "meme" | "rwa";

export const chgFor = (t: ApiToken, tf: Tf) => (tf === "1h" ? t.ch1 : tf === "6h" ? t.ch6 : t.ch24);
export const volFor = (t: ApiToken, tf: Tf) => (tf === "1h" ? t.vol1 : tf === "6h" ? t.vol6 : t.vol24);
export const kindOf = (t: ApiToken): Exclude<Kind, "all"> => (t.kind === "rwa" ? "rwa" : "meme");

/** Fee/TVL for the window: what incumbent-venue LPs earned per dollar of liquidity
 * (vol × fee ÷ liq). Fee pips are 1e6-scaled. Null when fee or volume is unresolved. */
export const feeTvlFor = (t: ApiToken, tf: Tf) => {
  const v = volFor(t, tf);
  if (v == null || !(t.liq_usd > 0) || t.incumbent_fee == null) return null;
  return (v * (t.incumbent_fee / 1e6)) / t.liq_usd;
};

/**
 * What the FEE/TVL heading actually shows. TWO different numbers wear it, and the unit is
 * the only thing telling them apart:
 *
 *   "fee"      — real fee/TVL, as a PERCENT: vol × incumbent fee ÷ liq. What LPs at the
 *                incumbent venue earned per dollar of liquidity over the window.
 *   "turnover" — vol ÷ liq, as a MULTIPLE ("35.3×"). Shown only when no static incumbent
 *                tier resolved: the fee-less half of the same idea, i.e. how hard the
 *                liquidity is working with the fee rate unknown.
 *
 * These must never be formatted alike. A turnover multiple presented as a fee percentage
 * overstates the return by whatever the fee rate turns out to be — 35.3× reads as a
 * spectacular yield and actually means "we don't know the yield".
 */
export type FeeTvlDisplay =
  | { kind: "none"; text: string }
  | { kind: "fee"; pct: number; text: string }
  | { kind: "turnover"; ratio: number; text: string };

export function feeTvlDisplay(t: ApiToken, tf: Tf): FeeTvlDisplay {
  const v = volFor(t, tf);
  if (v == null || !(t.liq_usd > 0)) return { kind: "none", text: "—" };
  if (t.incumbent_fee == null) {
    const ratio = v / t.liq_usd;
    return { kind: "turnover", ratio, text: `${ratio.toFixed(1)}×` };
  }
  const pct = ((v * (t.incumbent_fee / 1e6)) / t.liq_usd) * 100;
  return { kind: "fee", pct, text: pct >= 10 ? `${pct.toFixed(0)}%` : `${pct.toFixed(2)}%` };
}

/**
 * Why fee/TVL is missing, when it is. The three cases need different words: an unlisted
 * token has no venue at all (being first is the opportunity), a token whose only venue is
 * a dynamic-fee hooked pool has no static tier to compare against (common for launchpad
 * tokens, and NOT a data gap), and everything else is genuinely unresolved.
 */
export function incumbentGap(t: ApiToken): "none" | "no-venue" | "dynamic-only" | "unresolved" {
  if (t.incumbent_fee != null) return "none";
  if (t.pools === 0) return "no-venue";
  return t.incumbent_pool == null ? "dynamic-only" : "unresolved";
}
