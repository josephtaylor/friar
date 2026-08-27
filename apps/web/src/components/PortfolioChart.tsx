import type { PortfolioPoint } from "../api.js";

/** Gold sparkline of the portfolio value snapshot series — lives inside the
 * "Portfolio value" tile. Custom SVG (lightweight-charts is reserved for real
 * price charts). */
export function Sparkline({ points, height = 34 }: { points: PortfolioPoint[]; height?: number }) {
  const W = 268;
  const H = height;
  if (points.length < 2) return <div className="tile-spark" />;
  const values = points.map((p) => Number(BigInt(p.valueQuote) / 10n ** 9n) / 1e9);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const xs = points.map((_, i) => (i / (points.length - 1)) * W);
  const ys = values.map((v) => H - 3 - ((v - min) / span) * (H - 6));
  const line = xs.map((x, i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${ys[i]!.toFixed(1)}`).join(" ");
  return (
    <svg className="tile-spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
      <path d={`${line} L${W},${H} L0,${H} Z`} fill="var(--gold-bg)" />
      <path d={line} fill="none" stroke="var(--accent)" strokeWidth="1.3" />
    </svg>
  );
}
