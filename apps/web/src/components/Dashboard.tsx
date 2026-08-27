import { useQuery } from "@tanstack/react-query";
import { api } from "../api.js";
import { basisOf, pctOf, signClass } from "../format.js";
import { useMoney } from "../denom.js";
import { PositionCard } from "./PositionCard.js";
import { Sparkline } from "./PortfolioChart.js";
import { DOCS_START } from "../links.js";
import { track } from "../analytics.js";

export function Dashboard({
  owner,
  onSelect,
  onHistory,
  onTokens,
  onOpen,
}: {
  owner: string;
  onSelect: (id: number) => void;
  onHistory: () => void;
  onTokens: () => void;
  onOpen: () => void;
}) {
  const positions = useQuery({ queryKey: ["positions", owner, "open"], queryFn: () => api.positions(owner, { status: "open", limit: 100 }), refetchInterval: 15_000 });
  const history = useQuery({ queryKey: ["portfolio", owner], queryFn: () => api.portfolioHistory(owner) });
  const m = useMoney();

  if (positions.isLoading) return <div className="loading">loading positions…</div>;
  if (positions.isError)
    return (
      <div className="empty error">
        API error: {positions.error.message}
        <div className="dim mono" style={{ marginTop: "0.5rem", fontSize: 12 }}>
          check <code>npm run stack status</code> — friar-api should be on :8788
        </div>
      </div>
    );

  const list = positions.data?.positions ?? [];
  const open = list.filter((p) => p.closed_ts === null);
  const closed = list.filter((p) => p.closed_ts !== null);

  const agg = open.reduce(
    (a, p) => ({
      value: a.value + BigInt(p.summary.valueQuote),
      pnl: a.pnl + BigInt(p.summary.pnlQuote),
      fees: a.fees + BigInt(p.summary.feesNetQuote),
      inv: a.inv + BigInt(p.summary.inventoryQuote),
      basis: a.basis + basisOf(p.summary),
    }),
    { value: 0n, pnl: 0n, fees: 0n, inv: 0n, basis: 0n },
  );
  const banked = closed.reduce((a, p) => a + BigInt(p.summary.pnlQuote), 0n);

  return (
    <>
      <div className="page-head">
        <h1>Positions</h1>
      </div>

      <div className="tiles tiles-gauge">
        <div className="tile">
          <div className="tile-label">Portfolio value</div>
          <div className="tile-value">
            {m.fmt(agg.value)} <span className="tile-unit">{m.unit}</span>
          </div>
          {history.data && history.data.history.length > 1 && <Sparkline points={history.data.history} />}
        </div>

        <div className="tile">
          <div className="tile-label">Open PnL</div>
          <div className={`tile-value ${signClass(agg.pnl)}`}>{pctOf(agg.pnl, agg.basis)}</div>
          <div className="tile-sub">{m.signed(agg.pnl)} {m.unit}</div>
          <div className="tile-decomp">
            <span className="green">fees {pctOf(agg.fees, agg.basis)}</span>
            <span className="dim">·</span>
            <span className={signClass(agg.inv)}>inv {pctOf(agg.inv, agg.basis)}</span>
          </div>
        </div>

        <div className="tile">
          <div className="tile-label">Fees earned</div>
          <div className="tile-value green">
            {m.signed(agg.fees)} <span className="tile-unit">{m.unit}</span>
          </div>
        </div>

        <div className="tile">
          <div className="tile-label">Open positions</div>
          <div className="tile-value">{open.length}</div>
          <div className="tile-sub">
            {closed.length} closed · {list.length} all-time
          </div>
        </div>
      </div>

      {open.length === 0 ? (
        <div className="empty">
          <div>no open positions</div>
          <div style={{ display: "flex", gap: 10, justifyContent: "center", marginTop: 16 }}>
            <button className="btn" onClick={onTokens}>
              Browse tokens
            </button>
            <button className="btn btn-gold" onClick={onOpen}>
              + Open position
            </button>
          </div>
          {/* The one screen a first-time LP is guaranteed to see before they own anything —
              the only place in the app where "read this first" isn't in someone's way. */}
          <div className="attribution" style={{ marginTop: 14 }}>
            <a href={DOCS_START} target="_blank" rel="noreferrer" onClick={() => track("docs_click")}>
              new to this? read the guide ↗
            </a>
          </div>
        </div>
      ) : (
        <div className="card-list">
          {open.map((p) => (
            <PositionCard key={p.position_id} position={p} onClick={() => onSelect(p.position_id)} />
          ))}
        </div>
      )}

      {closed.length > 0 && (
        <button className="divider" onClick={onHistory}>
          History
          <span className="rule" />
          <span className="mono">
            {closed.length} closed · {m.signed(banked)} {m.unit} banked · view all
          </span>
        </button>
      )}
    </>
  );
}
