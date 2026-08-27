// The Tithe — shareable PnL card (design handoff 2026-07-21, frames 6a/6b/6c).
// Pure: turns a position summary into card strings, and card strings into an SVG.
// Rasterization (fonts, wasm) lives in render.ts so tests can import this alone.
//
// Content rules from the handoff:
// - Default hero = percent; amounts are opt-in and can be hidden entirely.
// - WETH amount heroes render the BARE signed number, unit moves to the sub-line.
// - Fees are ALWAYS net of the perf fee (feesNetQuote) — never gross.
// - Never show strategy: pair, duration, PnL, fees, fee-environment only.

export type CardMetric = "percent" | "amount";
export type CardDenom = "WETH" | "USD";

export interface CardInput {
  symbol: string; // base token symbol, e.g. CASHCAT
  quoteSym: string; // WETH | USDG
  quoteDecimals: number; // 18 for WETH, 6 for USDG
  open: boolean;
  openedTs: number; // unix seconds
  closedTs: number | null;
  now: number; // unix seconds — passed in so output is deterministic
  pnlQuote: bigint; // raw quote units
  feesNetQuote: bigint; // raw quote units, net of perf fee
  basisQuote: bigint; // invested (else |cashflow|) — the percent denominator
  usdPerQuote: number | null; // USD per quote token (for denom=USD on WETH pools)
  metric: CardMetric;
  denom: CardDenom;
  showAmounts: boolean;
  feeAvgPips: number | null; // avg dynamic fee over the position window
  feeNowPips: number | null; // recent fee (open positions)
  feeSurge: boolean; // fee now meaningfully above the calm floor
  /** pool identity — base fee (pips) + bin width (tick spacing); optional so foreign
   * hooks (no derivable base fee) just omit the footer part */
  baseFeePips?: number | null;
  tickSpacing?: number | null;
}

export interface CardData {
  symbol: string;
  quoteSym: string;
  live: boolean;
  timeStr: string; // "time 05:02:24"
  hero: string;
  heroColor: string;
  sub: string;
  fees: string; // "fees +12.14% · $145"
  footerFee: string | null; // "dynamic fee avg 0.62%" | "fee now 0.87%" | null
  footerFeeSurge: boolean; // append "▲ surge" (the ▲ is drawn — Plex Mono lacks U+25B2)
  footerFeeGold: boolean;
  /** "5% base · 1.0% bins" — the pool's immutable identity; null when unknown */
  footerPool: string | null;
  footerDates: string; // "Jul 8 → Jul 13" | "opened Jul 15"
  lossGlow: boolean;
}

const GOLD = "#cf9440";
const GAIN = "#8fbf5f";
const LOSS = "#e05d52";
const TEXT = "#ece3d2";
const DIM = "#8a7a5f";
const BG = "#100c07";
const MINUS = "−";

/** Signed percent vs basis, unicode minus, e.g. "+9.41%" / "−7.20%". */
export function cardPct(v: bigint, basis: bigint): string {
  if (basis <= 0n) return "—";
  const bps = Number((v * 10_000n) / basis) / 100;
  return `${bps >= 0 ? "+" : MINUS}${Math.abs(bps).toFixed(2)}%`;
}

/** Quote amount → decimal number string (no sign, no unit), 4dp like the mock. */
function quoteMagnitude(v: bigint, decimals: number, dp = 4): string {
  const abs = v < 0n ? -v : v;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = decimals > 0 ? "." + (((abs % base) * 10n ** BigInt(dp)) / base).toString().padStart(dp, "0") : "";
  return `${whole}${frac}`;
}

/** USD magnitude: integers ≥ $1 (the mock's "$145"), 2dp under a dollar. */
function usdMagnitude(v: bigint, decimals: number, rate: number): string {
  const usd = Math.abs(Number(v) / 10 ** decimals) * rate;
  if (usd >= 1) return Math.round(usd).toLocaleString("en-US");
  return usd.toFixed(2);
}

const sign = (v: bigint): string => (v < 0n ? MINUS : "+");

