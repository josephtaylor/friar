import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAccount } from "wagmi";
import { getTickAtSqrtPrice } from "@friar/core";
import { api, type ApiPositionDetail } from "../api.js";
import { splitPair, useTokenSymbol, shortAddr } from "../tokens.js";
import { basisOf, pctOf, signClass, fmtAge } from "../format.js";
import { useMoney } from "../denom.js";
import { rangeInfo, statusChip } from "../range.js";
import { BinChart } from "./BinChart.js";
import { ShareCard } from "./ShareCard.js";
import { PositionActions, useLivePool } from "./PositionActions.js";
import { SellToQuote } from "./SellToQuote.js";
import { ConnectScreen } from "./Gate.js";
import { useAccess } from "../access.js";
import { publicClient } from "../plan.js";
import { DOCS_POSITION } from "../links.js";
import { track } from "../analytics.js";
import { ADDRESSES, friarPositionManagerAbi } from "@friar/chain";

const EXPLORER_TX = "https://explorer.mainnet.chain.robinhood.com/tx/";

export function PositionDetail({ id, from, onBack }: { id: number; from: "positions" | "history"; onBack: () => void }) {
  const { address } = useAccount();
  const { viewAddress } = useAccess();
  // Position ids are enumerable integers, so the API only serves a book keyed by its
  // owner's address. We can offer two keys: the connected wallet (your own book) or the
  // ?address viewer param (invited-only whale-watch/book links). No key → no fetch.
  const ownerKey = (viewAddress ?? address)?.toLowerCase();
  // Poll fast until the position resolves (a just-opened one may still be indexing), then
  // settle to the normal cadence. Keeps retrying so a fresh open lands here with a
  // "confirming…" state instead of a hard error.
  const q = useQuery({
    queryKey: ["position", id, ownerKey],
    enabled: !!ownerKey,
    queryFn: () => api.position(id, ownerKey!),
    refetchInterval: (query) => (query.state.data ? 15_000 : 2_500),
    retry: 20,
    retryDelay: 1_500,
  });
  // CHAIN TRUTH. The API can only answer from D1, so a position the indexer hasn't reached
  // yet is indistinguishable from one that doesn't exist — which is how this page could sit
  // on "confirming on-chain" indefinitely. The manager exposes getPosition(id) as a public
  // view, so ask the chain directly and let it settle the question in one call. Same
  // doctrine as exits: what a user needs to see must not depend on our backend being caught
  // up. Only runs while the API has nothing, so the happy path costs no RPC.
  const chain = useQuery({
    queryKey: ["chainPosition", id],
    enabled: !q.data,
    staleTime: 10_000,
    retry: 1,
    queryFn: async () => {
      try {
        const [owner] = (await publicClient.readContract({
          address: ADDRESSES.positionManager as `0x${string}`,
          abi: friarPositionManagerAbi,
          functionName: "getPosition",
          args: [BigInt(id)],
        })) as [string, unknown, unknown];
        return { exists: true, owner: owner.toLowerCase() };
      } catch {
        // reverts with UnknownPosition for an id that was never minted
        return { exists: false, owner: null as string | null };
      }
    },
  });

  const live = useLivePool(q.data?.pool_id ?? "0x");
  const dexLinks = useDexLinks(q.data);
  // hoisted above the early returns (rules of hooks): token addr may be undefined
  const tokenAddr = q.data ? splitPair(q.data.currency0, q.data.currency1).token : undefined;
  const symQ = useTokenSymbol(tokenAddr);
  // keep the actions (and their guided stepper) mounted across the close confirming
  const [actionsBusy, setActionsBusy] = useState(false);
  const m = useMoney();

  // Position reads are owner-keyed, so there are two ways to land here with nothing to
  // show: no wallet and no ?address= to read with, or an id the API won't serve for this
  // owner (someone else's, or nonexistent — it 404s both identically, so enumerating
  // /position/1..N still reveals nothing).
  if (!ownerKey || q.isError)
    return (
      <>
        <button className="crumb" onClick={onBack}>
          ← {from === "history" ? "History" : "Positions"}
        </button>
        {!ownerKey ? (
          <ConnectScreen msg="connect a wallet to see this position — or open a shared link with ?address=0x…" />
        ) : (
          <div className="gate" style={{ minHeight: "40vh" }}>
            <div className="gate-card">
              <div>No position #{id} for this wallet.</div>
              <div className="gate-note">
                positions are read per owner — if someone shared this one, use their link with{" "}
                <span className="mono">?address=</span>
              </div>
            </div>
          </div>
        )}
      </>
    );

  // No API data yet. What we say now depends on what the CHAIN says, not on how long we've
  // been waiting — three genuinely different situations that used to look identical.
  if (!q.data) {
    if (chain.data && !chain.data.exists)
      return (
        <div className="gate" style={{ minHeight: "40vh" }}>
          <div className="gate-card">
            <div>Position #{id} doesn't exist.</div>
            <div className="gate-note">no position with that id has ever been opened</div>
          </div>
        </div>
      );
    if (chain.data?.exists && ownerKey && chain.data.owner !== ownerKey)
      return (
        <div className="gate" style={{ minHeight: "40vh" }}>
          <div className="gate-card">
            <div>Position #{id} belongs to another wallet.</div>
            <div className="gate-addr">{chain.data.owner}</div>
            <div className="gate-note">
              open a shared link with <span className="mono">?address=</span> to view someone else's book
            </div>
          </div>
        </div>
      );
    return (
      <div className="loading">
        {chain.data?.exists ? (
          <>
            position #{id} is <b>open on-chain</b> <span className="dim">— loading its history…</span>
          </>
        ) : (
          <>
            loading position #{id}… <span className="dim">(confirming on-chain)</span>
          </>
        )}
      </div>
    );
  }

  const p = q.data;
  const s = p.summary;
  const dex = dexLinks.data;
  const { token, quote, quoteSym, quoteIs0 } = splitPair(p.currency0, p.currency1);
  const sym = symQ.data?.symbol;
  const tokenDecimals = symQ.data?.decimals;
  const quoteDecimals = quoteSym === "USDG" ? 6 : 18; // USDG is 6-dec, WETH 18
  const isOwner = address !== undefined && address.toLowerCase() === p.owner.toLowerCase();
  const isOpen = p.closed_ts === null;
  const basis = basisOf(s);
  const age = (isOpen ? Math.floor(Date.now() / 1000) : (p.closed_ts as number)) - p.opened_ts;

  const r = rangeInfo(p, live?.sqrtPriceX96 ?? null);
  const chip = statusChip(r.status, !isOpen);

  // price for the bin chart: market first, then live, then snapshot
  const chartSqrt = p.latestSnapshot?.market_sqrt_price
    ? BigInt(p.latestSnapshot.market_sqrt_price)
    : live
      ? live.sqrtPriceX96
      : p.latestSnapshot
        ? BigInt(p.latestSnapshot.sqrt_price)
        : null;
  const closeTx = p.events.find((e) => /close/i.test(e.name))?.tx_hash ?? p.events.at(-1)?.tx_hash;

  return (
    <>
      <button className="crumb" onClick={onBack}>
        ← {from === "history" ? "History" : "Positions"}
      </button>

      <div className="detail-head">
        <CopyName label={sym ?? shortAddr(token)} addr={token} />
        <span className="detail-q">/ {quoteSym}</span>
        <span className="detail-id">#{p.position_id}</span>
        <span className="detail-age">
          {isOpen ? `open ${fmtAge(age)}` : `lived ${fmtAge(age)} · closed ${new Date((p.closed_ts as number) * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`}
        </span>
        <span className={`chip ${chip.cls}`}>{chip.label}</span>
        <div className="detail-actions">
          <ShareCard id={p.position_id} owner={p.owner} symbol={sym} quoteSym={quoteSym} />
          {(isOpen || actionsBusy) && isOwner && (
            <PositionActions position={p} onChanged={() => void q.refetch()} onBusyChange={setActionsBusy} />
          )}
        </div>
      </div>

      {isOpen && !isOwner && <div className="mono dim" style={{ fontSize: 12 }}>viewing read-only — connect the owner wallet to act</div>}
      {!isOpen && isOwner && <SellToQuote token={token} quote={quote} symbol={sym} onDone={() => void q.refetch()} />}

      <div className="meta-line">
        <span>
          pool <span className="addr">{shortAddr(p.pool_id, 6, 4)}</span>
        </span>
        {dex?.poolUrl && (
          <a href={dex.poolUrl} target="_blank" rel="noreferrer">
            pool chart ↗
          </a>
        )}
        {/* the fees-vs-inventory split below is the part that needs explaining, and this is
            where people are standing when they ask */}
        <a href={DOCS_POSITION} target="_blank" rel="noreferrer" onClick={() => track("docs_click")}>
          reading this page ↗
        </a>
      </div>

      <div className="tiles">
        <Tile label={isOpen ? "Net PnL" : "Realized PnL"} pct={pctOf(s.pnlQuote, basis)} sub={`${m.signed(s.pnlQuote, 6)} ${m.unit}`} cls={signClass(s.pnlQuote)} />
        <Tile
          label={isOpen ? "Fees earned" : "Fees banked"}
          pct={pctOf(s.feesNetQuote, basis)}
          sub={`${m.signed(s.feesNetQuote, 6)} ${m.unit}`}
          cls="pos"
        />
        <Tile label="Inventory delta" pct={pctOf(s.inventoryQuote, basis)} sub={`${m.signed(s.inventoryQuote, 6)} ${m.unit}`} cls={signClass(s.inventoryQuote)} />
        <div className="tile">
          <div className="tile-label">Current value</div>
          <div className="tile-value">
            {m.fmt(s.valueQuote, 6)} <span className="tile-unit">{m.unit}</span>
          </div>
          <div className="tile-sub">{s.investedQuote ? `invested ${m.fmt(s.investedQuote, 6)}` : `basis ${m.fmt(basis, 6)}`}</div>
        </div>
      </div>

      {!isOpen && (
        <div className="live">
          <span className="live-dot stale" />
          <span className="dim">
            CLOSED · numbers frozen at close · {new Date((p.closed_ts as number) * 1000).toLocaleString()}
          </span>
          {closeTx && (
            <a className="spacer" href={`${EXPLORER_TX}${closeTx}`} target="_blank" rel="noreferrer">
              close tx ↗
            </a>
          )}
        </div>
      )}

      <BinChart
        bins={p.bins.map((b) => ({ tickLower: b.tick_lower, tickUpper: b.tick_upper, liquidity: BigInt(b.liquidity) }))}
        quoteIs0={quoteIs0}
        currentTick={r.judgeTick ?? (chartSqrt ? getTickAtSqrtPrice(chartSqrt) : null)}
        sqrtPrice={chartSqrt}
        title={isOpen ? "liquidity per bin" : "shape at close"}
        tokenDecimals={tokenDecimals}
        quoteDecimals={quoteDecimals}
        quoteSym={quoteSym}
      />

      <PriceChart symbol={sym ?? "token"} quoteSym={quoteSym} token={token} dexUrl={dex?.chartUrl ?? dex?.poolUrl ?? null} closed={!isOpen} />
    </>
  );
}

