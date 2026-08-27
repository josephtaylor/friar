import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useBalance, useReadContract } from "wagmi";
import { erc20Abi } from "viem";
import { ADDRESSES } from "@friar/chain";
import { api, fmtQuote, type ApiPosition } from "../api.js";
import { splitPair, useTokenSymbol, shortAddr } from "../tokens.js";
import { basisOf, pctOf, signClass, fmtAge } from "../format.js";
import { useMoney } from "../denom.js";

function shortDate(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** How many closes the table shows at once. 25 answers in ~0.4s against api.friar.fi; the
 *  old all-at-once fetch was 157KB and 2s warm, and hung past 120s on a cold worker. */
const PAGE = 25;

/** History archive (frame 1i) — closed positions, realized PnL frozen at close. */
export function History({ owner, onSelect }: { owner: string; onSelect: (id: number) => void }) {
  const [shown, setShown] = useState(PAGE);
  const [exporting, setExporting] = useState(false);
  const positions = useQuery({
    queryKey: ["positions", owner, "closed", shown],
    queryFn: () => api.positions(owner, { status: "closed", limit: shown }),
    refetchInterval: 30_000,
    placeholderData: (prev) => prev, // keep the table on screen while a longer page loads
  });
  // The tiles are aggregates over the WHOLE book, so they come from the API rather than
  // from the rows on screen. Summing the fetched array is what tied "how much have I made"
  // to "how many rows did the table happen to ask for".
  const realized = useQuery({ queryKey: ["realized", owner], queryFn: () => api.realized(owner), refetchInterval: 60_000 });
  // Two points a day is plenty for a first-vs-last percentage; the chart that needed the
  // full series is gone.
  const navSeries = useQuery({ queryKey: ["nav", owner], queryFn: () => api.nav(owner, 30, 60), refetchInterval: 60_000 });
  const m = useMoney();
  // wallet legs for the growth tile (WETH-rail book assumed, like the sums below)
  const native = useBalance({ address: owner as `0x${string}` });
  const weth = useReadContract({
    address: ADDRESSES.weth,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [owner as `0x${string}`],
  });

  if (positions.isLoading) return <div className="loading">loading history…</div>;
  if (positions.isError) return <div className="empty error">couldn't load history — is friar-api up?</div>;

  const closed = (positions.data?.positions ?? []).filter((p) => p.closed_ts !== null);
  const totalClosed = positions.data?.total ?? closed.length;

  // Every figure below is book-wide, from /realized. Trailing-30d is a money-weighted
  // return on deployed capital (Σ net PnL incl. fees ÷ Σ basis), immune to deposit timing
  // in a way a NAV delta is not. Realized closes only: the live book's unrealized marks
  // belong to the dashboard, this page is the archive.
  const r = realized.data;
  const totals = { pnl: BigInt(r?.pnlQuote ?? "0"), fees: BigInt(r?.feesNetQuote ?? "0") };
  const t30 = { net: BigInt(r?.window30.netQuote ?? "0"), basis: BigInt(r?.window30.basisQuote ?? "0") };

  const series = navSeries.data?.nav ?? [];
  const liquid = (native.data?.value ?? 0n) + (weth.data ?? 0n);
  // Loose token bags count too. An exit with no zap venue comes back IN KIND, so the
  // position's whole value sits in the wallet as tokens until a sweep clears it —
  // counting only WETH + native made NAV drop by a full position and jump back minutes
  // later. The wallet reads live here; the bag value comes from the latest snapshot,
  // which is at most one 5-minute pass stale and vastly closer than treating it as zero.
  const bags = BigInt(series[series.length - 1]?.bags ?? "0");
  const nav = liquid + bags;
  const navReady = native.data !== undefined && weth.data !== undefined;

  // True NAV-over-time once the series spans ≥20h. The 1h gate shipped first and
  // promptly read −18%: the series was BORN at the day's high-water mark, so "change
  // since the curve began" was really "change in the last hour, from the peak" wearing
  // a 30d label. Deposits show as steps — accepted.
  const first = series[0];
  const lastPt = series[series.length - 1];
  const seriesReady = first && lastPt && lastPt.ts - first.ts >= 20 * 3600;
  const navDelta = seriesReady ? BigInt(lastPt.nav) - BigInt(first.nav) : 0n;

  return (
    <>
      <div className="page-head">
        <h1>History</h1>
        {/* The table is paged, the export is not — a CSV that silently held only the rows
            you had scrolled past would be the worst kind of wrong. It fetches the book. */}
        <button
          className="btn"
          style={{ marginLeft: "auto", fontSize: 12, padding: "7px 14px" }}
          disabled={exporting}
          onClick={async () => {
            setExporting(true);
            try {
              const all = await api.positions(owner, { status: "closed", limit: Math.max(totalClosed, 1) });
              exportCsv(all.positions.filter((p) => p.closed_ts !== null));
            } finally {
              setExporting(false);
            }
          }}
        >
          {exporting ? "exporting…" : "Export CSV"}
        </button>
      </div>

      <div className="tiles">
        <div className="tile">
          <div className="tile-label">Wallet 30d</div>
          {seriesReady ? (
            <>
              <div className={`tile-value ${signClass(navDelta)}`}>{pctOf(navDelta, BigInt(first!.nav))}</div>
              <div className="tile-sub">
                NAV {fmtQuote(lastPt!.nav, 4)} WETH · since {shortDate(first!.ts)}
              </div>
            </>
          ) : (
            <>
              {/* No derived percent while the baseline builds — the gains÷(NAV−gains)
                  estimate inflated as open marks decayed (caught twice, killed). The
                  first honest delta prints once the series spans a day. */}
              <div className="tile-value">—</div>
              <div className="tile-sub">
                {navReady ? `NAV ${fmtQuote(nav.toString(), 4)} WETH · % starts once a day's baseline exists` : "reading wallet…"}
              </div>
            </>
          )}
        </div>
        <div className="tile">
          <div className="tile-label">Per deploy 30d</div>
          <div className={`tile-value ${signClass(t30.net)}`}>{r ? pctOf(t30.net, t30.basis) : "—"}</div>
          <div className="tile-sub">
            {!r
              ? "summing the book…"
              : r.window30.closes
                ? `${m.signed(t30.net)} ${m.unit} net · ${r.window30.closes} closes`
                : "no closes in the window"}
          </div>
        </div>
        <div className="tile">
          <div className="tile-label">Realized PnL</div>
          <div className={`tile-value ${signClass(totals.pnl)}`}>
            {r ? (
              <>
                {m.signed(totals.pnl)} <span className="tile-unit">{m.unit}</span>
              </>
            ) : (
              "—"
            )}
          </div>
          <div className="tile-sub">{r ? `fees banked ${m.signed(totals.fees)} ${m.unit}` : "summing the book…"}</div>
        </div>
        <div className="tile">
          <div className="tile-label">Closed positions</div>
          <div className="tile-value">{totalClosed}</div>
          <div className="tile-sub">
            {r ? (
              <>
                {r.greens} of {r.closed} green
                {r.avgHoldSeconds > 0 && <> · avg hold {fmtAge(r.avgHoldSeconds)}</>}
              </>
            ) : (
              "summing the book…"
            )}
          </div>
        </div>
      </div>

      <div className="card-box" style={{ padding: 0, overflow: "hidden" }}>
        <div className="gtable-head gtable-lg gt-hist">
          <span className="hide-m">ID</span>
          <span>PAIR</span>
          <span className="hide-m">CLOSED</span>
          <span className="hide-m">LIVED</span>
          <span className="cell-r">
            <span className="hide-m">FINAL </span>PNL
          </span>
          <span className="cell-r">
            FEES<span className="hide-m"> BANKED</span>
          </span>
          <span className="cell-r hide-m">INV Δ</span>
          <span className="hide-m" />
        </div>
        {closed.length === 0 ? (
          <div className="empty">no closed positions yet</div>
        ) : (
          closed
            .sort((a, b) => (b.closed_ts as number) - (a.closed_ts as number))
            .map((p) => <HistoryRow key={p.position_id} position={p} onSelect={() => onSelect(p.position_id)} />)
        )}
        {closed.length < totalClosed && (
          <div className="empty" style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 12 }}>
            <button className="btn" style={{ fontSize: 12, padding: "7px 14px" }} disabled={positions.isFetching} onClick={() => setShown((n) => n + PAGE)}>
              {positions.isFetching ? "loading…" : `Load ${Math.min(PAGE, totalClosed - closed.length)} more`}
            </button>
            <span className="faint" style={{ fontSize: 11 }}>
              showing {closed.length} of {totalClosed}
            </span>
          </div>
        )}
      </div>
    </>
  );
}

