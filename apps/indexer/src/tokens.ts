// Token-discovery cron, two legs feeding one D1 cache for the /tokens board:
//
//  MEME leg — Dexscreener search (capped ~30 results/query → wide term net) plus a
//  "sticky" batch refresh of every address already on the board, so a token that falls
//  out of search's top-30 keeps updating instead of churning off. Noise floors apply.
//
//  RWA leg — the official Robinhood stock-token registry (api.robinhood.com/rhj/assets).
//  Listed unconditionally: no floors and no safety screen (the registry IS the
//  authority; a GoPlus "pausable" flag on MSFT is noise, and a false block would
//  silently delist it). Market data still comes from Dexscreener where pools exist —
//  these trade on USDG-quoted v3 pools, so rows carry a per-token quote rail.
//
// FACTS ONLY — raw market data plus the dominant incumbent fee tier (resolved
// on-chain, factory-verified). No fit score, no labels; that selection opinion lives
// in Poacher (`poacher scan`), never in the product.
//
// The fold itself (pair aggregation, the incumbent-fee resolution, the Dexscreener batch
// endpoint) lives in @friar/chain — the API folds a single pasted address with the same
// code, and those two must never disagree about what "fee/TVL" means. What stays here is
// what makes this the BOARD: the discovery net, the RWA leg, and the noise floors.
import { rpcClient } from "./rpc.js";
import {
  aggregatePairs,
  checkTokenSafety,
  dsTokenPairs,
  isFriarHook,
  railFor,
  railPairFor,
  resolveIncumbent,
  type DsPair,
  type HotToken,
  type RwaAsset,
  type TokenRisk,
} from "@friar/chain";
import type { Env } from "./worker.js";

// Discovery: GeckoTerminal's per-network pool tables (documented, keyless). The old
// hand-curated Dexscreener keyword net could only find tokens sharing a substring with
// a meme word — STONKBROKER at $2.9M/day was invisible on 2026-08-02 because no term
// matched it and Dexscreener caps search at ~30 results with no per-chain ranking.
// Volume pages ARE the chain's flow table; new_pools surfaces launches before they
// chart anywhere. GT is discovery only (which addresses matter): pair data still comes
// from Dexscreener via the dsTokenPairs batch below, so aggregation reads one source.
const GT_BASE = "https://api.geckoterminal.com/api/v2/networks/robinhood";
const GT_VOLUME_PAGES = 8; // ×20 pools/page, h24-volume-ranked — covers the 150-meme board
const GT_NEW_PAGES = 2; // the freshest launches, pre-volume

async function gtPage(path: "pools" | "new_pools", page: number): Promise<string[]> {
  const sort = path === "pools" ? "&sort=h24_volume_usd_desc" : "";
  try {
    const r = await fetch(`${GT_BASE}/${path}?page=${page}${sort}`, { headers: { accept: "application/json" } });
    // GeckoTerminal answers a throttle with 429 and a JSON body, so `r.json()` SUCCEEDS and
    // `data` is simply absent — the page then returns [] down the happy path and nothing
    // anywhere records that discovery lost it. That is the failure mode this whole log exists
    // for; a keyless quota is shared per egress IP and a Worker does not get its own.
    if (!r.ok) {
      console.log(JSON.stringify({ at: "gtPage", path, page, ok: false, status: r.status }));
      return [];
    }
    const j = (await r.json()) as { data?: Array<{ relationships?: { base_token?: { data?: { id?: string } } } }> };
    return (j.data ?? [])
      .map((p) => p.relationships?.base_token?.data?.id ?? "")
      .filter((id) => id.startsWith("robinhood_0x"))
      .map((id) => id.slice("robinhood_".length));
  } catch (err) {
    // A lost page narrows this run's discovery and the sticky refresh still holds the
    // board — which is exactly why this must be LOUD. Silently, that degrades to "the
    // board never sees a new token again" and looks identical to a quiet market.
    console.log(JSON.stringify({ at: "gtPage", path, page, ok: false, err: String(err).slice(0, 120) }));
    return [];
  }
}

/** Token addresses worth a board look, straight from the chain's live volume table. */
async function gtDiscoverTokens(): Promise<string[]> {
  const pages = [
    ...Array.from({ length: GT_VOLUME_PAGES }, (_, i) => gtPage("pools", i + 1)),
    ...Array.from({ length: GT_NEW_PAGES }, (_, i) => gtPage("new_pools", i + 1)),
  ];
  return [...new Set((await Promise.all(pages)).flat())];
}

