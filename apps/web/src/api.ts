// Typed client for friar-api. Base URL via VITE_API_URL (dev: friar-api on :8788).
const BASE = import.meta.env.VITE_API_URL ?? "http://localhost:8788";

export interface PnlSummary {
  valueQuote: string;
  cashflowQuote: string;
  pnlQuote: string;
  feesNetQuote: string;
  inventoryQuote: string;
  perfFeeQuote: string;
  investedQuote?: string;
  unclaimedFees0: string;
  unclaimedFees1: string;
  priceUsed: string;
  markedAt: number | null;
}

export interface ApiPosition {
  position_id: number;
  /** Manager deployment this position lives on. Null on rows predating multi-manager
   * support; resolve with `managerForPosition` rather than assuming the current one. */
  manager: string | null;
  owner: string;
  pool_id: string;
  opened_ts: number;
  closed_ts: number | null;
  currency0: string;
  currency1: string;
  fees0: string;
  fees1: string;
  perf0: string;
  perf1: string;
  summary: PnlSummary;
}

export interface ApiBin {
  bin_index: number;
  tick_lower: number;
  tick_upper: number;
  liquidity: string;
}

export interface ApiPositionDetail extends ApiPosition {
  bins: ApiBin[];
  events: Array<{ block: number; ts: number; name: string; data: string; tx_hash: string }>;
  latestSnapshot: {
    ts: number;
    sqrt_price: string;
    market_sqrt_price: string | null;
    amount0: string;
    amount1: string;
    fees0: string;
    fees1: string;
  } | null;
}

export interface PortfolioPoint {
  ts: number;
  valueQuote: string;
}

export interface ApiPool {
  pool_id: string;
  currency0: string;
  currency1: string;
  fee: number;
  tick_spacing: number;
  hooks: string;
  lastPrice: string | null;
  vol24h0: string;
  vol24h1: string;
  swaps24h: number;
  feeAvg24h: number | null; // dynamic-fee stats, pips; null until fee-tracked candles exist
  feePeak24h: number | null;
  openPositions: number;
  tvlQuote: string; // pool TVL in quote-token base units (decimals per quoteSym)
  quoteSym: "WETH" | "USDG";
}

export interface ApiToken {
  address: string;
  symbol: string;
  name: string | null; // display name (RWA registry tokens; null for memes)
  logo: string | null; // logo URL (RWA registry tokens)
  kind: string | null; // 'meme' | 'rwa'; null = legacy meme row
  quote: string | null; // dominant quote rail, 'WETH' | 'USDG'
  price_native: number;
  price_usd: number | null;
  ch1: number | null;
  ch6: number | null;
  ch24: number | null;
  vol24: number;
  vol1: number | null; // 1h / 6h volume — null on rows scanned before the columns existed
  vol6: number | null;
  liq_usd: number;
  mcap: number | null;
  pools: number;
  incumbent_pool: string | null;
  incumbent_fee: number | null; // static tier, pips (10000 = 1%); null if unresolved
  risk_level: string | null; // 'ok' | 'warn' — scan-time safety verdict ('block' never reaches the board); null = unchecked
  risk: string | null; // JSON array of fired safety flags, e.g. '["goplus:is_mintable"]'
  updated_ts: number;
  friarPoolId: string | null; // existing Friar pool, or null → your open creates it
  friarBaseFee: number; // that pool's base fee, pips; without a pool, the cheapest deployed tier
  undercutsIncumbent: boolean | null; // friarBaseFee < incumbent_fee; null if no incumbent
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json() as Promise<T>;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok) throw new Error(json?.error ?? `${path}: ${res.status}`);
  return json as T;
}

export type BetaStatus = "approved" | "pending" | "rejected" | "none";

export interface BetaRequestPayload {
  address: string;
  discord: string;
  note?: string;
  signedAt: string;
  signature: string;
}

