import { useCallback, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, fmtUsd, fmtPct, fmtFeePct, type ApiToken } from "../api.js";
import { shortAddr } from "../tokens.js";
import { prettyRiskFlags } from "../plan.js";
import { DOCS_TOKENS } from "../links.js";
import { track } from "../analytics.js";

import { chgFor, volFor, kindOf, feeTvlFor, feeTvlDisplay, type Tf, type Kind } from "../tokenStats.js";
type SortKey = "mcap" | "chg" | "vol" | "liq" | "ftv";

const PAGE = 50;
const SORT_KEYS: SortKey[] = ["mcap", "chg", "vol", "liq", "ftv"];

/** useState that survives a reload, in localStorage under `friar.tokens.<key>`.
 *
 * The `valid` guard is the whole point: what's in storage was written by an older build and
 * is entirely under the user's control, so a renamed filter or a hand-edited value would
 * otherwise restore a state the component can't render. Anything that fails the guard is
 * dropped for the default rather than trusted. Writes are best-effort — private-mode Safari
 * throws on setItem, and losing a filter preference is not worth breaking the board over. */
function useStored<T>(key: string, initial: T, valid: (v: unknown) => boolean): [T, (v: T) => void] {
  const storageKey = `friar.tokens.${key}`;
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw === null) return initial;
      const parsed: unknown = JSON.parse(raw);
      return valid(parsed) ? (parsed as T) : initial;
    } catch {
      return initial; // absent, unparseable, or storage unavailable
    }
  });
  const set = useCallback(
    (v: T) => {
      setValue(v);
      try {
        localStorage.setItem(storageKey, JSON.stringify(v));
      } catch {
        /* private mode — the selection just won't outlive the tab */
      }
    },
    [storageKey],
  );
  return [value, set];
}

/** Discovery board — hot tokens on Robinhood Chain from Dexscreener plus the official
 * stock-token (RWA) registry (facts only, no fit score; that lives in Poacher). Most
 * rows have NO Friar pool yet: "Open" both LPs an existing Friar pool and creates one
 * where none exists — first LP is the creator. */
