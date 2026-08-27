// friar-api: public reads over the indexed D1 data. No auth in v1 — everything here
// is derived from the public chain; gating it would be privacy theater.
import { Hono } from "hono";
import { cors } from "hono/cors";
import { createPublicClient, http, erc20Abi } from "viem";
import {
  ADDRESSES,
  robinhoodChain,
  checkTokenSafety,
  fetchTokenMarket,
  resolveIncumbent,
  railFor,
  railPairFor,
} from "@friar/chain";
import { enrichToken, friarBaseFeePips, selectFriarPools, type FriarPoolRow, type FriarRails } from "./friarpools.js";
import { summarizePosition, type PnlSummary, type PositionRow, type SnapshotRow } from "./pnl.js";
import { aggregateCandles, type CandleRow } from "./agg.js";
import { handleClientLog, type ClientLogBody } from "./clientlog.js";
import { handleClientEvent, type ClientEventBody } from "./events.js";
import { buildCardData, cardPct, feeStats, type CardDenom, type CardMetric } from "./card.js";
import { renderCardPng } from "./render.js";

type Bindings = { DB: D1Database };

const app = new Hono<{ Bindings: Bindings }>();
app.use("*", cors());

// Uncaught route errors → Workers Logs with the path attached (observability is enabled
// in wrangler.jsonc but only captures what we actually print).
app.onError((err, c) => {
  console.error(`unhandled [${c.req.method} ${c.req.path}]: ${err.stack ?? String(err)}`);
  return c.json({ error: "internal error" }, 500);
});

// Quote assets, by priority: a USDG pair is dollar-quoted even against WETH.
const QUOTES = [ADDRESSES.usdg.toLowerCase(), ADDRESSES.weth.toLowerCase()];
const quoteIs0 = (currency0: string): boolean => {
  const c0 = currency0.toLowerCase();
  return QUOTES.includes(c0);
};

app.get("/pools", async (c) => {
  // `withLiquidity=1` drops pools that hold no Friar liquidity — the pools LIST wants a
  // clean board, but venue discovery (findSwapVenue) wants every pool, so this is opt-in
  // and the default shape is unchanged.
  //
  // The signal is "has an open position", NOT on-chain active liquidity. A funded pool
  // whose price has run past all its bins reports ZERO active liquidity at the current
  // tick while still holding real value in out-of-range (all-one-side) bins; filtering on
  // active liquidity would make a live pool vanish the moment price exits its range. An
  // open position is the honest "there is value here" signal.
  const withLiquidity = c.req.query("withLiquidity") === "1";
  const pools = await c.env.DB.prepare("SELECT * FROM pools").all<{
    pool_id: string;
    currency0: string;
    currency1: string;
    fee: number;
    tick_spacing: number;
    hooks: string;
    ref_pool: string | null;
    watched: number;
  }>();
  const dayAgo = Math.floor(Date.now() / 1000) - 86_400;
  const enriched = await Promise.all(
    pools.results.map(async (p) => {
      const rows = await c.env.DB.prepare(
        "SELECT ts, open, high, low, close, vol0, vol1, swaps, fee_sum, fee_n, fee_max FROM candles WHERE pool_id = ? AND ts >= ? ORDER BY ts ASC",
      )
        .bind(p.pool_id, dayAgo)
        .all<CandleRow>();
      let vol0 = 0n;
      let vol1 = 0n;
      let swaps = 0;
      let feeSum = 0;
      let feeN = 0;
      let feePeak: number | null = null;
      for (const r of rows.results) {
        vol0 += BigInt(r.vol0);
        vol1 += BigInt(r.vol1);
        swaps += r.swaps;
        if (r.fee_n != null && r.fee_n > 0) {
          feeSum += r.fee_sum ?? 0;
          feeN += r.fee_n;
          if (r.fee_max != null && (feePeak === null || r.fee_max > feePeak)) feePeak = r.fee_max;
        }
      }
      const last = rows.results.at(-1);
      // Pool TVL = sum of open positions' current value, marked to true market. Quote-
      // denominated (the pool's WETH/USDG side); the web converts to USD with /rate. This is
      // Friar liquidity (manager positions), which is the whole pool since these are our pools.
      const q0 = quoteIs0(p.currency0);
      const openRows = await c.env.DB.prepare("SELECT * FROM positions WHERE pool_id = ? AND closed_ts IS NULL")
        .bind(p.pool_id)
        .all<PositionRow>();
      let tvlQuote = 0n;
      for (const row of openRows.results) {
        const snap = await latestSnapshot(c.env.DB, row.position_id);
        tvlQuote += BigInt(summarizePosition(row, snap, q0).valueQuote);
      }
      const quoteAddr = q0 ? p.currency0.toLowerCase() : p.currency1.toLowerCase();
      const quoteSym = quoteAddr === ADDRESSES.usdg.toLowerCase() ? "USDG" : "WETH";
      return {
        ...p,
        lastPrice: last?.close ?? null,
        vol24h0: vol0.toString(),
        vol24h1: vol1.toString(),
        swaps24h: swaps,
        // dynamic-fee stats over the same 24h window, pips; null until fee-tracking
        // candles exist for the pool (v3 venues stay null forever — static tier)
        feeAvg24h: feeN > 0 ? Math.round(feeSum / feeN) : null,
        feePeak24h: feePeak,
        openPositions: openRows.results.length,
        // TVL in the quote token's base units (decimals: USDG 6, WETH 18); quoteSym names it
        tvlQuote: tvlQuote.toString(),
        quoteSym,
      };
    }),
  );
  const out = withLiquidity ? enriched.filter((p) => p.openPositions > 0) : enriched;
  return c.json({ pools: out });
});