function HistoryRow({ position, onSelect }: { position: ApiPosition; onSelect: () => void }) {
  const { token } = splitPair(position.currency0, position.currency1);
  const sym = useTokenSymbol(token);
  const s = position.summary;
  const basis = basisOf(s);
  const m = useMoney();
  return (
    <div className="gtable-row clickable gtable-lg gt-hist" onClick={onSelect}>
      <span className="gold hide-m">#{position.position_id}</span>
      <span style={{ minWidth: 0 }}>
        <div className="trunc">
          <b style={{ fontSize: 14 }}>{sym.data?.symbol ?? shortAddr(token)}</b>
          <span className="dim"> /WETH</span>
        </div>
        <div className="show-m faint" style={{ fontSize: 10 }}>
          #{position.position_id} · {shortDate(position.closed_ts as number)} ·{" "}
          {fmtAge((position.closed_ts as number) - position.opened_ts)}
        </div>
      </span>
      <span className="dim hide-m">{shortDate(position.closed_ts as number)}</span>
      <span className="dim hide-m">{fmtAge((position.closed_ts as number) - position.opened_ts)}</span>
      <span className="cell-r">
        <span className={signClass(s.pnlQuote)}>{pctOf(s.pnlQuote, basis)}</span>
        <div className="faint" style={{ fontSize: 10 }}>
          {m.signed(s.pnlQuote)} {m.unit}
        </div>
      </span>
      <span className="cell-r green">
        {pctOf(s.feesNetQuote, basis)}
        <div className="faint" style={{ fontSize: 10 }}>
          {m.signed(s.feesNetQuote, 6)} {m.unit}
        </div>
      </span>
      <span className="cell-r hide-m">
        <span className={signClass(s.inventoryQuote)}>{pctOf(s.inventoryQuote, basis)}</span>
        <div className="faint" style={{ fontSize: 10 }}>
          {m.signed(s.inventoryQuote, 6)} {m.unit}
        </div>
      </span>
      <span className="cell-r faint hide-m">→</span>
    </div>
  );
}

function exportCsv(closed: ApiPosition[]) {
  const rows = [
    ["id", "token", "opened", "closed", "pnl_weth", "fees_net_weth", "inventory_weth", "value_weth"],
    ...closed.map((p) => [
      p.position_id,
      splitPair(p.currency0, p.currency1).token,
      new Date(p.opened_ts * 1000).toISOString(),
      p.closed_ts ? new Date(p.closed_ts * 1000).toISOString() : "",
      fmtQuote(p.summary.pnlQuote, 8),
      fmtQuote(p.summary.feesNetQuote, 8),
      fmtQuote(p.summary.inventoryQuote, 8),
      fmtQuote(p.summary.valueQuote, 8),
    ]),
  ];
  const csv = rows.map((r) => r.join(",")).join("\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = "friar-history.csv";
  a.click();
  URL.revokeObjectURL(url);
}