function Tile({ label, pct, sub, cls }: { label: string; pct: string; sub: string; cls: string }) {
  return (
    <div className="tile">
      <div className="tile-label">{label}</div>
      <div className={`tile-value ${cls}`}>{pct}</div>
      <div className="tile-sub">{sub}</div>
    </div>
  );
}

/** Live price context via GMGN kline embed (covers Robinhood Chain / 4663).
 * TradingView Advanced Charts is the intended main chart (license pending) and slots
 * in here later; the position's shape + range live in the BinChart above. */
function PriceChart({ symbol, quoteSym, token, dexUrl, closed }: { symbol: string; quoteSym: string; token: string; dexUrl: string | null; closed: boolean }) {
  const src = `https://www.gmgn.cc/kline/robinhood/${token}?theme=dark&interval=60`;
  return (
    <div className="card-box">
      <div className="binchart-head">
        <span>
          PRICE · {symbol}/{quoteSym} · 1h{closed ? " — price runs on after close" : ""}
        </span>
        <span className="faint">charts by GMGN</span>
      </div>
      <iframe
        src={src}
        title="price chart"
        loading="lazy"
        style={{ width: "100%", height: 380, border: "none", borderRadius: 8, background: "var(--bg)" }}
      />
      {dexUrl && (
        <div className="attribution">
          <a href={dexUrl} target="_blank" rel="noreferrer">
            open on dexscreener ↗
          </a>
        </div>
      )}
    </div>
  );
}

