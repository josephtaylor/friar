import { amountsForLiquidity, price1e18 } from "@friar/core";

const VBW = 1000; // viewBox width — preserveAspectRatio:none stretches to the container

export interface ChartBin {
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
}

export interface BinModel {
  bars: Array<{ x0: number; x1: number; v: number; kind: "quote" | "token" | "mixed" }>;
  markFrac: number | null; // [0,1] position of current price in user orientation
  leftPct: string;
  rightPct: string;
  // Absolute prices (quote per token) at each edge + at market, when decimals are known.
  leftPrice: string | null;
  rightPrice: string | null;
  markPrice: string | null;
  counts: { quote: number; token: number; mixed: number };
}

/** Compact price formatter: whole numbers get grouping; sub-1 prices get 3 sig figs. */
function fmtPrice(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "—";
  if (n >= 1000) return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
  if (n >= 1) return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return Number(n.toPrecision(3)).toString();
}

/** Value-per-bin model in normalized [0,1] space. X = user price (cheap left);
 * respects quoteIs0 (user price runs inverse to ticks when the quote is currency0).
 * Bars colored by composition at the current price: quote waiting / token held /
 * active (straddling). */
export function binModel(
  bins: ChartBin[],
  quoteIs0: boolean,
  sqrtPrice: bigint | null,
  currentTick: number | null,
  decimals?: { token: number; quote: number },
): BinModel | null {
  const live = bins.filter((b) => b.liquidity > 0n);
  if (!live.length) return null;
  const minT = Math.min(...live.map((b) => b.tickLower));
  const maxT = Math.max(...live.map((b) => b.tickUpper));
  const span = maxT - minT || 1;
  const px = sqrtPrice ? price1e18(sqrtPrice) : null;

  const counts = { quote: 0, token: 0, mixed: 0 };
  const vals = live.map((b) => {
    // Bar HEIGHT = the liquidity placed in the bin (L) — price-independent, so the shape you
    // created stays fixed and never "breathes" with price (Meteora convention: it's a
    // liquidity distribution, not a mark-to-market). Only the COLOR tracks live composition
    // (which side each bin currently holds); L itself changes only when you add/remove.
    let kind: "quote" | "token" | "mixed" = "quote";
    if (sqrtPrice && px && px > 0n) {
      const a = amountsForLiquidity(sqrtPrice, b.tickLower, b.tickUpper, b.liquidity);
      const q = quoteIs0 ? a.amount0 : a.amount1;
      const t = quoteIs0 ? a.amount1 : a.amount0;
      kind = q > 0n && t > 0n ? "mixed" : t > 0n ? "token" : "quote";
    }
    counts[kind]++;
    return { v: b.liquidity, kind, lo: b.tickLower, hi: b.tickUpper };
  });
  const maxV = vals.reduce((m, b) => (b.v > m ? b.v : m), 1n);

  const tickToFrac = (t: number) => {
    const f = (t - minT) / span;
    return quoteIs0 ? 1 - f : f;
  };
  const bars = vals.map((b) => {
    const f1 = tickToFrac(b.lo);
    const f2 = tickToFrac(b.hi);
    return {
      x0: Math.min(f1, f2),
      x1: Math.max(f1, f2),
      v: Number((b.v * 1000n) / maxV) / 1000,
      kind: b.kind,
    };
  });
  const markFrac = currentTick === null ? null : Math.max(0, Math.min(1, tickToFrac(currentTick)));

  const pctAt = (t: number) => {
    if (currentTick === null) return "";
    const r = (quoteIs0 ? Math.pow(1.0001, currentTick - t) : Math.pow(1.0001, t - currentTick)) - 1;
    return `${r >= 0 ? "+" : "−"}${Math.abs(r * 100).toFixed(0)}%`;
  };
  const leftEdge = quoteIs0 ? maxT : minT;
  const rightEdge = quoteIs0 ? minT : maxT;

  // Absolute quote-per-token prices, when we know both sides' decimals. The pool encodes
  // currency1_raw/currency0_raw; convert to a human price the same way the seeder does.
  let leftPrice: string | null = null;
  let rightPrice: string | null = null;
  let markPrice: string | null = null;
  if (decimals) {
    const decFactor = 10 ** (decimals.token - decimals.quote);
    const priceAtTick = (t: number) => {
      const pp = Math.pow(1.0001, t); // currency1_raw per currency0_raw
      return quoteIs0 ? decFactor / pp : pp * decFactor; // quote per whole token
    };
    leftPrice = fmtPrice(priceAtTick(leftEdge));
    rightPrice = fmtPrice(priceAtTick(rightEdge));
    if (px && px > 0n) {
      const pp = Number(px) / 1e18;
      markPrice = fmtPrice(quoteIs0 ? decFactor / pp : pp * decFactor);
    }
  }

  return { bars, markFrac, leftPct: pctAt(leftEdge), rightPct: pctAt(rightEdge), leftPrice, rightPrice, markPrice, counts };
}

