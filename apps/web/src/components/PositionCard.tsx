import { useQuery } from "@tanstack/react-query";
import { getTickAtSqrtPrice } from "@friar/core";
import { api, type ApiPosition } from "../api.js";
import { splitPair, useTokenSymbol, shortAddr } from "../tokens.js";
import { basisOf, pctOf, signClass, fmtAge } from "../format.js";
import { useMoney } from "../denom.js";
import { binModel, BinBars } from "./BinChart.js";
import { rangeInfo, statusChip, breachText } from "../range.js";

/** Dashboard position card (frame 1a): symbol + id · bin histogram + breach axis ·
 * %-first PnL column. Pulls the position detail for bins + snapshot price. */
export function PositionCard({
  position,
  onClick,
  closed,
}: {
  position: ApiPosition;
  onClick: () => void;
  closed?: boolean;
}) {
  const { token, quoteSym, quoteIs0 } = splitPair(position.currency0, position.currency1);
  const sym = useTokenSymbol(token);
  // owner-keyed like all detail reads; key matches PositionDetail's so the cache is shared
  const detail = useQuery({
    queryKey: ["position", position.position_id, position.owner.toLowerCase()],
    queryFn: () => api.position(position.position_id, position.owner.toLowerCase()),
    staleTime: 10_000,
  });
  const s = position.summary;
  const basis = basisOf(s);
  const m = useMoney();
  const marking = s.markedAt === null && position.closed_ts === null;

  const d = detail.data;
  const sqrtPrice = d?.latestSnapshot?.market_sqrt_price
    ? BigInt(d.latestSnapshot.market_sqrt_price)
    : d?.latestSnapshot
      ? BigInt(d.latestSnapshot.sqrt_price)
      : null;
  const tick = sqrtPrice ? getTickAtSqrtPrice(sqrtPrice) : null;
  const bins = d ? d.bins.map((b) => ({ tickLower: b.tick_lower, tickUpper: b.tick_upper, liquidity: BigInt(b.liquidity) })) : [];
  const model = bins.length ? binModel(bins, quoteIs0, sqrtPrice, tick) : null;
  const r = d ? rangeInfo(d, null) : null;
  const chip = statusChip(r?.status ?? null, closed);
  const liveBins = d ? d.bins.filter((b) => b.liquidity !== "0").length : null;
  const age = fmtAge((closed && position.closed_ts ? position.closed_ts : Math.floor(Date.now() / 1000)) - position.opened_ts);

  return (
    <button className={`pos-card ${closed ? "closed" : ""}`} onClick={onClick}>
      <div>
        <div className="card-sym">
          <b>{sym.data?.symbol ?? shortAddr(token)}</b>
          <span className="card-q">/ {quoteSym}</span>
          <span className="card-id">#{position.position_id}</span>
        </div>
        <div className="card-meta">
          {liveBins !== null ? `${liveBins} bins` : "… bins"} · {closed ? `lived ${age}` : `open ${age}`}
        </div>
        {(r || closed) && <span className={`chip ${chip.cls}`} style={{ marginTop: 10 }}>{chip.label}</span>}
      </div>

      <div>
        {model ? <BinBars model={model} height={64} /> : <div style={{ height: 64 }} />}
        <div className="card-axis">
          <span>{model?.leftPct ?? ""}</span>
          <span>{r ? breachText(r) : ""}</span>
          <span>{model?.rightPct ?? ""}</span>
        </div>
      </div>

      <div className="card-right">
        {marking ? (
          <div className="card-pnl dim">marking…</div>
        ) : (
          <>
            <div className={`card-pnl ${signClass(s.pnlQuote)}`}>{pctOf(s.pnlQuote, basis)}</div>
            <div className="card-pnl-sub">{m.signed(s.pnlQuote)} {m.unit}</div>
            <div className="card-fees">
              <span className="green">fees {pctOf(s.feesNetQuote, basis)}</span>{" "}
              <span className="dim">· inv {pctOf(s.inventoryQuote, basis)}</span>
            </div>
            <div className="card-val">value {m.fmt(s.valueQuote)} {m.unit}</div>
          </>
        )}
      </div>
    </button>
  );
}