// The official on-chain asset registry behind docs.robinhood.com/chain/contracts
// ("generated live from the on-chain asset registry"). 60 req/s limit, 15s cache.
const RWA_REGISTRY_URL = "https://api.robinhood.com/rhj/assets";
const CHAIN_ID = 4663;

// Board bounds: memes beyond the cap fall off (sticky refresh would otherwise grow
// the board without limit); incumbent resolution is capped per run to stay inside
// the worker subrequest budget — hottest tokens resolve first, the rest carry the
// previous run's verdict.
const MAX_MEMES = 150;
/** How long a safety verdict keeps. Honeypot flags and transfer taxes are properties of the
 *  contract's bytecode, not of the market, so a week is conservative. */
const SAFETY_TTL_SECONDS = 7 * 24 * 3600;
/** GoPlus costs one subrequest PER TOKEN (its batch form answers for a single token on
 *  4663), so screening all 150 every five minutes is not an option. Cap it and let the
 *  board catch up across runs, hottest tokens first. */
const SAFETY_GOPLUS_PER_RUN = 25;
/** How long before we ask GoPlus about a token it did NOT answer for.
 *
 * Measured from the deployed Worker: of 25 addresses asked, GoPlus answered 4 — the same
 * shared-egress throttling the RPC sees. So "did not answer" is the common case, and the
 * retry rule cannot be "has no GoPlus verdict yet": that requeues the same 25 hottest
 * tokens every five minutes and the rest of the board is never screened at all. The budget
 * is spent on when we last ASKED, which advances; the verdict is what we keep. */
const SAFETY_GOPLUS_RETRY_SECONDS = 6 * 3600;
const MAX_STICKY = 400;
const MAX_INCUMBENT_RESOLVES = 40;

/** Active stock tokens deployed on this chain, from the official registry.
 * null = outage (never an empty list) so the caller preserves existing RWA rows. */
export async function fetchRwaRegistry(): Promise<RwaAsset[] | null> {
  try {
    const r = await fetch(RWA_REGISTRY_URL);
    if (!r.ok) return null;
    const j = (await r.json()) as {
      assets?: Array<{
        tokenSymbol?: string;
        tokenName?: string;
        status?: string;
        logoUrl?: string;
        deployments?: Array<{ contractAddress?: string; chainId?: number }>;
      }>;
    };
    const out: RwaAsset[] = [];
    for (const a of j.assets ?? []) {
      if (a.status !== "ASSET_STATUS_ACTIVE") continue;
      const dep = (a.deployments ?? []).find((d) => Number(d.chainId) === CHAIN_ID);
      if (!dep?.contractAddress || !a.tokenSymbol) continue;
      out.push({
        addr: dep.contractAddress,
        sym: a.tokenSymbol,
        name: a.tokenName ?? a.tokenSymbol,
        logo: a.logoUrl ?? null,
      });
    }
    return out.length ? out : null;
  } catch {
    return null;
  }
}

export interface ScanOpts {
  minLiq?: number;
  minVol?: number;
  minMcap?: number;
}

interface PrevRow {
  address: string;
  kind: string | null;
  incumbent_pool: string | null;
  incumbent_fee: number | null;
  vol24: number;
}

/** Refresh the D1 token cache. Upserts the current set and prunes what fell off —
 * meme and RWA prunes are guarded separately so a single upstream outage (Dexscreener
 * or the Robinhood registry) never wipes the other leg's rows. Meme tokens flagged as
 * malicious (honeypot / can't-sell / owner-ruggable — see @friar/chain
 * checkTokenSafety) are never upserted, so the prune drops them from the board;
 * warn-level flags ride along in the risk columns. The full verdicts also warm the
 * token_safety cache the API's /token/:address/safety endpoint reads. */
