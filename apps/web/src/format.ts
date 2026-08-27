// Display helpers. Traders read in percentages first (vs invested capital); raw
// WETH is fine print. Negatives use the unicode minus (−) to match the design.
import { fmtQuote, type PnlSummary } from "./api.js";

// ── denomination (ETH vs USD) ──────────────────────────────────────────────
// Percentages/sign/APR are ratios of quote values, so a linear ×rate conversion
// leaves them identical — only ABSOLUTE magnitudes convert. These take a 1e18 quote
// (WETH) value and a rate (USD per WETH); rate === null keeps ETH (used while the
// rate loads and for the ETH default). USD == USDG, the chain's dollar.
export type Denom = "ETH" | "USD";

function usdMagnitude(x: bigint, rate: number): string {
  const usd = (Number(x < 0n ? -x : x) / 1e18) * rate;
  return usd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Unsigned magnitude of a 1e18 quote in the chosen denom. */
export function fmtMoney(v: string | bigint, denom: Denom, rate: number | null, digits = 4): string {
  const x = typeof v === "bigint" ? v : BigInt(v);
  if (denom === "USD" && rate != null) return (x < 0n ? "-" : "") + usdMagnitude(x, rate);
  return fmtQuote(x.toString(), digits);
}

/** Signed (unicode ±) magnitude of a 1e18 quote in the chosen denom. */
export function signedMoney(v: string | bigint, denom: Denom, rate: number | null, digits = 4): string {
  const x = typeof v === "bigint" ? v : BigInt(v);
  if (denom === "USD" && rate != null) return x < 0n ? `−${usdMagnitude(x, rate)}` : x > 0n ? `+${usdMagnitude(x, rate)}` : usdMagnitude(x, rate);
  return signedQuote(x.toString(), digits);
}

export function moneyUnit(denom: Denom): string {
  return denom === "USD" ? "USD" : "WETH";
}

export function fmtAge(seconds: number): string {
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))}m`;
  if (seconds < 172_800) return `${(seconds / 3600).toFixed(1)}h`;
  return `${(seconds / 86_400).toFixed(1)}d`;
}

/** Cost basis for %-of-invested display: explicit invested; else |net cashflow| as a
 * last resort. Never negative — a positive cashflow (a profitable close) used to flip
 * the basis negative and render the position as a bogus −100%. */
export function basisOf(s: PnlSummary): bigint {
  const inv = s.investedQuote ? BigInt(s.investedQuote) : 0n;
  if (inv > 0n) return inv;
  const cf = BigInt(s.cashflowQuote);
  return cf < 0n ? -cf : cf;
}

/** Signed percent of a 1e18 quote value vs a basis, e.g. "+4.92%" / "−3.97%". */
export function pctOf(v: string | bigint, basis: bigint): string {
  const x = typeof v === "bigint" ? v : BigInt(v);
  if (basis <= 0n) return "—";
  const bps = Number((x * 10_000n) / basis) / 100; // 2 dp
  return `${bps >= 0 ? "+" : "−"}${Math.abs(bps).toFixed(2)}%`;
}

/** Signed 1e18 quote with +/− (unicode minus), e.g. "+0.012045" / "−0.0064". */
export function signedQuote(v: string | bigint, digits = 4): string {
  const x = typeof v === "bigint" ? v : BigInt(v);
  const body = fmtQuote((x < 0n ? -x : x).toString(), digits);
  return x < 0n ? `−${body}` : x > 0n ? `+${body}` : body;
}

/** Tie goes to the runner: anything that DISPLAYS as zero (|v| under 1e-6 quote — the
 * formatters round it to +0.0000 / +0.00%) colors as a gain, never a loss. A −1 wei
 * accounting artifact must not paint a break-even close red. */
export function signClass(v: string | bigint): "pos" | "neg" | "" {
  const x = typeof v === "bigint" ? v : BigInt(v);
  const DUST = 1_000_000_000_000n;
  return x >= -DUST ? "pos" : "neg";
}

/** APR from fees earned over the position's life vs basis, annualized. */
export function feeApr24h(feesNet: string | bigint, basis: bigint, ageSeconds: number): string | null {
  const fees = typeof feesNet === "bigint" ? feesNet : BigInt(feesNet);
  if (basis <= 0n || ageSeconds < 3600) return null;
  const ratio = Number((fees * 1_000_000n) / basis) / 1_000_000;
  const apr = (ratio / ageSeconds) * 31_536_000 * 100;
  if (!isFinite(apr)) return null;
  return `${apr >= 0 ? "" : "−"}${Math.abs(apr).toFixed(0)}%`;
}