/** Bars + live-price line only, at a given pixel height. For cards / mobile. */
export function BinBars({ model, height, rx = 1.5 }: { model: BinModel; height: number; rx?: number }) {
  const usableH = height - 2;
  return (
    <svg viewBox={`0 0 ${VBW} ${height}`} preserveAspectRatio="none" style={{ width: "100%", height, display: "block" }}>
      {model.bars.map((b, i) => {
        const h = Math.max(2, b.v * usableH);
        return (
          <rect
            key={i}
            x={b.x0 * VBW + 0.5}
            y={height - h}
            width={Math.max(1, (b.x1 - b.x0) * VBW - 1)}
            height={h}
            rx={rx}
            className={`bin-${b.kind}`}
          />
        );
      })}
      {model.markFrac !== null && (
        <line x1={model.markFrac * VBW} y1={0} x2={model.markFrac * VBW} y2={height} className="bin-markline" />
      )}
    </svg>
  );
}

/** THE visual: liquidity-per-bin histogram in a card, with legend + edge % labels and
 * the red ▼ market-price line. Bar height is the fixed liquidity shape; color tracks live
 * composition. Detail screen + open-position preview. */
export function BinChart({
  bins,
  quoteIs0,
  currentTick,
  sqrtPrice,
  height = 140,
  title = "liquidity per bin",
  tokenDecimals,
  quoteDecimals,
  quoteSym,
}: {
  bins: ChartBin[];
  quoteIs0: boolean;
  currentTick: number | null;
  sqrtPrice: bigint | null;
  height?: number;
  title?: string;
  tokenDecimals?: number;
  quoteDecimals?: number;
  quoteSym?: string;
}) {
  const decimals = tokenDecimals !== undefined && quoteDecimals !== undefined ? { token: tokenDecimals, quote: quoteDecimals } : undefined;
  const model = binModel(bins, quoteIs0, sqrtPrice, currentTick, decimals);
  if (!model) return null;
  const c = model.counts;
  const edge = (pct: string, price: string | null) =>
    price ? (
      <>
        {pct} <span className="axis-price">{price}</span>
      </>
    ) : (
      pct
    );
  return (
    <div className="card-box binchart">
      <div className="binchart-head">
        <span className="chart-legend">
          {title} — <span className="sq sw-quote" />quote waiting · <span className="sq sw-token" />token held ·{" "}
          <span className="sq sw-active" />active
        </span>
        <span>
          {c.quote} waiting / {c.mixed} active / {c.token} token
        </span>
      </div>
      <BinBars model={model} height={height} rx={2} />
      <div className="card-axis" style={{ marginTop: 8 }}>
        <span>{edge(model.leftPct, model.leftPrice)}</span>
        {model.markFrac !== null && (
          <span className="red">
            ▼ {model.markPrice ? `${model.markPrice}${quoteSym ? ` ${quoteSym}` : ""}` : "market price"}
          </span>
        )}
        <span>{edge(model.rightPct, model.rightPrice)}</span>
      </div>
    </div>
  );
}
