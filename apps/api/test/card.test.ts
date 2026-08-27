import { test, expect } from "vitest";
import { buildCardData, cardDuration, cardPct, cardSvg, feeStats, type CardInput } from "../src/card.js";

const E18 = 10n ** 18n;
const eth = (n: number): bigint => BigInt(Math.round(n * 1e9)) * 10n ** 9n;
const jul = (day: number, plusSec = 0): number => Math.floor(Date.UTC(2026, 6, day) / 1000) + plusSec;

// the handoff's 6a sample: PEANUT closed win, basis 1 WETH so percents read directly
const win: CardInput = {
  symbol: "PEANUT",
  quoteSym: "WETH",
  quoteDecimals: 18,
  open: false,
  openedTs: jul(8),
  closedTs: jul(13, 2 * 3600 + 24 * 60),
  now: jul(15),
  pnlQuote: eth(0.0941),
  feesNetQuote: eth(0.1214),
  basisQuote: E18,
  usdPerQuote: 3600,
  metric: "percent",
  denom: "WETH",
  showAmounts: true,
  feeAvgPips: 6200,
  feeNowPips: null,
  feeSurge: false,
};

test("card: default hero is percent, amounts ride the sub-line", () => {
  const d = buildCardData(win);
  expect(d.hero).toBe("+9.41%");
  expect(d.sub).toBe("+0.0941 WETH · realized");
  expect(d.fees).toBe("fees +12.14% · 0.1214 WETH");
  expect(d.heroColor).toBe("#8fbf5f");
  expect(d.live).toBe(false);
  expect(d.timeStr).toBe("time 05:02:24");
  expect(d.footerFee).toBe("dynamic fee avg 0.62%");
  expect(d.footerDates).toBe("Jul 8 → Jul 13");
});

test("card: WETH amount hero is the BARE number — unit moves to the sub-line", () => {
  const d = buildCardData({ ...win, metric: "amount" });
  expect(d.hero).toBe("+0.0941"); // never "+0.0941 WETH" in the hero slot
  expect(d.sub).toBe("WETH · +9.41% · realized");
});

test("card: USD hero keeps the $ and drops the unit from the sub-line", () => {
  const d = buildCardData({ ...win, metric: "amount", denom: "USD" });
  expect(d.hero).toBe("+$339");
  expect(d.sub).toBe("+9.41% · realized");
  expect(d.fees).toBe("fees +12.14% · $437");
});

test("card: amounts off = percent-only card, even when metric asked for amount", () => {
  const d = buildCardData({ ...win, metric: "amount", showAmounts: false });
  expect(d.hero).toBe("+9.41%");
  expect(d.sub).toBe("realized");
  expect(d.fees).toBe("fees +12.14%");
});

test("card: USD denom without a rate falls back to WETH amounts", () => {
  const d = buildCardData({ ...win, denom: "USD", usdPerQuote: null });
  expect(d.sub).toBe("+0.0941 WETH · realized");
});

test("card: USDG-quoted pools are natively dollars (6 decimals), rate ignored", () => {
  const d = buildCardData({
    ...win,
    quoteSym: "USDG",
    quoteDecimals: 6,
    usdPerQuote: null,
    metric: "amount",
    pnlQuote: 112_000_000n, // $112 in 6-dec USDG
    feesNetQuote: 145_000_000n,
    basisQuote: 1_190_000_000n,
  });
  expect(d.hero).toBe("+$112");
  expect(d.fees).toMatch(/\$145$/);
});

test("card: losses render unsoftened, red hero + red glow, fee line stays a gain", () => {
  const d = buildCardData({ ...win, pnlQuote: -eth(0.072), feesNetQuote: eth(0.0115) });
  expect(d.hero).toBe("−7.20%"); // unicode minus
  expect(d.heroColor).toBe("#e05d52");
  expect(d.lossGlow).toBe(true);
  expect(d.fees).toBe("fees +1.15% · 0.0115 WETH");
});