// Malicious-token screen (Uniswap/Blockaid protectionInfo + GoPlus static analysis,
// merged in @friar/chain). The scan cron pre-warms this cache for board tokens; a
// cache miss (pasted address) checks live and stores the verdict. Fail-open: when no
// checker answers, `sources` is empty and level is "ok" — the open flow treats that
// as unknown, not clean. TTL 6h.
const SAFETY_TTL = 6 * 3600;
interface SafetyRow {
  level: string;
  flags: string;
  sources: string;
  checked_ts: number;
}
let safetyTableReady = false;
async function ensureSafetyTable(db: D1Database): Promise<void> {
  if (safetyTableReady) return;
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS token_safety (
         address TEXT PRIMARY KEY, level TEXT NOT NULL, flags TEXT NOT NULL,
         sources TEXT NOT NULL, checked_ts INTEGER NOT NULL)`,
    )
    .run();
  safetyTableReady = true;
}

app.get("/token/:address/safety", async (c) => {
  const addr = c.req.param("address").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(addr)) return c.json({ error: "bad address" }, 400);
  await ensureSafetyTable(c.env.DB);

  const cached = await c.env.DB.prepare("SELECT level, flags, sources, checked_ts FROM token_safety WHERE address = ?")
    .bind(addr)
    .first<SafetyRow>();
  const now = Math.floor(Date.now() / 1000);
  if (cached && now - cached.checked_ts < SAFETY_TTL) {
    return c.json({ address: addr, level: cached.level, flags: JSON.parse(cached.flags), sources: JSON.parse(cached.sources) });
  }

  const risk = (await checkTokenSafety([addr]).catch(() => null))?.get(addr);
  if (!risk || risk.sources.length === 0) {
    // checkers unreachable — serve the stale verdict if we have one, else "unchecked"
    if (cached) return c.json({ address: addr, level: cached.level, flags: JSON.parse(cached.flags), sources: JSON.parse(cached.sources), stale: true });
    return c.json({ address: addr, level: "ok", flags: [], sources: [] });
  }
  await c.env.DB.prepare(
    `INSERT INTO token_safety (address, level, flags, sources, checked_ts) VALUES (?,?,?,?,?)
     ON CONFLICT(address) DO UPDATE SET level=excluded.level, flags=excluded.flags,
       sources=excluded.sources, checked_ts=excluded.checked_ts`,
  )
    .bind(addr, risk.level, JSON.stringify(risk.flags), JSON.stringify(risk.sources), now)
    .run();
  return c.json({ address: addr, ...risk });
});

// The beta is OVER (2026-07-25): the app is open to everyone, so there is nothing to be
// on a list for. Kept as a permanent `true` rather than deleted because older deployed
// web bundles still call it on boot, and a 404 there would render them unusable.
app.get("/allowed/:address", (c) => c.json({ allowed: true }));

// Funnel telemetry. Along with /client-log, the only write endpoints on this worker, so
// they carry their own defenses (name allowlist + size caps + a per-minute ceiling in
// events.ts) instead of auth — they fire before any wallet is connected.
app.post("/event", async (c) => {
  let body: ClientEventBody;
  try {
    body = await c.req.json<ClientEventBody>();
  } catch {
    return c.json({ error: "bad json" }, 400);
  }
  const out = await handleClientEvent(c.env.DB, body, c.req.header("User-Agent"));
  return c.json(out.json, out.status as 200);
});

// Browser error intake (the web app's report() helper). Rate-limited + capped in
// clientlog.ts. Unauthenticated for the same reason as /event: errors happen before,
// and often instead of, a wallet connecting.
app.post("/client-log", async (c) => {
  let body: ClientLogBody;
  try {
    body = await c.req.json<ClientLogBody>();
  } catch {
    return c.json({ error: "bad json" }, 400);
  }
  const out = await handleClientLog(c.env.DB, c.req.header("CF-Connecting-IP"), c.req.header("User-Agent"), body);
  return c.json(out.json, out.status as 200);
});

app.get("/v3pools", async (c) => {
  const rows = await c.env.DB.prepare("SELECT * FROM v3_pools").all();
  return c.json({ pools: rows.results });
});

// The standard Friar's calm-regime fee floor at tickSpacing 100, in pips (10000 = 1%):
// baseFactor(5000) × binStep(=tickSpacing 100) / 100 = 5000 → 0.50%. Immutable; the
// dynamic fee only ever surges ABOVE this. "undercuts" compares this floor to the tier.
interface TokenRow {
  address: string;
  symbol: string;
  name: string | null;
  logo: string | null;
  kind: string | null; // 'meme' | 'rwa'; null = legacy meme row
  quote_addr?: string | null; // the rail's token address — null = no rail pair at all
  quote: string | null; // dominant quote rail, 'WETH' | 'USDG'
  price_native: number;
  price_usd: number | null;
  ch1: number | null;
  ch6: number | null;
  ch24: number | null;
  vol24: number;
  vol1: number | null;
  vol6: number | null;
  liq_usd: number;
  mcap: number | null;
  pools: number;
  incumbent_pool: string | null;
  incumbent_fee: number | null;
  updated_ts: number;
}

const WETH = ADDRESSES.weth.toLowerCase();

/** Every Friar pool in the shapes the token routes need (see selectFriarPools). The open
 * position count feeds the board-pointer preference: live pools beat empty ones. */
async function friarPools(db: D1Database): Promise<{ byToken: Map<string, FriarRails>; ids: Set<string> }> {
  const pools = await db
    .prepare(
      `SELECT p.pool_id, p.currency0, p.currency1, p.hooks, p.tick_spacing, COALESCE(o.n, 0) AS open_n
       FROM pools p
       LEFT JOIN (SELECT pool_id, COUNT(*) AS n FROM positions WHERE closed_ts IS NULL GROUP BY pool_id) o
         ON o.pool_id = p.pool_id`,
    )
    .all<FriarPoolRow>();
  return selectFriarPools(pools.results);
}

// Discovery board: cached Dexscreener hot tokens, each annotated with whether a Friar
// pool exists yet and whether the Friar floor undercuts the dominant incumbent tier.
app.get("/tokens", async (c) => {
  const [tokens, friar] = await Promise.all([
    c.env.DB.prepare("SELECT * FROM tokens ORDER BY vol24 DESC").all<TokenRow>(),
    friarPools(c.env.DB),
  ]);
  return c.json({ tokens: tokens.results.map((t) => enrichToken(t, friar.byToken)) });
});

/**
 * One token by address — the board row when it's cached, otherwise folded live from
 * Dexscreener with the same @friar/chain code the board's cron uses. This is what lets
 * the search box and the creation screen answer for a token nobody has listed yet.
 *
 * Deliberately applies NO noise floors. The board's floors decide what earns a slot on a
 * ranked list; a pasted address is the user naming the token they want, and filtering it
 * out would answer a question nobody asked.
 *
 * `token: null` with a 200 means the address is well-formed but Dexscreener knows of no
 * pair for it on this chain. That is NOT an error — being the first pool is the whole
 * product — so the client renders it with blank metrics rather than an error state.
 *
 * `source` says whether the board already had it. A steady stream of "live" answers for
 * tokens with real volume is evidence the discovery net is too tight.
 */
app.get("/token/:address", async (c) => {
  const raw = c.req.param("address");
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) return c.json({ error: "not a token address" }, 400);
  const address = raw.toLowerCase();

  const [cached, friar] = await Promise.all([
    c.env.DB.prepare("SELECT * FROM tokens WHERE address = ?").bind(address).first<TokenRow>(),
    friarPools(c.env.DB),
  ]);
  if (cached) {
    c.header("Cache-Control", "public, max-age=30");
    return c.json({ token: enrichToken(cached, friar.byToken), source: "board" });
  }

  // The registry, from our OWN board rather than a round trip to Robinhood: `tokens` already
  // holds every RWA row, and this map is what lets a stock token count as a rail. Without it
  // `fetchTokenMarket` defaults to an empty registry and a Pons pair folds to `quote: null` —
  // which is how INTISMERAN, $2.6M/day quoted in mrna, read as "no rail" from this endpoint
  // while the cron's copy of the same code read it correctly.
  const rwaRows = await c.env.DB.prepare("SELECT address, symbol, name, logo FROM tokens WHERE kind = 'rwa'")
    .all<{ address: string; symbol: string; name: string | null; logo: string | null }>()
    .catch(() => null);
  const rwaByAddr = new Map(
    (rwaRows?.results ?? []).map((r) => [
      r.address.toLowerCase(),
      { addr: r.address.toLowerCase(), sym: r.symbol, name: r.name ?? "", logo: r.logo },
    ]),
  );
  const m = await fetchTokenMarket(address, rwaByAddr).catch(() => null);
  if (!m) {
    c.header("Cache-Control", "public, max-age=60");
    return c.json({ token: null, source: "live" });
  }

  // One RPC round per lookup, capped by resolveIncumbent to the 4 deepest rail pairs.
  // Edge-cached below so a room full of clients pasting the same address collapses to
  // roughly one resolution per minute.
  const client = createPublicClient({ chain: robinhoodChain, transport: http() });
  const inc = await resolveIncumbent(client, m, friar.ids).catch(() => null);

  const row: TokenRow = {
    address,
    symbol: m.sym,
    name: m.name,
    logo: m.logo,
    kind: m.kind,
    quote: railFor(m),
    quote_addr: railPairFor(m)?.quoteAddr ?? null,
    price_native: m.priceNative,
    price_usd: m.priceUsd,
    ch1: m.ch1,
    ch6: m.ch6,
    ch24: m.ch24,
    vol24: m.vol,
    vol1: m.vol1,
    vol6: m.vol6,
    liq_usd: m.liq,
    mcap: m.mcap || null,
    pools: m.pools,
    incumbent_pool: inc?.pool ?? null,
    incumbent_fee: inc?.fee ?? null,
    updated_ts: Math.floor(Date.now() / 1000),
  };
  c.header("Cache-Control", "public, max-age=60");
  return c.json({ token: enrichToken(row, friar.byToken), source: "live" });
});

// USD per WETH, for the ETH↔USD display toggle. USDG is the chain's dollar, but no
// USDG/WETH pool is indexed, so we read the rate from Dexscreener's deepest WETH pair:
// for a TOKEN/WETH pair, USD/WETH = priceUsd (USD/token) ÷ priceNative (WETH/token);
// if WETH is the base token, priceUsd is already USD/WETH. Edge-cached 60s so many
// clients collapse to ~one upstream call per minute.
app.get("/rate", async (c) => {
  const rate = await usdPerWeth();
  if (rate != null) c.header("Cache-Control", "public, max-age=60");
  return c.json({ usdPerWeth: rate });
});

async function usdPerWeth(): Promise<number | null> {
  try {
    const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${WETH}`);
    const j = (await r.json()) as {
      pairs?: Array<{
        chainId: string;
        baseToken?: { address?: string };
        priceUsd?: string;
        priceNative?: string;
        liquidity?: { usd?: number };
      }>;
    };
    const best = (j.pairs ?? [])
      .filter((p) => /robinhood/i.test(p.chainId) && Number(p.priceUsd) > 0 && Number(p.priceNative) > 0)
      .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
    if (!best) return null;
    const wethIsBase = (best.baseToken?.address ?? "").toLowerCase() === WETH;
    return wethIsBase ? Number(best.priceUsd) : Number(best.priceUsd) / Number(best.priceNative);
  } catch {
    return null;
  }
}