export function Tokens({ onOpen }: { onOpen: (token: string, quote?: string) => void }) {
  const tokens = useQuery({ queryKey: ["tokens"], queryFn: () => api.tokens(), refetchInterval: 30_000 });
  // How you like to read the board is a preference, not a session — an LP who works in 1h
  // Memes shouldn't have to re-pick it every time they come back from a position. The search
  // box is deliberately NOT persisted: a stale needle silently hides most of the board, and
  // "why is it empty" is a worse first impression than re-typing three characters.
  const [tf, setTf] = useStored<Tf>("tf", "24h", (v) => v === "1h" || v === "6h" || v === "24h");
  const [kindF, setKindF] = useStored<Kind>("kind", "all", (v) => v === "all" || v === "meme" || v === "rwa");
  const [sort, setSort] = useStored<{ key: SortKey; desc: boolean }>(
    "sort",
    { key: "vol", desc: true },
    (v): v is { key: SortKey; desc: boolean } =>
      !!v && typeof v === "object" && SORT_KEYS.includes((v as { key: SortKey }).key),
  );
  const [q, setQ] = useState("");
  const [limit, setLimit] = useState(PAGE);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const val = (t: ApiToken) =>
      sort.key === "mcap" ? t.mcap
      : sort.key === "liq" ? t.liq_usd
      : sort.key === "chg" ? chgFor(t, tf)
      : sort.key === "ftv" ? feeTvlFor(t, tf)
      : volFor(t, tf);
    return (tokens.data?.tokens ?? [])
      .filter((t) => kindF === "all" || kindOf(t) === kindF)
      .filter(
        (t) =>
          !needle ||
          t.symbol.toLowerCase().includes(needle) ||
          (t.name ?? "").toLowerCase().includes(needle) ||
          t.address.toLowerCase().includes(needle),
      )
      .sort((a, b) => {
        const av = val(a);
        const bv = val(b);
        if (av == null) return bv == null ? 0 : 1; // unknowns sink regardless of direction
        if (bv == null) return -1;
        return sort.desc ? bv - av : av - bv;
      });
  }, [tokens.data, q, kindF, sort, tf]);

  const onSort = (key: SortKey) => setSort(sort.key === key ? { key, desc: !sort.desc } : { key, desc: true });

  // Paste-a-contract-address. The board is a capped, floored slice of the chain (see the
  // scan cron), so most tokens are NOT on it — and "no tokens match" for an address the
  // user already has in their clipboard is a dead end when the answer is one request away.
  // Gate on absence from the WHOLE board, not from `rows`: a token hidden by the Memes /
  // Stocks chip is filtered, not missing, and should keep saying so.
  const needle = q.trim();
  const isAddr = /^0x[0-9a-fA-F]{40}$/.test(needle);
  const onBoard =
    isAddr && (tokens.data?.tokens ?? []).some((t) => t.address.toLowerCase() === needle.toLowerCase());
  const lookup = useQuery({
    queryKey: ["token", needle.toLowerCase()],
    queryFn: () => api.token(needle),
    enabled: isAddr && !onBoard,
    staleTime: 60_000,
  });

  if (tokens.isLoading) return <div className="loading">loading tokens…</div>;
  if (tokens.isError) return <div className="empty error">couldn't load tokens — is friar-api up?</div>;

  return (
    <>
      <div className="page-head" style={{ alignItems: "center" }}>
        <h1>Tokens</h1>
        <div className="tf-chips">
          {(
            [
              ["all", "All"],
              ["meme", "Memes"],
              ["rwa", "Stocks"],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              className={`tf-chip ${kindF === k ? "active" : ""}`}
              onClick={() => {
                setKindF(k);
                setLimit(PAGE);
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <input
          className="input input-search"
          placeholder="search token or paste an address…"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setLimit(PAGE);
          }}
        />
        <div className="tf-chips" style={{ marginLeft: "auto" }}>
          {(["1h", "6h", "24h"] as const).map((x) => (
            <button key={x} className={`tf-chip ${tf === x ? "active" : ""}`} onClick={() => setTf(x)}>
              {x}
            </button>
          ))}
        </div>
      </div>

      <div className="card-box" style={{ padding: 0, overflow: "hidden" }}>
        <div className="gtable-head gtable-lg gt-tokens">
          <span className="hide-m">#</span>
          <span className="hide-m">TOKEN</span>
          <Th label="MCAP" k="mcap" sort={sort} onSort={onSort} />
          <Th label={tf.toUpperCase()} k="chg" sort={sort} onSort={onSort} />
          <Th label={`VOL ${tf.toUpperCase()}`} k="vol" sort={sort} onSort={onSort} />
          <Th label="LIQ" k="liq" sort={sort} onSort={onSort} />
          <Th label="FEE/TVL" k="ftv" sort={sort} onSort={onSort} />
          <span className="cell-r hide-m">INCUMBENT FEE</span>
          <span className="hide-m" />
        </div>
        {rows.length === 0 && isAddr && !onBoard ? (
          lookup.isLoading ? (
            <div className="loading">looking up {needle.slice(0, 10)}…</div>
          ) : lookup.data?.token ? (
            <>
              <div className="offboard-note mono">
                not on the board — resolved from its venues just now
              </div>
              <TokenRow token={lookup.data.token} rank={1} tf={tf} onOpen={onOpen} />
            </>
          ) : lookup.isError ? (
            <div className="empty error">couldn't look that address up</div>
          ) : (
            // Well-formed address, no venue anywhere. Not an error: being the first pool
            // is the whole opportunity, so offer the action instead of a dead end.
            <div className="empty">
              no venue for that token yet — nothing to price it from.{" "}
              <button className="btn-link" onClick={() => onOpen(needle)}>
                open the first pool →
              </button>
            </div>
          )
        ) : rows.length === 0 ? (
          <div className="empty">
            {q.trim() || kindF !== "all" ? "no tokens match" : "no tokens cached yet — the scan cron populates this"}
          </div>
        ) : (
          rows.slice(0, limit).map((t, i) => <TokenRow key={t.address} token={t} rank={i + 1} tf={tf} onOpen={onOpen} />)
        )}
        {rows.length > limit && (
          <button className="btn show-more" onClick={() => setLimit((n) => n + PAGE)}>
            show more · {Math.min(limit, rows.length)} of {rows.length}
          </button>
        )}
      </div>
      {/* FEE/TVL is the column people misread — it's the fee side of the return with the
          inventory side missing, and nothing on the board can say that in a header. */}
      <div className="attribution">
        <a href={DOCS_TOKENS} target="_blank" rel="noreferrer" onClick={() => track("docs_click")}>
          how to read this board ↗
        </a>
      </div>
    </>
  );
}

function Th({
  label,
  k,
  sort,
  onSort,
  className = "",
}: {
  label: string;
  k: SortKey;
  sort: { key: SortKey; desc: boolean };
  onSort: (k: SortKey) => void;
  className?: string;
}) {
  const active = sort.key === k;
  return (
    <span className={`cell-r th-sort ${active ? "th-active" : ""} ${className}`} onClick={() => onSort(k)}>
      {label}
      {active ? (sort.desc ? " ▾" : " ▴") : ""}
    </span>
  );
}

/** ⚠ for warn-level safety flags (mintable / pausable / blacklist-function / proxy) —
 * hover for the list. Flagged-malicious tokens never reach the board at all, so this
 * marks "know what you're LPing", not a verdict. */
function RiskFlag({ risk }: { risk: string | null }) {
  let flags: string[] = [];
  try {
    flags = prettyRiskFlags(JSON.parse(risk ?? "[]") as string[]);
  } catch {
    /* unreadable → generic tooltip */
  }
  return (
    <span
      className="warn"
      title={flags.length ? `safety flags: ${flags.join(", ")}` : "safety flags"}
      style={{ cursor: "help", marginLeft: 6 }}
    >
      ⚠
    </span>
  );
}

/** Signed change with gain/loss color; dim near flat. */
function Chg({ v, className = "" }: { v: number | null; className?: string }) {
  const cls = v == null ? "faint" : v > 0.05 ? "green" : v < -0.05 ? "red" : "dim";
  return <span className={`cell-r ${cls} ${className}`}>{fmtPct(v)}</span>;
}

function TokenRow({
  token: t,
  rank,
  tf,
  onOpen,
}: {
  token: ApiToken;
  rank: number;
  tf: Tf;
  onOpen: (token: string, quote?: string) => void;
}) {
  const quote = t.quote === "USDG" ? "USDG" : "WETH";
  const open = () => onOpen(t.address, quote);
  return (
    <div className="gtable-row clickable gtable-lg gt-tokens" onClick={open}>
      <span className="faint hide-m">{rank}</span>
      <span className="trunc c-tok" style={{ minWidth: 0 }}>
        {t.logo && (
          <img
            className="tok-logo"
            src={t.logo}
            alt=""
            loading="lazy"
            onError={(e) => ((e.target as HTMLImageElement).style.display = "none")}
          />
        )}
        <b style={{ fontSize: 14 }} title={t.name ?? undefined}>
          {t.symbol || shortAddr(t.address)}
        </b>
        <span className="dim"> /{quote}</span>
        {t.risk_level === "warn" && <RiskFlag risk={t.risk} />}
      </span>
      <span className="cell-r c-mcap">{fmtUsd(t.mcap)}</span>
      <Chg v={chgFor(t, tf)} className="c-chg" />
      <span className="cell-r c-vol">{fmtUsd(volFor(t, tf))}</span>
      <span className="cell-r dim c-liq">{fmtUsd(t.liq_usd)}</span>
      <FeeTvlCell token={t} tf={tf} />
      <IncumbentCell token={t} />
      <button
        className="btn btn-ghost-gold hide-m"
        style={{ padding: "7px 0", width: 84, justifySelf: "end" }}
        onClick={(e) => {
          e.stopPropagation();
          open();
        }}
      >
        Open
      </button>
    </div>
  );
}

/** Observed LP yield at the incumbent venue over the selected window, % of TVL.
 * Falls back to plain turnover ("3.2×") when the incumbent fee is unresolved. */
function FeeTvlCell({ token: t, tf }: { token: ApiToken; tf: Tf }) {
  const d = feeTvlDisplay(t, tf);
  const tone = d.kind === "fee" ? "" : d.kind === "turnover" ? "dim" : "faint";
  return <span className={`cell-r ${tone} c-ftv`}>{d.text}</span>;
}

/** The incumbent venue's static tier. Deliberately uncoloured: this used to go green
 * whenever Friar's floor came in under it, which encoded "Friar undercuts, so the flow is
 * winnable" as a product claim. Our own flow data doesn't support it — routers price the
 * whole trade, so depth at the touch decides where an order goes and the fee differential
 * barely registers. The number still matters as the multiplier behind FEE/TVL, so it stays;
 * the colour that turned it into a pitch does not. */
function IncumbentCell({ token: t }: { token: ApiToken }) {
  if (t.incumbent_fee == null) return <span className="cell-r faint hide-m">—</span>;
  return <span className="cell-r dim hide-m">{fmtFeePct(t.incumbent_fee)}</span>;
}
