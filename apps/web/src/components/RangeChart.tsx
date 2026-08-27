import { useRef } from "react";
import { price1e18 } from "@friar/core";

const W = 700;
const H = 400;
const PAD_T = 14;
const PAD_B = 22;

export interface RangeBin {
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
  side?: "bid" | "ask" | "active";
}

/** "Draw the box" — the position range as a draggable gold box over a price axis in
 * %-from-current terms, with the planned liquidity distribution rendered as
 * horizontal bars (bids gold below, asks green above). Dragging a handle sets
 * % above / % below; the numeric inputs move the box. Two-way, single source of
 * truth = the % values in the parent form.
 *
 * TradingView Advanced Charts (candles + VPVR) slots in behind this later; the box
 * math and drag survive that swap. */
export function RangeChart({
  currentTick,
  quoteIs0,
  below,
  above,
  onBelow,
  onAbove,
  bins,
  sqrtPrice,
}: {
  currentTick: number | null;
  quoteIs0: boolean;
  below: number;
  above: number;
  onBelow: (n: number) => void;
  onAbove: (n: number) => void;
  bins: RangeBin[];
  sqrtPrice: bigint | null;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const dragging = useRef<null | "top" | "bottom">(null);

  const viewMax = Math.max(above * 1.35 + 3, 8);
  const viewMin = -Math.max(below * 1.35 + 3, 8);
  const span = viewMax - viewMin;
  const yFor = (pct: number) => PAD_T + (1 - (pct - viewMin) / span) * (H - PAD_T - PAD_B);

  const px = sqrtPrice ? price1e18(sqrtPrice) : null;
  const pctFor = (tick: number) => {
    if (currentTick === null) return 0;
    return ((quoteIs0 ? Math.pow(1.0001, currentTick - tick) : Math.pow(1.0001, tick - currentTick)) - 1) * 100;
  };

  // liquidity distribution bars (the fixed shape = L per bin, price-independent so the
  // drawn shape doesn't breathe as price moves), anchored to the right edge
  const model = bins
    .filter((b) => b.liquidity > 0n)
    .map((b) => ({ lo: pctFor(b.tickLower), hi: pctFor(b.tickUpper), v: b.liquidity, side: b.side }));
  const maxV = model.reduce((m, b) => (b.v > m ? b.v : m), 1n);

  const pctFromClientY = (clientY: number): number => {
    const rect = svgRef.current!.getBoundingClientRect();
    const rel = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
    return viewMax - rel * span;
  };
  const onMove = (e: React.PointerEvent) => {
    if (!dragging.current) return;
    const pct = pctFromClientY(e.clientY);
    if (dragging.current === "top") onAbove(Math.max(1, Math.min(300, Math.round(pct))));
    else onBelow(Math.max(1, Math.min(95, Math.round(-pct))));
  };
  const grab = (which: "top" | "bottom") => ({
    onPointerDown: (e: React.PointerEvent) => {
      dragging.current = which;
      (e.target as Element).setPointerCapture(e.pointerId);
    },
    onPointerMove: onMove,
    onPointerUp: (e: React.PointerEvent) => {
      dragging.current = null;
      (e.target as Element).releasePointerCapture(e.pointerId);
    },
  });

  const yTop = yFor(above);
  const yBot = yFor(-below);
  const yNow = yFor(0);
  const fmtPrice = (pct: number) => (px ? ((Number(px) / 1e18) * (1 + pct / 100)).toPrecision(4) : "");

  return (
    <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: "100%", height: H, display: "block" }}>
      {/* gridlines */}
      {[viewMax, viewMax / 2, 0, viewMin / 2, viewMin].map((pct, i) => (
        <g key={i}>
          <line x1="10" y1={yFor(pct)} x2={W - 90} y2={yFor(pct)} className="grid-line" />
          <text x={W - 84} y={yFor(pct) + 3} fill="var(--faint)" fontSize="10" fontFamily="IBM Plex Mono">
            {pct >= 0 ? "+" : "−"}
            {Math.abs(pct).toFixed(0)}%
          </text>
        </g>
      ))}

      {/* liquidity distribution bars */}
      {model.map((b, i) => {
        const w = (Number((b.v * 1000n) / maxV) / 1000) * 300;
        const y0 = yFor(Math.max(b.lo, b.hi));
        const y1 = yFor(Math.min(b.lo, b.hi));
        const active = Math.min(b.lo, b.hi) <= 0 && Math.max(b.lo, b.hi) >= 0;
        const cls = active ? "bin-mixed" : b.side === "ask" ? "bin-token" : "bin-quote";
        return <rect key={i} x={W - 90 - w} y={y0 + 0.5} width={w} height={Math.max(1.2, y1 - y0 - 1)} className={cls} rx="1" />;
      })}

      {/* range box */}
      <rect x="10" y={yTop} width={W - 100} height={Math.max(2, yBot - yTop)} fill="rgba(207,148,64,0.07)" stroke="var(--accent)" strokeWidth="1" strokeDasharray="5 4" />

      {/* current price line */}
      <line x1="10" y1={yNow} x2={W - 90} y2={yNow} stroke="var(--red)" strokeWidth="1" strokeDasharray="2 3" />
      <text x="14" y={yNow - 5} fill="var(--red)" fontSize="10" fontFamily="IBM Plex Mono">
        now{px ? ` · ${fmtPrice(0)}` : ""}
      </text>

      {/* edge labels */}
      <text x="14" y={yTop - 6} fill="var(--accent)" fontSize="10" fontFamily="IBM Plex Mono">
        +{above}%{px ? ` · ${fmtPrice(above)}` : ""}
      </text>
      <text x="14" y={yBot + 14} fill="var(--accent)" fontSize="10" fontFamily="IBM Plex Mono">
        −{below}%{px ? ` · ${fmtPrice(-below)}` : ""}
      </text>

      {/* drag handles — wide transparent hit zones so they're grabbable by touch;
          touch-action:none only here, so touching the rest of the chart still scrolls the page */}
      <rect x={W / 2 - 15} y={yTop - 3} width="30" height="6" rx="3" fill="var(--accent)" />
      <rect x={W / 2 - 15} y={yBot - 3} width="30" height="6" rx="3" fill="var(--accent)" />
      <rect x={W / 2 - 45} y={yTop - 16} width="90" height="32" fill="transparent" style={{ cursor: "ns-resize", touchAction: "none" }} {...grab("top")} />
      <rect x={W / 2 - 45} y={yBot - 16} width="90" height="32" fill="transparent" style={{ cursor: "ns-resize", touchAction: "none" }} {...grab("bottom")} />
    </svg>
  );
}