// works for BOTH v4 pool ids and v3 pool addresses — candles are source-agnostic
app.get("/pools/:id/candles", async (c) => {
  const poolIdParam = c.req.param("id");
  const interval = Number(c.req.query("interval") ?? "60");
  const to = Number(c.req.query("to") ?? Math.floor(Date.now() / 1000));
  const from = Number(c.req.query("from") ?? to - 86_400);
  const rows = await c.env.DB.prepare(
    "SELECT ts, open, high, low, close, vol0, vol1, swaps, fee_sum, fee_n, fee_max FROM candles WHERE pool_id = ? AND ts >= ? AND ts <= ? ORDER BY ts ASC",
  )
    .bind(poolIdParam, from, to)
    .all<CandleRow>();
  return c.json({ poolId: poolIdParam, interval, candles: aggregateCandles(rows.results, interval) });
});

app.get("/positions/:owner", async (c) => {
  const owner = c.req.param("owner");
  // BOUNDED. This used to return every position ever, unpaginated, and call
  // positionSummary once per row — so a wallet at 141 positions shipped 134KB and 141
  // sequential D1 round trips on every 15-second dashboard poll, growing with every close.
  // The list hung, and the summaries it did return were stale enough to disagree with the
  // detail view. Cost now scales with what the caller asks for, not with history.
  const status = c.req.query("status") ?? "all"; // open | closed | all
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 50), 1), 500);
  const offset = Math.max(Number(c.req.query("offset") ?? 0), 0);
  const filter = status === "open" ? "AND p.closed_ts IS NULL" : status === "closed" ? "AND p.closed_ts IS NOT NULL" : "";

  const total = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM positions p WHERE p.owner = ? COLLATE NOCASE ${filter}`,
  )
    .bind(owner)
    .first<{ n: number }>();

  const rows = await c.env.DB.prepare(
    `SELECT p.*, pl.currency0, pl.currency1 FROM positions p
     JOIN pools pl ON pl.pool_id = p.pool_id
     WHERE p.owner = ? COLLATE NOCASE ${filter}
     ORDER BY p.opened_ts DESC
     LIMIT ? OFFSET ?`,
  )
    .bind(owner, limit, offset)
    .all<PositionRow & { currency0: string; currency1: string }>();

  const positions = await Promise.all(
    rows.results.map(async (row) => {
      const { summary } = await positionSummary(c.env.DB, row, quoteIs0(row.currency0));
      return { ...row, summary };
    }),
  );
  return c.json({ owner, positions, total: total?.n ?? positions.length, limit, offset, status });
});

// Position ids are sequential integers — enumerable. Detail reads therefore require the
// owner address too (?owner=0x…), keeping them address-keyed like every other read here.
// Missing/wrong owner returns the same 404 as a nonexistent id, so probing learns nothing.
app.get("/position/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const owner = c.req.query("owner");
  const row = await c.env.DB.prepare(
    `SELECT p.*, pl.currency0, pl.currency1, pl.fee, pl.tick_spacing, pl.hooks FROM positions p
     JOIN pools pl ON pl.pool_id = p.pool_id WHERE p.position_id = ?`,
  )
    .bind(id)
    .first<PositionRow & { currency0: string; currency1: string; fee: number; tick_spacing: number; hooks: string }>();
  if (!row || !owner || row.owner.toLowerCase() !== owner.toLowerCase())
    return c.json({ error: "unknown position" }, 404);

  const bins = await c.env.DB.prepare(
    "SELECT bin_index, tick_lower, tick_upper, liquidity FROM position_bins WHERE position_id = ? ORDER BY bin_index",
  )
    .bind(id)
    .all();
  const events = await c.env.DB.prepare(
    "SELECT block, ts, name, data, tx_hash FROM events WHERE position_id = ? ORDER BY block, log_index",
  )
    .bind(id)
    .all();
  const { summary, snap } = await positionSummary(c.env.DB, row, quoteIs0(row.currency0));
  return c.json({
    ...row,
    bins: bins.results,
    events: events.results,
    latestSnapshot: snap,
    summary,
  });
});

app.get("/position/:id/snapshots", async (c) => {
  const id = Number(c.req.param("id"));
  // same owner-keying as /position/:id — numeric ids alone must not read a book
  const owner = c.req.query("owner");
  const pos = await c.env.DB.prepare("SELECT owner FROM positions WHERE position_id = ?")
    .bind(id)
    .first<{ owner: string }>();
  if (!pos || !owner || pos.owner.toLowerCase() !== owner.toLowerCase())
    return c.json({ error: "unknown position" }, 404);
  const to = Number(c.req.query("to") ?? Math.floor(Date.now() / 1000));
  const from = Number(c.req.query("from") ?? to - 7 * 86_400);
  const rows = await c.env.DB.prepare(
    "SELECT ts, sqrt_price, market_sqrt_price, amount0, amount1, fees0, fees1 FROM snapshots WHERE position_id = ? AND ts >= ? AND ts <= ? ORDER BY ts ASC",
  )
    .bind(id, from, to)
    .all<SnapshotRow>();
  return c.json({ positionId: id, snapshots: rows.results });
});

/** Per-owner NAV series from the indexer's 5-min nav_snapshots. True portfolio value
 * over time (liquid + open marks); deposits show up as steps, by design. */
app.get("/portfolio/:owner/nav", async (c) => {
  const owner = c.req.param("owner").toLowerCase();
  const days = Math.min(90, Math.max(1, Number(c.req.query("days") ?? 30)));
  const from = Math.floor(Date.now() / 1000) - days * 86_400;
  // Optional downsample, same shape as the sibling /history route: snapshots land every
  // 5 minutes, so 30 days is ~8,600 rows and 400KB on the wire for callers that only want
  // the endpoints of the series. Omitting `points` keeps every row, so existing callers
  // are untouched. Taking MAX(ts) per bucket keeps both ends exact — the newest row is by
  // definition the max of the newest bucket, so "current NAV" is never a stale
  // representative, which a bucket average or a first-per-bucket pick would have made it.
  const points = Number(c.req.query("points") ?? 0);
  const bucket = points > 0 ? Math.max(300, Math.ceil((days * 86_400) / points)) : 0;
  const rows = await c.env.DB.prepare(
    bucket > 0
      ? // MAX(ts) with bare columns is SQLite's documented "row that matched" rule; `%`
        // casts to INTEGER so a REAL-bound parameter cannot silently defeat the grouping.
        `SELECT MAX(ts) AS ts, liquid, positions, COALESCE(bags, '0') AS bags, nav
           FROM nav_snapshots WHERE owner = ?1 AND ts > ?2
          GROUP BY ts - ts % ?3 ORDER BY ts`
      : `SELECT ts, liquid, positions, COALESCE(bags, '0') AS bags, nav
           FROM nav_snapshots WHERE owner = ?1 AND ts > ?2 ORDER BY ts`,
  )
    .bind(...(bucket > 0 ? [owner, from, bucket] : [owner, from]))
    .all<{ ts: number; liquid: string; positions: string; bags: string; nav: string }>();
  c.header("Cache-Control", "public, max-age=60");
  return c.json({ owner, nav: rows.results });
});

/**
 * Portfolio value over time.
 *
 * DOWNSAMPLED IN SQL, not paginated. This used to return every snapshot in the window —
 * 11,767 rows for one wallet over the default 30 days, each one costing a
 * `summarizePosition` with BigInt math in the Worker — to feed a 34-pixel sparkline that
 * can resolve maybe 200 points. The cost scaled with how long you had been trading, so it
 * got slower every day, and paginating it would only have moved the same work to the
 * client across a dozen round trips.
 *
 * Instead: bucket the window into `points` intervals and take the LAST snapshot per
 * position per bucket (SQLite's documented bare-column-with-MAX rule), then value only
 * those. Snapshots are written in aligned passes across all of a wallet's positions, so a
 * bucket always holds a consistent cross-section rather than a partial sum.
 *
 * The bucket floors at 300s, the snapshot cadence, so short windows still come back at
 * full resolution and only long ones pay for the reduction.
 */
app.get("/portfolio/:owner/history", async (c) => {
  const owner = c.req.param("owner");
  const to = Number(c.req.query("to") ?? Math.floor(Date.now() / 1000));
  const from = Number(c.req.query("from") ?? to - 30 * 86_400);
  const points = Math.min(Math.max(Number(c.req.query("points") ?? 360) || 360, 30), 2_000);
  const bucket = Math.max(300, Math.ceil(Math.max(to - from, 1) / points));
  // value each snapshot at its own recorded price, then sum per bucket
  const rows = await c.env.DB.prepare(
    // MODULO, not division, to find the bucket start. D1 binds a JS number as REAL, so
    // `s.ts / ?4` is FLOAT division: every row lands in its own group, the GROUP BY
    // reduces nothing, and `(s.ts/?4)*?4` hands back the raw timestamp — which looks
    // exactly like the endpoint working, at the old cost. SQLite's `%` casts both operands
    // to INTEGER first, so this is correct however the driver decides to send the number.
    `SELECT s.ts - s.ts % ?4 AS bucket_ts, MAX(s.ts) AS ts,
            s.sqrt_price, s.market_sqrt_price, s.amount0, s.amount1, s.fees0, s.fees1, pl.currency0
     FROM snapshots s
     JOIN positions p ON p.position_id = s.position_id
     JOIN pools pl ON pl.pool_id = p.pool_id
     WHERE p.owner = ?1 COLLATE NOCASE AND s.ts >= ?2 AND s.ts <= ?3
     GROUP BY s.position_id, s.ts - s.ts % ?4
     ORDER BY bucket_ts ASC`,
  )
    .bind(owner, from, to, bucket)
    .all<SnapshotRow & { currency0: string; bucket_ts: number }>();

  const byTs = new Map<number, bigint>();
  for (const s of rows.results) {
    const summary = summarizePosition(
      // zero cash flows: portfolio history charts VALUE over time, not pnl
      {
        position_id: 0,
        owner,
        pool_id: "",
        opened_ts: 0,
        closed_ts: null,
        open_delta0: "0",
        open_delta1: "0",
        flow0: "0",
        flow1: "0",
        fees0: "0",
        fees1: "0",
        perf0: "0",
        perf1: "0",
      },
      s,
      quoteIs0(s.currency0),
    );
    // key by the BUCKET, not the raw ts: two positions' last snapshots inside one bucket
    // are seconds apart, and summing by raw ts would split them into two half-portfolios
    byTs.set(s.bucket_ts, (byTs.get(s.bucket_ts) ?? 0n) + BigInt(summary.valueQuote));
  }
  const history = [...byTs.entries()].sort((a, b) => a[0] - b[0]).map(([ts, v]) => ({ ts, valueQuote: v.toString() }));
  // snapshots land every ~5 minutes, so a minute of edge cache is free — and this is the
  // one portfolio route that had none while its sibling /nav already cached
  c.header("Cache-Control", "public, max-age=60");
  return c.json({ owner, history, bucket });
});

/**
 * Realized totals over EVERY closed position, so the History tiles survive pagination.
 *
 * The tiles used to be summed on the client from the same array that fed the table. That
 * only worked because the page asked for all 200 rows at once, which is precisely what
 * made it slow — and it fails silently the moment the table is paged: the totals quietly
 * become page totals and read as a shrinking book. Aggregates belong to the whole set, so
 * they are computed here over the whole set, once, and cached.
 *
 * CHUNKED, not `Promise.all` over everything. Each position costs three D1 reads, so
 * fanning out across 160 closes issues ~500 at once; the sibling list route did exactly
 * that and answered in 2s on a warm worker but hung past 120s on a cold one. Sequential
 * chunks bound the concurrency without bounding the answer.
 */
app.get("/portfolio/:owner/realized", async (c) => {
  const owner = c.req.param("owner");
  const rows = await c.env.DB.prepare(
    `SELECT p.*, pl.currency0, pl.currency1 FROM positions p
     JOIN pools pl ON pl.pool_id = p.pool_id
     WHERE p.owner = ? COLLATE NOCASE AND p.closed_ts IS NOT NULL
     ORDER BY p.closed_ts DESC`,
  )
    .bind(owner)
    .all<PositionRow & { currency0: string; currency1: string }>();

  const cutoff30 = Math.floor(Date.now() / 1000) - 30 * 86_400;
  let pnl = 0n;
  let fees = 0n;
  let greens = 0;
  let lived = 0;
  let net30 = 0n;
  let basis30 = 0n;
  let closes30 = 0;

  const CHUNK = 25;
  for (let i = 0; i < rows.results.length; i += CHUNK) {
    const summaries = await Promise.all(
      rows.results.slice(i, i + CHUNK).map(async (row) => ({
        row,
        summary: (await positionSummary(c.env.DB, row, quoteIs0(row.currency0))).summary,
      })),
    );
    for (const { row, summary } of summaries) {
      const p = BigInt(summary.pnlQuote);
      const f = BigInt(summary.feesNetQuote);
      pnl += p;
      fees += f;
      if (p > 0n) greens++;
      lived += (row.closed_ts as number) - row.opened_ts;
      if ((row.closed_ts as number) >= cutoff30) {
        // Same money-weighted return the tile has always shown: Σ net ÷ Σ basis, immune to
        // deposit timing in a way a NAV delta is not.
        net30 += p + f;
        basis30 += basisOfSummary(summary);
        closes30++;
      }
    }
  }

  const closed = rows.results.length;
  c.header("Cache-Control", "public, max-age=60");
  return c.json({
    owner,
    closed,
    greens,
    avgHoldSeconds: closed ? Math.round(lived / closed) : 0,
    pnlQuote: pnl.toString(),
    feesNetQuote: fees.toString(),
    window30: { closes: closes30, netQuote: net30.toString(), basisQuote: basis30.toString() },
  });
});

/** Mirrors the client's `basisOf`: invested when known, else the absolute cash flow. */
function basisOfSummary(s: PnlSummary): bigint {
  const invested = s.investedQuote ? BigInt(s.investedQuote) : 0n;
  if (invested > 0n) return invested;
  const cf = BigInt(s.cashflowQuote);
  return cf < 0n ? -cf : cf;
}

import { markPrice1e18 } from "@friar/core";
const E18 = 10n ** 18n;

/** Cash flows valued at the price WHEN THEY HAPPENED (nearest snapshot) — fixed cost
 * basis, "vs what I put in" — not vs holding the deposited basket. */
async function fixedCashflowQuote(
  db: D1Database,
  positionId: number,
  poolId: string,
  q0: boolean,
): Promise<{ total: bigint; invested: bigint } | null> {
  const evs = await db
    .prepare(
      "SELECT ts, data FROM events WHERE position_id = ? AND name IN ('PositionOpened','PositionIncreased','PositionDecreased','FeesCollected') ORDER BY ts",
    )
    .bind(positionId)
    .all<{ ts: number; data: string }>();
  if (!evs.results.length) return null;

  // Price each event's deltas at event time. Prefer this position's own snapshots
  // (market price, correctly oriented). If it has none — the common case for a
  // position backfilled AFTER it closed, which never got snapshotted — fall back to
  // this pool's candles: same pool, so same orientation, no inversion risk. Without
  // this fallback, invested/PnL were null → the frontend basis went negative → −100%.
  const snaps = await db
    .prepare("SELECT ts, sqrt_price, market_sqrt_price FROM snapshots WHERE position_id = ? ORDER BY ts")
    .bind(positionId)
    .all<{ ts: number; sqrt_price: string; market_sqrt_price: string | null }>();
  let series: Array<{ ts: number; p: bigint }>;
  if (snaps.results.length) {
    // markPrice1e18: a snapshot taken while the pool sat on a swap limit carries a
    // boundary, not a quote, and this series prices the OPEN deltas — so a pinned entry
    // valued FLAMINGO #284's 228,000-token open leg at 3.4e38 and drove pnlQuote to 2.24e60
    // even after summarizePosition's own fee leg was already guarded. 0n is the
    // "unpriceable" signal the loop below already handles by counting the quote leg only.
    series = snaps.results.map((s) => ({ ts: s.ts, p: markPrice1e18(BigInt(s.market_sqrt_price ?? s.sqrt_price)) }));
  } else {
    const candles = await db
      .prepare("SELECT ts, close FROM candles WHERE pool_id = ? ORDER BY ts")
      .bind(poolId)
      .all<{ ts: number; close: string }>();
    series = candles.results.map((c) => ({ ts: c.ts, p: BigInt(c.close) }));
  }
  const pxAt = (ts: number): bigint => {
    if (!series.length) return 0n;
    let best = series[0]!;
    for (const s of series) if (Math.abs(s.ts - ts) < Math.abs(best.ts - ts)) best = s;
    return best.p;
  };

  let total = 0n;
  let invested = 0n;
  for (const e of evs.results) {
    const d = JSON.parse(e.data) as { delta0?: string; delta1?: string };
    const d0 = BigInt(d.delta0 ?? 0);
    const d1 = BigInt(d.delta1 ?? 0);
    const p = pxAt(e.ts);
    // Value the token side when we have a price; otherwise count only the quote (WETH)
    // leg — it's exact and always known, so `invested` is never lost (never −100%).
    const v = p === 0n ? (q0 ? d0 : d1) : q0 ? d0 + (d1 * E18) / p : d1 + (d0 * p) / E18;
    total += v;
    if (v < 0n) invested += -v;
  }
  return { total, invested };
}

/** The full summary pipeline shared by list/detail/card reads: latest (or close-time)
 * snapshot → summarizePosition → fixed-cost-basis override when events exist. */
async function positionSummary(
  db: D1Database,
  row: PositionRow,
  q0: boolean,
): Promise<{ summary: PnlSummary; snap: SnapshotRow | null }> {
  const snap =
    row.closed_ts === null
      ? await latestSnapshot(db, row.position_id)
      : await closedFeeSnapshot(db, row.position_id);
  const summary = summarizePosition(row, snap, q0);
  const fixed = await fixedCashflowQuote(db, row.position_id, row.pool_id, q0);
  if (fixed !== null) {
    const pnl = BigInt(summary.valueQuote) + fixed.total;
    summary.cashflowQuote = fixed.total.toString();
    summary.investedQuote = fixed.invested.toString();
    summary.pnlQuote = pnl.toString();
    summary.inventoryQuote = (pnl - BigInt(summary.feesNetQuote)).toString();
  }
  return { summary, snap };
}

async function latestSnapshot(db: D1Database, positionId: number): Promise<SnapshotRow | null> {
  return db
    .prepare(
      "SELECT ts, sqrt_price, market_sqrt_price, amount0, amount1, fees0, fees1 FROM snapshots WHERE position_id = ? ORDER BY ts DESC LIMIT 1",
    )
    .bind(positionId)
    .first<SnapshotRow>();
}

/** Snapshot to summarize a CLOSED position with. On-chain holdings are zero after close,
 * but valuing the realized token-side fees still needs a price — pass `null` and
 * summarizePosition's px=0 path drops the token leg, so "fees banked" reads ~half. We
 * reuse the last snapshot for its MARKET price but zero the holdings/unclaimed (those are
 * now realized into row.fees / row.flow). No prior snapshot (position backfilled after it
 * closed) → null, and it degrades to the old quote-only figure. Fees are valued at the
 * last mark (≤5 min before close), not per-event; good enough for the decomposition. */
async function closedFeeSnapshot(db: D1Database, positionId: number): Promise<SnapshotRow | null> {
  const last = await latestSnapshot(db, positionId);
  if (!last) return null;
  return { ...last, amount0: "0", amount1: "0", fees0: "0", fees1: "0" };
}

// ── PnL share cards ("The Tithe") ──────────────────────────────────────────
// Server-rendered 1200×630 PNGs (OG-unfurl format) + a share page carrying the OG
// tags. Owner-keyed like every other position read. Content rules live in card.ts.

type PoolRow = PositionRow & { currency0: string; currency1: string; tick_spacing: number; hooks: string };

/** Everything the card needs, or null when id/owner don't match (404-alike). */
async function loadCardPosition(db: D1Database, id: number, owner: string | undefined): Promise<PoolRow | null> {
  if (!Number.isInteger(id) || !owner) return null;
  const row = await db
    .prepare(
      `SELECT p.*, pl.currency0, pl.currency1, pl.tick_spacing, pl.hooks FROM positions p
       JOIN pools pl ON pl.pool_id = p.pool_id WHERE p.position_id = ?`,
    )
    .bind(id)
    .first<PoolRow>();
  if (!row || row.owner.toLowerCase() !== owner.toLowerCase()) return null;
  return row;
}

// base-token symbols: D1 tokens cache → live ERC-20 read → short address
const symbolCache = new Map<string, string>();
async function tokenSymbol(db: D1Database, addr: string): Promise<string> {
  const a = addr.toLowerCase();
  const hit = symbolCache.get(a);
  if (hit) return hit;
  let sym =
    (await db.prepare("SELECT symbol FROM tokens WHERE address = ?").bind(a).first<{ symbol: string }>())?.symbol ??
    null;
  if (!sym) {
    try {
      const client = createPublicClient({ chain: robinhoodChain, transport: http() });
      sym = await client.readContract({ address: a as `0x${string}`, abi: erc20Abi, functionName: "symbol" });
    } catch {
      sym = null;
    }
  }
  const out = (sym ?? `${addr.slice(0, 6)}…${addr.slice(-4)}`).replace(/[^\x20-\x7E…]/g, "").slice(0, 14) || "TOKEN";
  symbolCache.set(a, out);
  return out;
}

interface CardOpts {
  metric: CardMetric;
  denom: CardDenom;
  showAmounts: boolean;
}
const cardOpts = (q: (k: string) => string | undefined): CardOpts => ({
  metric: q("metric") === "amount" ? "amount" : "percent",
  denom: q("denom") === "USD" ? "USD" : "WETH",
  showAmounts: q("amounts") !== "0",
});

async function assembleCard(db: D1Database, row: PoolRow, opts: CardOpts) {
  const q0 = quoteIs0(row.currency0);
  const quote = (q0 ? row.currency0 : row.currency1).toLowerCase();
  const quoteSym = quote === ADDRESSES.usdg.toLowerCase() ? "USDG" : "WETH";
  const token = q0 ? row.currency1 : row.currency0;
  const now = Math.floor(Date.now() / 1000);
  const open = row.closed_ts === null;

  const [{ summary }, symbol] = await Promise.all([
    positionSummary(db, row, q0),
    tokenSymbol(db, token),
  ]);

  // dynamic-fee environment over the position's own window, from fee-tracked candles
  const candles = await db
    .prepare("SELECT ts, fee_sum, fee_n, fee_max FROM candles WHERE pool_id = ? AND ts >= ? AND ts <= ? ORDER BY ts ASC")
    .bind(row.pool_id, row.opened_ts, open ? now : (row.closed_ts as number))
    .all<{ ts: number; fee_sum: number | null; fee_n: number | null; fee_max: number | null }>();
  // the fee floor only exists on Friar hooks — base fee by hook generation
  const floorPips = friarBaseFeePips(row.hooks, row.tick_spacing) ?? 0;
  const fees = feeStats(candles.results, now, floorPips);

  // USD view needs a rate on WETH-quoted pools (USDG pools are natively dollars)
  const rate = opts.denom === "USD" && quoteSym === "WETH" ? await usdPerWeth() : null;

  const inv = summary.investedQuote ? BigInt(summary.investedQuote) : 0n;
  const cf = BigInt(summary.cashflowQuote);
  const basis = inv > 0n ? inv : cf < 0n ? -cf : cf; // mirrors the web's basisOf()

  const data = buildCardData({
    symbol,
    quoteSym,
    quoteDecimals: quoteSym === "USDG" ? 6 : 18,
    open,
    openedTs: row.opened_ts,
    closedTs: row.closed_ts,
    now,
    pnlQuote: BigInt(summary.pnlQuote),
    feesNetQuote: BigInt(summary.feesNetQuote),
    basisQuote: basis,
    usdPerQuote: rate,
    metric: opts.metric,
    denom: opts.denom,
    showAmounts: opts.showAmounts,
    feeAvgPips: fees.avgPips,
    feeNowPips: fees.nowPips,
    feeSurge: fees.surge,
    baseFeePips: floorPips || null,
    tickSpacing: row.tick_spacing,
  });
  return { data, summary, basis, open };
}

app.get("/position/:id/card.png", async (c) => {
  const row = await loadCardPosition(c.env.DB, Number(c.req.param("id")), c.req.query("owner"));
  if (!row) return c.json({ error: "unknown position" }, 404);
  const { data, open } = await assembleCard(c.env.DB, row, cardOpts((k) => c.req.query(k)));
  const png = await renderCardPng(data);
  return new Response(png, {
    headers: {
      "Content-Type": "image/png",
      // closed cards are frozen; open ones re-mark every snapshot cycle
      "Cache-Control": open ? "public, max-age=300" : "public, max-age=86400",
    },
  });
});

// The share URL itself: OG tags for the unfurl; humans get the card full-bleed with a
// CTA into the app (a bare redirect made shared links land context-free on the site).
app.get("/s/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const row = await loadCardPosition(c.env.DB, id, c.req.query("owner"));
  if (!row) return c.text("unknown position", 404);
  const opts = cardOpts((k) => c.req.query(k));
  const { data, summary, basis, open } = await assembleCard(c.env.DB, row, opts);

  const params = new URLSearchParams({ owner: row.owner });
  if (opts.metric !== "percent") params.set("metric", opts.metric);
  if (opts.denom !== "WETH") params.set("denom", opts.denom);
  if (!opts.showAmounts) params.set("amounts", "0");
  // force https except in local dev — unfurl crawlers won't fetch http images
  const u = new URL(c.req.url);
  if (u.hostname !== "localhost" && u.hostname !== "127.0.0.1") u.protocol = "https:";
  const img = `${u.origin}/position/${id}/card.png?${params.toString()}`;

  const esc = (s: string): string =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const title = `${data.symbol}/${data.quoteSym} ${cardPct(BigInt(summary.pnlQuote), basis)} on Friar`;
  const desc = `${open ? "Open position" : "Closed position"} · dynamic-fee liquidity on Robinhood Chain · friar.fi`;
  c.header("Cache-Control", "public, max-age=300");
  return c.html(`<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:type" content="website">