export const api = {
  allowed: (address: string) => get<{ allowed: boolean }>(`/allowed/${address}`),
  betaStatus: (address: string) => get<{ status: BetaStatus }>(`/beta/status/${address}`),
  betaRequest: (payload: BetaRequestPayload) => post<{ status: BetaStatus }>("/beta/request", payload),
  positions: (owner: string, opts?: { status?: "open" | "closed" | "all"; limit?: number; offset?: number }) => {
    const q = new URLSearchParams();
    if (opts?.status) q.set("status", opts.status);
    if (opts?.limit != null) q.set("limit", String(opts.limit));
    if (opts?.offset != null) q.set("offset", String(opts.offset));
    const qs = q.toString();
    return get<{ positions: ApiPosition[]; total: number; limit: number; offset: number }>(
      `/positions/${owner}${qs ? `?${qs}` : ""}`,
    );
  },
  // position ids are enumerable integers, so detail reads are owner-keyed (API 404s without it)
  position: (id: number, owner: string) => get<ApiPositionDetail>(`/position/${id}?owner=${owner}`),
  snapshots: (id: number, owner: string, from?: number) =>
    get<{ snapshots: ApiPositionDetail["latestSnapshot"][] }>(
      `/position/${id}/snapshots?owner=${owner}${from ? `&from=${from}` : ""}`,
    ),
  portfolioHistory: (owner: string) => get<{ history: PortfolioPoint[] }>(`/portfolio/${owner}/history`),
  // `points` downsamples server-side. The full 30d series is ~8,600 rows / 400KB, which is
  // wasted on any caller that just wants the ends of the curve.
  nav: (owner: string, days = 30, points?: number) =>
    get<{ owner: string; nav: Array<{ ts: number; liquid: string; positions: string; bags?: string; nav: string }> }>(
      `/portfolio/${owner}/nav?days=${days}${points ? `&points=${points}` : ""}`,
    ),
  /** Realized aggregates over EVERY closed position — the History tiles, which must not
   *  become page totals when the table under them is paged. */
  realized: (owner: string) =>
    get<{
      owner: string;
      closed: number;
      greens: number;
      avgHoldSeconds: number;
      pnlQuote: string;
      feesNetQuote: string;
      window30: { closes: number; netQuote: string; basisQuote: string };
    }>(`/portfolio/${owner}/realized`),
  pools: () => get<{ pools: ApiPool[] }>("/pools"),
  poolsWithLiquidity: () => get<{ pools: ApiPool[] }>("/pools?withLiquidity=1"),
  tokens: () => get<{ tokens: ApiToken[] }>("/tokens"),
  // One token by address, whether or not it's on the board. `token: null` means the
  // address is fine but no venue exists for it yet — the first-LP case, not an error.
  // `source` says whether the board already had it ("live" = folded on demand).
  token: (address: string) =>
    get<{ token: ApiToken | null; source: "board" | "live" }>(`/token/${address}`),
  rate: () => get<{ usdPerWeth: number | null }>("/rate"),
  // PnL share card — server-rendered PNG + the share URL that unfurls it
  cardUrl: (id: number, owner: string, opts: CardOpts) => `${BASE}/position/${id}/card.png?${cardParams(owner, opts)}`,
  shareUrl: (id: number, owner: string, opts: CardOpts) => `${BASE}/s/${id}?${cardParams(owner, opts)}`,
};

export interface CardOpts {
  metric: "percent" | "amount";
  denom: "WETH" | "USD";
  showAmounts: boolean;
}

function cardParams(owner: string, opts: CardOpts): string {
  const p = new URLSearchParams({ owner });
  if (opts.metric !== "percent") p.set("metric", opts.metric);
  if (opts.denom !== "WETH") p.set("denom", opts.denom);
  if (!opts.showAmounts) p.set("amounts", "0");
  return p.toString();
}

/** Compact USD formatter for market figures (vol / liq / mcap). */
export function fmtUsd(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return "—";
  const abs = Math.abs(v);
  if (abs >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
}

/** A fee tier in pips (10000 = 1%) → percent string, e.g. 5000 → "0.50%". */
export function fmtFeePct(pips: number | null): string {
  return pips == null ? "—" : `${(pips / 10_000).toFixed(2)}%`;
}

/** USD price, keeping precision on sub-cent memecoin prices. */
export function fmtPrice(v: number | null): string {
  if (v == null || !Number.isFinite(v) || v <= 0) return "—";
  if (v >= 1) return `$${v.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
  if (v >= 0.01) return `$${v.toFixed(4)}`;
  return `$${v.toPrecision(3)}`;
}

/** Signed percent, e.g. 4.2 → "+4.2%". */
export function fmtPct(v: number | null): string {
  return v == null || !Number.isFinite(v) ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
}

/** Format a raw token amount (arbitrary decimals) to a short display string. */
export function fmtAmount(v: string | bigint, decimals: number, digits = 4): string {
  const x = typeof v === "bigint" ? v : BigInt(v);
  const neg = x < 0n;
  const abs = neg ? -x : x;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = abs % base;
  const fracStr = digits > 0 && decimals > 0 ? "." + (frac + base).toString().slice(1, 1 + Math.min(digits, decimals)) : "";
  return `${neg ? "-" : ""}${whole}${fracStr}`;
}

/** Format a 1e18-scale quote value to a short display string. */
export function fmtQuote(v: string, digits = 4): string {
  const x = BigInt(v);
  const neg = x < 0n;
  const abs = neg ? -x : x;
  const whole = abs / 10n ** 18n;
  const frac = abs % 10n ** 18n;
  const fracStr = (frac + 10n ** 18n).toString().slice(1, 1 + digits);
  return `${neg ? "-" : ""}${whole}.${fracStr}`;
}