test("card: open position — LIVE, unrealized tag, fee-now footer with surge", () => {
  const d = buildCardData({
    ...win,
    open: true,
    closedTs: null,
    openedTs: jul(15),
    now: jul(17, 7 * 3600 + 12 * 60),
    feeNowPips: 8700,
    feeSurge: true,
  });
  expect(d.live).toBe(true);
  expect(d.sub).toBe("+0.0941 WETH · unrealized · marked to market");
  expect(d.timeStr).toBe("time 02:07:12");
  expect(d.footerFee).toBe("fee now 0.87%");
  expect(d.footerFeeSurge).toBe(true);
  expect(d.footerFeeGold).toBe(true);
  expect(d.footerDates).toBe("opened Jul 15");
});

test("card: open without recent swaps falls back to the window average, not gold", () => {
  const d = buildCardData({ ...win, open: true, closedTs: null, feeNowPips: null, feeAvgPips: 7100 });
  expect(d.footerFee).toBe("dynamic fee avg 0.71%");
  expect(d.footerFeeGold).toBe(false);
});

test("card: no fee data at all drops the footer segment (friar.fi + dates remain)", () => {
  const d = buildCardData({ ...win, feeAvgPips: null });
  expect(d.footerFee).toBeNull();
  const svg = cardSvg(d, null);
  expect(svg).toContain("friar.fi");
  expect(svg).toContain("Jul 8 → Jul 13");
});

test("cardPct/cardDuration edge cases", () => {
  expect(cardPct(0n, E18)).toBe("+0.00%");
  expect(cardPct(E18, 0n)).toBe("—");
  expect(cardDuration(0)).toBe("time 00:00:00");
  expect(cardDuration(59)).toBe("time 00:00:00");
  expect(cardDuration(100 * 86_400)).toBe("time 100:00:00");
});

test("feeStats: window average, recency-gated fee-now, floor-gated surge", () => {
  const now = 10_000;
  const candles = [
    { ts: 1000, fee_sum: 30_000, fee_n: 5, fee_max: 7000 },
    { ts: 9000, fee_sum: 18_000, fee_n: 2, fee_max: 9500 },
  ];
  const s = feeStats(candles, now, 5000);
  expect(s.avgPips).toBe(Math.round(48_000 / 7));
  expect(s.nowPips).toBe(9000); // last candle avg, 1000s old → fresh
  expect(s.surge).toBe(true); // 9000 ≥ 5000 × 1.2

  // stale last candle → no "fee now"; pre-migration NULL fee columns → no stats
  expect(feeStats([{ ts: 1000, fee_sum: 30_000, fee_n: 5, fee_max: 7000 }], now, 5000).nowPips).toBeNull();
  expect(feeStats([{ ts: 9000, fee_sum: null, fee_n: null, fee_max: null }], now, 5000)).toEqual({
    avgPips: null,
    nowPips: null,
    surge: false,
  });
  // non-Friar pool (floor 0) never surges
  expect(feeStats(candles, now, 0).surge).toBe(false);
});

test("cardSvg: escapes hostile symbols and renders every card line", () => {
  const d = buildCardData({ ...win, symbol: 'A<b>&"x' });
  const svg = cardSvg(d, null);
  expect(svg).not.toContain("<b>");
  expect(svg).toContain("A&lt;b&gt;&amp;");
  for (const s of [d.hero, d.sub, d.fees, d.timeStr, "FRIAR", "friar.fi"]) expect(svg).toContain(esc(s));
  // no monk data URI passed → no <image>, glow circle still there
  expect(svg).not.toContain("<image");
  expect(svg).toContain("url(#glow)");
});

test("cardSvg: huge USD heroes shrink instead of overflowing", () => {
  const d = buildCardData({
    ...win,
    metric: "amount",
    denom: "USD",
    pnlQuote: eth(43_219), // +$155,588,400 at 3600 — 13 chars
  });
  const svg = cardSvg(d, null);
  const m = svg.match(/font-size="(\d+)" letter-spacing="[^"]*" fill="#8fbf5f"/);
  expect(m).not.toBeNull();
  expect(Number(m![1])).toBeLessThan(116);
});

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