/** The pair symbol at the top — click to copy the token's contract address. */
function CopyName({ label, addr }: { label: string; addr: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <b
      className="detail-sym copyable"
      title={copied ? "copied" : `click to copy ${shortAddr(addr)}`}
      onClick={() => {
        void navigator.clipboard?.writeText(addr);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
    >
      {label}
      {copied && <span className="copied-tick"> copied ✓</span>}
    </b>
  );
}

/** Dexscreener links for the pool + deepest chart, resolved via their API. */
function useDexLinks(p: ApiPositionDetail | undefined) {
  return useQuery({
    queryKey: ["dexlinks", p?.pool_id],
    enabled: !!p,
    staleTime: 600_000,
    queryFn: async () => {
      const { token } = splitPair(p!.currency0, p!.currency1);
      const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${token}`);
      const d = (await r.json()) as { pairs?: Array<{ chainId: string; pairAddress?: string; url?: string; liquidity?: { usd?: number } }> };
      const pairs = (d.pairs ?? []).filter((x) => /robinhood/i.test(x.chainId));
      const pid = p!.pool_id.toLowerCase();
      const exact = pairs.find((x) => {
        const pa = (x.pairAddress ?? "").toLowerCase();
        return pa.length > 4 && (pa === pid || pid.startsWith(pa));
      });
      pairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
      return { poolUrl: exact?.url ?? null, chartUrl: pairs[0]?.url ?? null };
    },
  });
}
