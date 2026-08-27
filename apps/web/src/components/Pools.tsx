import { useQuery } from "@tanstack/react-query";
import { api, fmtUsd, type ApiPool } from "../api.js";
import { feeTierForHook, FRIAR_V2_SPACINGS } from "@friar/chain";
import { DOCS_FEES, DOCS_POOLS } from "../links.js";

/** Friar's own venue: every pool with liquidity, ranked by TVL. Separate from the Tokens
 *  board (which is "what to LP"); this is "the venue", the TVL flex + leaderboard. */

const E = (dec: number) => 10 ** dec;

/** Pool TVL in USD. tvlQuote is in the quote token's base units; USDG≈$1 (6dp), WETH via rate. */
function tvlUsd(p: ApiPool, usdPerWeth: number | null): number | null {
  const q = Number(p.tvlQuote);
  if (p.quoteSym === "USDG") return q / E(6);
  if (usdPerWeth == null) return null;
  return (q / E(18)) * usdPerWeth;
}

/** 24h quote-side volume in USD, for the fee/TVL estimate. */
function vol24Usd(p: ApiPool, usdPerWeth: number | null): number | null {
  // quote is currency0 iff quoteSym's rail sorts first; the API already knows which side is
  // quote, but only returns both volumes — pick the quote side by decimals/symbol.
  const isUsdg = p.quoteSym === "USDG";
  // currency0 is the quote when it's the rail; the API sums vol per currency, so the quote-side
  // volume is whichever leg is denominated in the quote. We approximate with the larger-decimals
  // convention: USDG (6dp) vs token, WETH (18dp) vs token — take the quote leg by matching side.
  const qVol = Number(p.currency0.toLowerCase() < p.currency1.toLowerCase() ? p.vol24h0 : p.vol24h1);
  const raw = qVol / (isUsdg ? E(6) : E(18));
  if (isUsdg) return raw;
  return usdPerWeth == null ? null : raw * usdPerWeth;
}

function binPct(spacing: number): string {
  return FRIAR_V2_SPACINGS.find((s) => s.value === spacing)?.binPct ?? `${(spacing / 100).toFixed(1)}%`;
}

export function Pools({ onOpen }: { onOpen: (token: string, quote: "WETH" | "USDG", poolId: string) => void }) {
  const poolsQ = useQuery({ queryKey: ["pools", "withLiquidity"], queryFn: api.poolsWithLiquidity, staleTime: 30_000 });
  const rateQ = useQuery({ queryKey: ["rate"], queryFn: api.rate, staleTime: 60_000 });
  const tokensQ = useQuery({ queryKey: ["tokens"], queryFn: api.tokens, staleTime: 60_000 });

  const usdPerWeth = rateQ.data?.usdPerWeth ?? null;
  const symOf = new Map((tokensQ.data?.tokens ?? []).map((t) => [t.address.toLowerCase(), t.symbol]));

  const rows = (poolsQ.data?.pools ?? [])
    .map((p) => {
      const tvl = tvlUsd(p, usdPerWeth);
      const vol = vol24Usd(p, usdPerWeth);
      // the token side is whichever currency isn't the quote rail
      const isUsdg = p.quoteSym === "USDG";
      const c0IsQuote = p.currency0.toLowerCase() < p.currency1.toLowerCase() ? true : false;
      const tokenAddr = (c0IsQuote ? p.currency1 : p.currency0).toLowerCase();
      const tokenSym = symOf.get(tokenAddr) ?? `${tokenAddr.slice(0, 6)}…`;
      const tier = feeTierForHook(p.hooks);
      const feeOverTvl = tvl && tvl > 0 && vol != null && p.feeAvg24h != null ? ((vol * (p.feeAvg24h / 1e6)) / tvl) * 100 : null;
      return { p, tvl, vol, tokenAddr, tokenSym, quoteSym: p.quoteSym, tierPct: tier?.pct ?? null, binPct: binPct(p.tick_spacing), feeOverTvl, isUsdg };
    })
    .sort((a, b) => (b.tvl ?? 0) - (a.tvl ?? 0));

  const totalTvl = rows.reduce((s, r) => s + (r.tvl ?? 0), 0);
  const loading = poolsQ.isLoading || tokensQ.isLoading;

  return (
    <div className="page">
      <div className="page-head" style={{ alignItems: "center" }}>
        <h1>Friar Pools</h1>
        {/* two links because they answer different questions: the guide explains this
            list's columns, the fees doc explains the mechanism people mean by "how pools
            work" — one link wearing that label pointed at the wrong one */}
        <a className="page-doclink" href={DOCS_POOLS} target="_blank" rel="noreferrer">
          about this page ↗
        </a>
        <a className="page-doclink" href={DOCS_FEES} target="_blank" rel="noreferrer">
          how fees work ↗
        </a>
      </div>

      <div className="pools-tvl">
        <div className="pools-tvl-label">Total value locked</div>
        <div className="pools-tvl-value">{rows.length ? fmtUsd(totalTvl) : "—"}</div>
        <div className="pools-tvl-sub">
          {rows.length} {rows.length === 1 ? "pool" : "pools"} · ranked by TVL
        </div>
      </div>

      {loading ? (
        <div className="muted" style={{ padding: 24 }}>
          loading…
        </div>
      ) : rows.length === 0 ? (
        <div className="muted" style={{ padding: 24 }}>
          No Friar pools with liquidity yet. Open a position to be the first.
        </div>
      ) : (
        <div className="pools-table">
          <div className="pools-row pools-head">
            <span className="pv-pair">Pool</span>
            <span className="num pv-tvl">TVL</span>
            <span className="num pv-vol">24h vol</span>
            <span className="num pv-ftv">Fee / TVL</span>
            <span className="num pv-lps">LPs</span>
            <button className="pools-open">Open</button>
          </div>
          {rows.map((r) => (
            <div className="pools-row" key={r.p.pool_id}>
              <span className="pools-pair pv-pair">
                <b>
                  {r.tokenSym} / {r.quoteSym}
                </b>
                <span className="pools-tags">
                  {r.tierPct != null ? `${r.tierPct}% base` : "dyn"} · {r.binPct} bins
                </span>
              </span>
              <span className="num gold pv-tvl" data-l="TVL">
                {r.tvl == null ? "—" : fmtUsd(r.tvl)}
              </span>
              <span className="num pv-vol" data-l="24h vol">
                {r.vol == null ? "—" : fmtUsd(r.vol)}
              </span>
              <span className="num pv-ftv" data-l="Fee / TVL">
                {r.feeOverTvl == null ? "—" : `${r.feeOverTvl.toFixed(2)}%`}
              </span>
              <span className="num pv-lps" data-l="LPs">
                {r.p.openPositions}
              </span>
              <button className="pools-open" onClick={() => onOpen(r.tokenAddr, r.quoteSym, r.p.pool_id)}>
                Open
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