export async function runTokenScan(env: Env, opts: ScanOpts = {}): Promise<{ count: number; rwa: number; blocked: number }> {
  const minLiq = opts.minLiq ?? 5_000;
  const minVol = opts.minVol ?? 10_000;
  const minMcap = opts.minMcap ?? 50_000;

  // Board columns added post-launch; SQLite has no ADD COLUMN IF NOT EXISTS, so ALTER
  // and swallow the duplicate-column error — a no-op once applied. (Runs before the
  // SELECT below, which reads the new columns.)
  for (const col of ["vol1 REAL", "vol6 REAL", "risk_level TEXT", "risk TEXT", "kind TEXT", "name TEXT", "logo TEXT", "quote TEXT", "quote_addr TEXT"]) {
    await env.DB.prepare(`ALTER TABLE tokens ADD COLUMN ${col}`).run().catch(() => {});
  }
  const prev = (
    await env.DB.prepare("SELECT address, kind, incumbent_pool, incumbent_fee, vol24 FROM tokens").all<PrevRow>()
  ).results;
  const prevByAddr = new Map(prev.map((r) => [r.address, r]));

  const [gtAddrs, registry] = await Promise.all([gtDiscoverTokens(), fetchRwaRegistry()]);
  // Registry outage → classify from the previous run so existing RWA rows keep their
  // kind (and their prune guard) instead of flipping to memes and hitting the floors.
  const rwaByAddr = new Map<string, RwaAsset>();
  if (registry) {
    for (const a of registry) rwaByAddr.set(a.addr.toLowerCase(), a);
  } else {
    for (const r of prev) {
      if (r.kind === "rwa") rwaByAddr.set(r.address, { addr: r.address, sym: "", name: "", logo: null });
    }
  }

  // One hydration batch: everything GT discovered + every address already on the board
  // (sticky, so a token that falls off GT's pages doesn't flicker off the board) + the
  // full registry.
  const sticky = [
    ...gtAddrs,
    ...prev
      .sort((a, b) => b.vol24 - a.vol24)
      .slice(0, MAX_STICKY)
      .map((r) => r.address),
    ...[...rwaByAddr.keys()],
  ];
  const batch = await dsTokenPairs([...new Set(sticky.map((a) => a.toLowerCase()))]);

  // Dedupe by pair (a pair can arrive under both its base and quote token's lookup).
  const pairMap: Record<string, DsPair> = {};
  for (const p of batch.pairs) pairMap[p.pairAddress] = p;
  const allPairs = Object.values(pairMap);
  // Total Dexscreener outage: no data → no upserts, no prune (don't wipe the board).
  if (allPairs.length === 0 && !registry) return { count: 0, rwa: 0, blocked: 0 };

  const tok = aggregatePairs(allPairs, rwaByAddr);

  // Registry tokens with no DEX pair yet still list (dashes on the board — being the
  // first LP is the whole opportunity), carrying metadata only.
  const pairless: HotToken[] = [];
  for (const [addr, reg] of rwaByAddr) {
    if (tok[addr] || !reg.sym) continue;
    pairless.push({
      addr: reg.addr, sym: reg.sym, name: reg.name, logo: reg.logo, kind: "rwa",
      vol: 0, vol1: 0, vol6: 0, liq: 0, mcap: 0, pools: 0,
      priceNative: 0, priceUsd: null, ch1: null, ch6: null, ch24: null, railPairs: [],
    });
  }

  const memes = Object.values(tok)
    .filter((t) => t.kind === "meme")
    .filter((t) => t.liq >= minLiq && t.vol >= minVol && t.mcap >= minMcap && t.priceNative > 0)
    .sort((a, b) => b.vol - a.vol)
    .slice(0, MAX_MEMES);
  const rwas = [...Object.values(tok).filter((t) => t.kind === "rwa"), ...pairless];

  // Safety-screen memes only — BEFORE the on-chain incumbent resolution, so no RPC is
  // spent on rugs. Fail-open: if neither checker answered (empty `sources`), the token
  // stays (unknown ≠ malicious). Registry tokens are exempt by design.
  //
  // Re-screen only what is missing, stale, or was never actually seen by GoPlus, hottest
  // first and capped, then reuse the cache for the rest. Everything about this paragraph
  // exists because the previous version passed 20 addresses per request to an endpoint that
  // answers for one: 8 of 150 tokens were really screened and the other 142 were recorded
  // as clean with nothing behind them.
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS token_safety (
       address TEXT PRIMARY KEY, level TEXT NOT NULL, flags TEXT NOT NULL,
       sources TEXT NOT NULL, checked_ts INTEGER NOT NULL)`,
  ).run();
  await env.DB.prepare(`ALTER TABLE token_safety ADD COLUMN goplus_ts INTEGER`).run().catch(() => {});
  const now = Math.floor(Date.now() / 1000);
  const cachedSafety = new Map(
    (
      await env.DB.prepare(`SELECT address, level, sources, checked_ts, goplus_ts FROM token_safety`).all<{
        address: string;
        level: string;
        sources: string;
        checked_ts: number;
        goplus_ts: number | null;
      }>()
    ).results.map((r) => [r.address.toLowerCase(), r] as const),
  );
  // Ask again when the last ATTEMPT is older than the relevant window: a token we have a
  // GoPlus verdict for keeps it for a week, one it declined to answer about is retried in
  // hours. Both are driven by goplus_ts, so every run makes progress down the board.
  const needsGoPlus = (addr: string): boolean => {
    const c = cachedSafety.get(addr);
    if (!c) return true;
    let hasVerdict = false;
    try {
      hasVerdict = (JSON.parse(c.sources) as string[]).includes("goplus");
    } catch {
      hasVerdict = false;
    }
    const window = hasVerdict ? SAFETY_TTL_SECONDS : SAFETY_GOPLUS_RETRY_SECONDS;
    return now - (c.goplus_ts ?? 0) > window;
  };
  const goPlusAsked = memes
    .filter((t) => needsGoPlus(t.addr.toLowerCase()))
    .slice(0, SAFETY_GOPLUS_PER_RUN)
    .map((t) => t.addr);
  const risk = await checkTokenSafety(memes.map((t) => t.addr), { goPlusAddresses: goPlusAsked }).catch(
    () => new Map<string, TokenRisk>(),
  );
  // Screened this run ⇒ judge on the fresh verdict. Skipped ⇒ keep the cached one, so a
  // transfer tax found days ago still blocks today. Never screened by anyone ⇒ allowed.
  const verdictFor = (addr: string): string =>
    risk.get(addr)?.sources.length ? risk.get(addr)!.level : (cachedSafety.get(addr)?.level ?? "ok");
  const keptMemes = memes.filter((t) => verdictFor(t.addr.toLowerCase()) !== "block");
  console.log(
    JSON.stringify({
      at: "refreshTokens",
      gtDiscovered: gtAddrs.length,
      registry: registry ? registry.length : null,
      dsFailed: batch.failed,
      pairs: allPairs.length,
      folded: Object.keys(tok).length,
      memesAfterFloors: memes.length,
      keptMemes: keptMemes.length,
      rwas: rwas.length,
    }),
  );
  const blocked = memes.length - keptMemes.length;
  const kept = [...keptMemes, ...rwas].sort((a, b) => b.vol - a.vol);

  // Incumbent venue: reuse the previous verdict while its pool still shows among the
  // token's current rail pairs (it rarely changes); resolve fresh — hottest first —
  // under a per-run cap so the cron stays inside the worker subrequest budget.
  // ALL Friar hook generations (V1, V2, tiers) — a Friar pool must never resolve as its
  // own incumbent, and the tier pools are exactly the ones that grow deep enough to.
  const friarPoolIds = new Set(
    (await env.DB.prepare("SELECT pool_id, hooks FROM pools").all<{ pool_id: string; hooks: string }>()).results
      .filter((r) => isFriarHook(r.hooks))
      .map((r) => r.pool_id.toLowerCase()),
  );
  const client = rpcClient(env);
  let resolves = 0;
  const withIncumbent: Array<{ t: HotToken; inc: { pool: string; fee: number } | null }> = [];
  for (const t of kept) {
    const p = prevByAddr.get(t.addr.toLowerCase());
    const prevInc = p?.incumbent_pool && p.incumbent_fee != null ? { pool: p.incumbent_pool, fee: p.incumbent_fee } : null;
    const stillListed = prevInc && t.railPairs.some((rp) => rp.address.toLowerCase() === prevInc.pool.toLowerCase());
    if (stillListed) {
      withIncumbent.push({ t, inc: prevInc });
    } else if (t.railPairs.length > 0 && resolves < MAX_INCUMBENT_RESOLVES) {
      resolves++;
      withIncumbent.push({ t, inc: await resolveIncumbent(client, t, friarPoolIds) });
    } else {
      withIncumbent.push({ t, inc: prevInc }); // over cap: stale beats nothing; next runs catch up
    }
  }

  const safetyRows = [...risk.entries()]
    .filter(([, r]) => r.sources.length > 0) // an unchecked verdict must not shadow a real one
    .map(([addr, r]) =>
      env.DB.prepare(
        `INSERT INTO token_safety (address, level, flags, sources, checked_ts) VALUES (?,?,?,?,?)
         ON CONFLICT(address) DO UPDATE SET level=excluded.level, flags=excluded.flags,
           sources=excluded.sources, checked_ts=excluded.checked_ts`,
      ).bind(addr, r.level, JSON.stringify(r.flags), JSON.stringify(r.sources), now),
    );
  if (safetyRows.length) await env.DB.batch(safetyRows);
  // Record that we ASKED, separately from what we learned, and after the verdict writes so
  // it never overwrites one. Without this the same hottest tokens absorb the whole budget
  // every run — GoPlus answers about one in six from here, and a token it does not know
  // would otherwise be indistinguishable from one we never got around to.
  if (goPlusAsked.length) {
    await env.DB.batch(
      goPlusAsked.map((addr) =>
        env.DB.prepare(
          `INSERT INTO token_safety (address, level, flags, sources, checked_ts, goplus_ts)
           VALUES (?, 'ok', '[]', '[]', 0, ?)
           ON CONFLICT(address) DO UPDATE SET goplus_ts = excluded.goplus_ts`,
        ).bind(addr.toLowerCase(), now),
      ),
    );
  }

  const ts = Math.floor(Date.now() / 1000);
  const upserts = withIncumbent.map(({ t, inc }) => {
    // Pairless RWA row: refresh metadata + ts only, never stomp market numbers a
    // previous run recorded (also what preserves them through a Dexscreener outage).
    if (t.kind === "rwa" && t.pools === 0) {
      return env.DB.prepare(
        `INSERT INTO tokens
           (address, symbol, name, logo, kind, quote, price_native, vol24, liq_usd, pools, updated_ts)
         VALUES (?,?,?,?,?,?,0,0,0,0,?)
         ON CONFLICT(address) DO UPDATE SET
           symbol=excluded.symbol, name=excluded.name, logo=excluded.logo,
           kind=excluded.kind, quote=excluded.quote, updated_ts=excluded.updated_ts`,
      ).bind(t.addr.toLowerCase(), t.sym, t.name, t.logo, t.kind, "USDG", ts);
    }
    const r = t.kind === "meme" ? risk.get(t.addr.toLowerCase()) : undefined;
    return env.DB.prepare(
      `INSERT INTO tokens
         (address, symbol, name, logo, kind, quote, quote_addr, price_native, price_usd, ch1, ch6, ch24, vol24, vol1, vol6, liq_usd, mcap, pools, incumbent_pool, incumbent_fee, risk_level, risk, updated_ts)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(address) DO UPDATE SET
         symbol=excluded.symbol, name=excluded.name, logo=excluded.logo,
         kind=excluded.kind, quote=excluded.quote, quote_addr=excluded.quote_addr,
         price_native=excluded.price_native, price_usd=excluded.price_usd,
         ch1=excluded.ch1, ch6=excluded.ch6, ch24=excluded.ch24, vol24=excluded.vol24,
         vol1=excluded.vol1, vol6=excluded.vol6,
         liq_usd=excluded.liq_usd, mcap=excluded.mcap, pools=excluded.pools,
         incumbent_pool=excluded.incumbent_pool, incumbent_fee=excluded.incumbent_fee,
         risk_level=excluded.risk_level, risk=excluded.risk, updated_ts=excluded.updated_ts`,
    ).bind(
      t.addr.toLowerCase(),
      t.sym,
      t.name,
      t.logo,
      t.kind,
      railFor(t),
      railPairFor(t)?.quoteAddr ?? null,
      t.priceNative,
      t.priceUsd,
      t.ch1,
      t.ch6,
      t.ch24,
      t.vol,
      t.vol1,
      t.vol6,
      t.liq,
      t.mcap || null,
      t.pools,
      inc?.pool ?? null,
      inc?.fee ?? null,
      r && r.sources.length > 0 ? r.level : null,
      r && r.sources.length > 0 ? JSON.stringify(r.flags) : null,
      ts,
    );
  });
  if (upserts.length) await env.DB.batch(upserts);

  // Prune what fell off — including any flagged-malicious rows, which are
  // deliberately never refreshed. Each leg prunes only when its own sources fully
  // answered this run (a lost batch chunk or registry outage must not delist rows
  // that simply missed a refresh).
  if (allPairs.length > 0 && !batch.failed) {
    await env.DB.prepare("DELETE FROM tokens WHERE updated_ts < ? AND (kind IS NULL OR kind != 'rwa')").bind(ts).run();
  }
  if (registry) {
    await env.DB.prepare("DELETE FROM tokens WHERE updated_ts < ? AND kind = 'rwa'").bind(ts).run();
  }
  return { count: kept.length, rwa: rwas.length, blocked };
}