<meta property="og:image" content="${esc(img)}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="${esc(img)}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;600&display=swap" rel="stylesheet">
<style>
  body{margin:0;background:#100c07;color:#8a7a5f;font-family:"IBM Plex Mono",monospace;
    min-height:100vh;display:flex;align-items:center;justify-content:center}
  .wrap{display:flex;flex-direction:column;gap:20px;align-items:center;padding:28px 16px}
  .card{width:min(1000px,94vw);border:1px solid #2a2012;border-radius:12px;display:block}
  .row{display:flex;gap:16px;align-items:center;font-size:13px;flex-wrap:wrap;justify-content:center}
  .brand{letter-spacing:.22em;color:#cf9440;font-weight:600;font-size:15px}
  a.cta{color:#100c07;background:#cf9440;font-weight:600;font-size:14px;
    padding:10px 18px;border-radius:8px;text-decoration:none}
  a.plain{color:#cf9440;text-decoration:none;font-size:14px}
</style>
</head><body>
<div class="wrap">
  <img class="card" src="${esc(img)}" alt="${esc(title)}">
  <div class="row"><span class="brand">FRIAR</span><span>dynamic-fee liquidity on robinhood</span></div>
  <div class="row"><a class="cta" href="https://app.friar.fi?ref=card">open the app →</a><a class="plain" href="https://friar.fi?ref=card">friar.fi</a></div>
</div>
</body></html>`);
});

export default app;