/** "time DD:HH:MM", two digits each — position duration / current age. */
export function cardDuration(seconds: number): string {
  const s = Math.max(0, seconds);
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `time ${p(d)}:${p(h)}:${p(m)}`;
}

const fmtDay = (ts: number): string =>
  new Date(ts * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

const fmtFeePips = (pips: number): string => `${(pips / 10_000).toFixed(2)}%`;

export function buildCardData(inp: CardInput): CardData {
  const dollarQuote = inp.quoteSym !== "WETH"; // USDG pools are natively dollar-quoted
  // USD view needs a rate on WETH pools; without one, fall back to WETH amounts
  const usd = dollarQuote || (inp.denom === "USD" && inp.usdPerQuote != null);
  const rate = dollarQuote ? 1 : (inp.usdPerQuote ?? 0);

  const pct = cardPct(inp.pnlQuote, inp.basisQuote);
  const amtHero = usd
    ? `${sign(inp.pnlQuote)}$${usdMagnitude(inp.pnlQuote, inp.quoteDecimals, rate)}`
    : `${sign(inp.pnlQuote)}${quoteMagnitude(inp.pnlQuote, inp.quoteDecimals)}`;
  const amtSub = usd ? amtHero : `${amtHero} ${inp.quoteSym}`;
  const feesAmt = usd
    ? `$${usdMagnitude(inp.feesNetQuote, inp.quoteDecimals, rate)}`
    : `${quoteMagnitude(inp.feesNetQuote, inp.quoteDecimals)} ${inp.quoteSym}`;

  const tag = inp.open ? "unrealized · marked to market" : "realized";
  const heroIsAmt = inp.metric === "amount" && inp.showAmounts;
  const hero = heroIsAmt ? amtHero : pct;
  // WETH amount heroes are bare numbers — the unit leads the sub-line instead
  const sub = heroIsAmt
    ? usd
      ? `${pct} · ${tag}`
      : `${inp.quoteSym} · ${pct} · ${tag}`
    : inp.showAmounts
      ? `${amtSub} · ${tag}`
      : tag;

  const fees = `fees ${cardPct(inp.feesNetQuote, inp.basisQuote)}${inp.showAmounts ? ` · ${feesAmt}` : ""}`;

  let footerFee: string | null = null;
  let footerFeeSurge = false;
  let footerFeeGold = false;
  if (inp.open && inp.feeNowPips != null) {
    footerFee = `fee now ${fmtFeePips(inp.feeNowPips)}`;
    footerFeeSurge = inp.feeSurge;
    footerFeeGold = inp.feeSurge;
  } else if (inp.feeAvgPips != null) {
    footerFee = `dynamic fee avg ${fmtFeePips(inp.feeAvgPips)}`;
  }

  const footerDates = inp.open
    ? `opened ${fmtDay(inp.openedTs)}`
    : `${fmtDay(inp.openedTs)} → ${fmtDay(inp.closedTs ?? inp.now)}`;

  return {
    symbol: inp.symbol,
    quoteSym: inp.quoteSym,
    live: inp.open,
    timeStr: cardDuration((inp.open ? inp.now : (inp.closedTs ?? inp.now)) - inp.openedTs),
    hero,
    heroColor: inp.pnlQuote < 0n ? LOSS : GAIN,
    sub,
    fees,
    footerFee,
    footerFeeSurge,
    footerFeeGold,
    footerPool:
      inp.baseFeePips && inp.tickSpacing
        ? `${(inp.baseFeePips / 10_000).toFixed(inp.baseFeePips % 10_000 === 0 ? 0 : 1)}% base · ${(inp.tickSpacing / 100).toFixed(1)}% bins`
        : null,
    footerDates,
    lossGlow: inp.pnlQuote < 0n,
  };
}

// ── fee-environment stats from candle rows ─────────────────────────────────

export interface FeeCandle {
  ts: number;
  fee_sum: number | null;
  fee_n: number | null;
  fee_max: number | null;
}

/** avg over the window + recent "fee now" (last 30 min with swaps, else last candle). */
export function feeStats(
  candles: FeeCandle[],
  now: number,
  floorPips: number,
): { avgPips: number | null; nowPips: number | null; surge: boolean } {
  let sum = 0;
  let n = 0;
  const recent = candles.filter((c) => (c.fee_n ?? 0) > 0);
  for (const c of recent) {
    sum += c.fee_sum ?? 0;
    n += c.fee_n ?? 0;
  }
  const avgPips = n > 0 ? Math.round(sum / n) : null;
  const last = recent.at(-1);
  // "now" only if there was a swap in the last 30 min — a stale fee isn't "now"
  const nowPips = last && now - last.ts <= 1800 ? Math.round((last.fee_sum ?? 0) / (last.fee_n ?? 1)) : null;
  // the dynamic fee only surges ABOVE the calm floor; 20% over = visibly surging
  const surge = nowPips != null && floorPips > 0 && nowPips >= floorPips * 1.2;
  return { avgPips, nowPips, surge };
}

// ── SVG ────────────────────────────────────────────────────────────────────

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const MONO = "IBM Plex Mono";
const SANS = "IBM Plex Sans";
// IBM Plex Mono is exactly 600/1000 em wide per glyph — widths are deterministic
const monoW = (chars: number, size: number, ls = 0): number => chars * size * 0.6 + Math.max(0, chars - 1) * ls;

// Plex Sans is not — coarse per-char width classes keep the pair row from colliding
const sansCharW = (ch: string): number =>
  /[ijl.!'|]/.test(ch) ? 0.32 : /[Ift\/ ]/.test(ch) ? 0.42 : /[rJ1]/.test(ch) ? 0.5 : /[mMW@]/.test(ch) ? 0.95 : /[w%]/.test(ch) ? 0.82 : 0.64;
const sansW = (s: string, size: number): number => [...s].reduce((w, ch) => w + sansCharW(ch) * size, 0);

/**
 * The card at 1200×630. Layout constants transcribed from the 6x frames; vertical
 * placement mirrors the mock's flexbox (brand row pinned top, footer pinned bottom,
 * hero block centered between them).
 */
export function cardSvg(d: CardData, monkDataUri: string | null): string {
  const W = 1200;
  const H = 630;
  const PAD = 48;

  // hero font shrinks only when a huge USD figure would collide with the mascot
  const heroSize = d.hero.length > 9 ? Math.floor((140 * 9) / d.hero.length) : 140;

  // vertical rhythm: content block ≈ [pair 52][6][hero 151][6][sub 34][10+28 fees],
  // centered between brand row (bottom ≈ 66) and footer top (≈ 574) → center 320
  const CENTER = 320;
  const heroH = Math.round(heroSize * 1.08);
  const blockH = 52 + 6 + heroH + 6 + 34 + 10 + 28;
  const top = CENTER - blockH / 2;
  const pairBase = Math.round(top + 40); // 38px text baseline
  const heroBase = Math.round(top + 52 + 6 + heroH * 0.82);
  const subBase = Math.round(top + 52 + 6 + heroH + 6 + 26);
  const feesBase = subBase + 10 + 28;

  const glowSolid = d.lossGlow ? "#e05d52" : "#cf9440";
  const glowOpacity = d.lossGlow ? 0.06 : 0.08;

  // mascot: 500px circle, vertically centered, bleeding off at right:-80px
  const MR = 250;
  const mcx = W + 80 - MR;
  const mcy = H / 2;

  // pair row x-offsets (baseline-aligned, 12px gaps)
  const symbol = esc(d.symbol.slice(0, 14));
  const quoteX = PAD + sansW(d.symbol.slice(0, 14), 38) + 12;
  const quoteW = sansW(`/ ${d.quoteSym}`, 25);
  const timeX = quoteX + quoteW + 12;

  // LIVE chip (right-aligned in the brand row): mono 12px, ls 1.2, padding 3x10
  const chipTextW = monoW(4, 12, 1.2);
  const chipW = Math.round(chipTextW + 20);
  const chipX = W - PAD - chipW;

  // footer: friar.fi · [fee stat ·] dates, 26px gaps, mono 14
  const fY = H - 38 - 4; // 14px mono baseline ≈ 4px above the bottom padding edge
  const parts: Array<{ t: string; c: string; surge?: boolean }> = [{ t: "friar.fi", c: GOLD }];
  if (d.footerFee) parts.push({ t: d.footerFee, c: d.footerFeeGold ? GOLD : DIM, surge: d.footerFeeSurge });
  if (d.footerPool) parts.push({ t: d.footerPool, c: DIM });
  parts.push({ t: d.footerDates, c: DIM });
  let fx = PAD;
  const footer: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    if (i > 0) {
      footer.push(`<text x="${fx}" y="${fY}" font-family="${MONO}" font-size="14" fill="${DIM}">·</text>`);
      fx += monoW(1, 14) + 26;
    }
    footer.push(`<text x="${fx}" y="${fY}" font-family="${MONO}" font-size="14" fill="${esc(p.c)}">${esc(p.t)}</text>`);
    fx += monoW(p.t.length, 14);
    if (p.surge) {
      // "▲ surge" — the triangle is a path (Plex Mono has no U+25B2 glyph)
      fx += 8;
      footer.push(`<path d="M ${fx} ${fY} l 10 0 l -5 -9 z" fill="${esc(p.c)}"/>`);
      fx += 10 + 8;
      footer.push(`<text x="${fx}" y="${fY}" font-family="${MONO}" font-size="14" fill="${esc(p.c)}">surge</text>`);
      fx += monoW(5, 14);
    }
    fx += 26;
  }

  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
  <defs>
    <radialGradient id="glow"><stop offset="0" stop-color="${glowSolid}" stop-opacity="${glowOpacity}"/><stop offset="0.55" stop-color="${glowSolid}" stop-opacity="${glowOpacity}"/><stop offset="1" stop-color="${glowSolid}" stop-opacity="0"/></radialGradient>
    <clipPath id="monkClip"><circle cx="${mcx}" cy="${mcy}" r="${MR}"/></clipPath>
  </defs>
  <rect width="${W}" height="${H}" fill="${BG}"/>
  <circle cx="${mcx}" cy="${mcy}" r="${MR + 200}" fill="url(#glow)"/>
  ${monkDataUri ? `<image x="${mcx - MR}" y="${mcy - MR}" width="${MR * 2}" height="${MR * 2}" opacity="0.55" clip-path="url(#monkClip)" xlink:href="${monkDataUri}"/>` : ""}
  <text x="${PAD}" y="56" font-family="${MONO}" font-weight="600" font-size="20" letter-spacing="4.4" fill="${GOLD}">FRIAR</text>
  <text x="${PAD + monoW(5, 20, 4.4) + 16}" y="56" font-family="${MONO}" font-size="13" fill="${DIM}">dynamic-fee liquidity on robinhood</text>
  ${
    d.live
      ? `<rect x="${chipX}" y="40" width="${chipW}" height="21" rx="4" fill="none" stroke="${GAIN}" stroke-width="1"/>
  <text x="${chipX + 10}" y="55" font-family="${MONO}" font-size="12" letter-spacing="1.2" fill="${GAIN}">LIVE</text>`
      : ""
  }
  <text x="${PAD}" y="${pairBase}" font-family="${SANS}" font-weight="600" font-size="38" fill="${TEXT}">${symbol}</text>
  <text x="${quoteX}" y="${pairBase}" font-family="${SANS}" font-size="25" fill="${DIM}">/ ${esc(d.quoteSym)}</text>
  <text x="${timeX}" y="${pairBase}" font-family="${MONO}" font-size="16" fill="${DIM}">${esc(d.timeStr)}</text>
  <text x="${PAD}" y="${heroBase}" font-family="${MONO}" font-weight="600" font-size="${heroSize}" letter-spacing="${(heroSize * -0.02).toFixed(2)}" fill="${d.heroColor}">${esc(d.hero)}</text>
  <text x="${PAD}" y="${subBase}" font-family="${MONO}" font-size="25" fill="${TEXT}">${esc(d.sub)}</text>
  <text x="${PAD}" y="${feesBase}" font-family="${MONO}" font-size="20" fill="${GAIN}">${esc(d.fees)}</text>
  ${footer.join("\n  ")}
</svg>`;
}
