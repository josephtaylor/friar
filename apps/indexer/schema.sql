-- Friar D1 schema. Apply: wrangler d1 execute friar --file schema.sql [--remote]
-- BigInts are stored as decimal TEXT — SQLite REAL/INTEGER can't hold uint256.

CREATE TABLE IF NOT EXISTS pools (
  pool_id      TEXT PRIMARY KEY,      -- 0x-prefixed 32-byte PoolId
  currency0    TEXT NOT NULL,
  currency1    TEXT NOT NULL,
  fee          INTEGER NOT NULL,
  tick_spacing INTEGER NOT NULL,
  hooks        TEXT NOT NULL,
  ref_pool     TEXT,                  -- optional v3 pool used for true-market marks
  watched      INTEGER NOT NULL DEFAULT 1
);

-- position_id is a GLOBAL namespace across manager deployments: each new manager is
-- constructed with a startingPositionId above the previous high-water mark, so ids never
-- collide and this stays a valid primary key. `manager` records which contract a position
-- lives on so it can be exited against the right address and ABI after an upgrade.
CREATE TABLE IF NOT EXISTS positions (
  position_id  INTEGER PRIMARY KEY,
  manager      TEXT,                  -- NULL on rows written before multi-manager support
  owner        TEXT NOT NULL,
  pool_id      TEXT NOT NULL,
  opened_block INTEGER NOT NULL,
  opened_ts    INTEGER NOT NULL,
  closed_block INTEGER,
  closed_ts    INTEGER,
  -- signed net owner cash flows at open (negative = paid in), decimal strings
  open_delta0  TEXT NOT NULL,
  open_delta1  TEXT NOT NULL,
  -- cumulative signed owner cash flows from increase/decrease after open
  flow0        TEXT NOT NULL DEFAULT '0',
  flow1        TEXT NOT NULL DEFAULT '0',
  -- lifetime fees earned (gross) and perf fee paid
  fees0        TEXT NOT NULL DEFAULT '0',
  fees1        TEXT NOT NULL DEFAULT '0',
  perf0        TEXT NOT NULL DEFAULT '0',
  perf1        TEXT NOT NULL DEFAULT '0'
);
CREATE INDEX IF NOT EXISTS idx_positions_owner ON positions(owner);
-- Every read path keys off the owner and every one of them compares COLLATE NOCASE,
-- because an address arrives from a wallet, a URL or a hand-typed query in any casing. A
-- NOCASE comparison CANNOT use a BINARY-collation index, so the index above was dead
-- weight on exactly the queries it was added for: EXPLAIN showed `SCAN p` on the portfolio
-- history. This one matches the comparison, so it is the one that gets used.
CREATE INDEX IF NOT EXISTS idx_positions_owner_nocase ON positions(owner COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_positions_pool ON positions(pool_id) WHERE closed_ts IS NULL;

CREATE TABLE IF NOT EXISTS position_bins (
  position_id INTEGER NOT NULL,
  bin_index   INTEGER NOT NULL,
  tick_lower  INTEGER NOT NULL,
  tick_upper  INTEGER NOT NULL,
  liquidity   TEXT NOT NULL,          -- current liquidity (updated on increase/decrease)
  PRIMARY KEY (position_id, bin_index)
);

-- Raw decoded manager events, the replay log for accounting.
CREATE TABLE IF NOT EXISTS events (
  block       INTEGER NOT NULL,
  log_index   INTEGER NOT NULL,
  tx_hash     TEXT NOT NULL,
  ts          INTEGER NOT NULL,
  name        TEXT NOT NULL,
  position_id INTEGER,
  pool_id     TEXT,
  data        TEXT NOT NULL,          -- JSON (bigints as strings)
  PRIMARY KEY (block, log_index)
);
CREATE INDEX IF NOT EXISTS idx_events_position ON events(position_id);

-- External (Uniswap v3) pools watched for candles — the incumbent venues. This is
-- where a token's price history lives BEFORE a Friar pool exists (creation-flow
-- charts), and the baseline for our-flow-vs-incumbent volume share after.
CREATE TABLE IF NOT EXISTS v3_pools (
  address TEXT PRIMARY KEY,            -- candles are keyed by this address
  token0  TEXT NOT NULL,
  token1  TEXT NOT NULL,
  fee     INTEGER NOT NULL DEFAULT 0,
  label   TEXT,
  watched INTEGER NOT NULL DEFAULT 1
);

-- 1-minute candles from Swap events. pool_id is EITHER a v4 PoolId (our pools, via
-- the singleton PoolManager) OR a v3 pool address (incumbent venues) — the fold and
-- the API are source-agnostic.
CREATE TABLE IF NOT EXISTS candles (
  pool_id TEXT NOT NULL,
  ts      INTEGER NOT NULL,           -- minute bucket, epoch seconds
  open    TEXT NOT NULL,
  high    TEXT NOT NULL,
  low     TEXT NOT NULL,
  close   TEXT NOT NULL,
  vol0    TEXT NOT NULL,              -- sum |amount0|
  vol1    TEXT NOT NULL,              -- sum |amount1|
  swaps   INTEGER NOT NULL,
  fee_sum INTEGER,                    -- Σ per-swap dynamic fee, pips (v4 Swap events only;
  fee_n   INTEGER,                    --  the indexer ALTERs these onto live DBs — NULL on
  fee_max INTEGER,                    --  v3 pools + pre-migration rows). avg = fee_sum/fee_n
  PRIMARY KEY (pool_id, ts)
);

-- Periodic position marks for portfolio history (5-min cron).
CREATE TABLE IF NOT EXISTS snapshots (
  position_id       INTEGER NOT NULL,
  ts                INTEGER NOT NULL,
  sqrt_price        TEXT NOT NULL,    -- own pool
  market_sqrt_price TEXT,             -- ref venue (true market) when available
  amount0           TEXT NOT NULL,
  amount1           TEXT NOT NULL,
  fees0             TEXT NOT NULL,    -- unclaimed at snapshot
  fees1             TEXT NOT NULL,
  PRIMARY KEY (position_id, ts)
);

-- Dexscreener hot-token cache, refreshed by the token-scan cron. This is the
-- DISCOVERY surface — hot tokens on the chain, most WITHOUT a Friar pool yet (the
-- board's edge: you'd be the pool creator). FACTS ONLY: raw market data + the
-- dominant incumbent fee tier (on-chain, factory-verified). No fit score / labels —
-- that opinion lives in Poacher, not the product. Rows not seen in a run are pruned.
CREATE TABLE IF NOT EXISTS tokens (
  address        TEXT PRIMARY KEY,     -- lowercase 0x…
  symbol         TEXT NOT NULL,
  name           TEXT,                  -- display name (RWA registry tokens; null for memes)
  logo           TEXT,                  -- logo URL (RWA registry tokens)
  kind           TEXT,                  -- 'meme' (Dexscreener discovery) | 'rwa' (official registry); null = legacy meme row
  quote          TEXT,                  -- dominant quote rail, 'WETH' | 'USDG' (stock tokens trade on USDG)
  price_native   REAL NOT NULL,        -- quote units per token (deepest pair; 0 = no pair yet)
  price_usd      REAL,
  ch1            REAL,                  -- price change %, 1h / 6h / 24h
  ch6            REAL,
  ch24           REAL,
  vol24          REAL NOT NULL,         -- volume, USD (summed across pairs), per window
  vol1           REAL,                  -- (vol1/vol6 added post-launch; the scan ALTERs
  vol6           REAL,                  --  them in on live DBs — null until first refresh)
  liq_usd        REAL NOT NULL,         -- liquidity, USD (summed across pairs)
  mcap           REAL,                  -- market cap or FDV
  pools          INTEGER NOT NULL,      -- # dexscreener pairs seen
  incumbent_pool TEXT,                  -- deepest WETH v3 pool / v2 pair (the incumbent venue)
  incumbent_fee  INTEGER,               -- its static fee tier, pips (10000 = 1%; v2 = 3000); null if unresolved
  risk_level     TEXT,                  -- 'ok' | 'warn' (never 'block' — those are dropped); null = unchecked
  risk           TEXT,                  -- JSON array of fired safety flags (see @friar/chain safety.ts)
  updated_ts     INTEGER NOT NULL
);

-- Malicious-token verdicts (Uniswap/Blockaid protectionInfo + GoPlus, merged). Warmed
-- by the scan cron for board tokens; filled on demand by the API's
-- /token/:address/safety for pasted addresses. level 'block' ⇒ the open flow refuses.
CREATE TABLE IF NOT EXISTS token_safety (
  address    TEXT PRIMARY KEY,          -- lowercase 0x…
  level      TEXT NOT NULL,             -- 'ok' | 'warn' | 'block'
  flags      TEXT NOT NULL,             -- JSON array, e.g. ["uniswap:HONEYPOT","goplus:is_mintable"]
  sources    TEXT NOT NULL,             -- JSON array of checkers that answered; [] never stored
  checked_ts INTEGER NOT NULL
);

-- Beta allowlist: the app shell only opens for these wallets (front-door gate;
-- underlying data is public chain data — this is exclusivity, not secrecy).
CREATE TABLE IF NOT EXISTS allowlist (
  address TEXT PRIMARY KEY,             -- lowercase 0x…
  label   TEXT
);

-- Beta access requests: the inbox feeding the allowlist. A row only exists after the
-- API verified BOTH a Turnstile token (server-side siteverify) and a wallet signature
-- over the shared message template (@friar/chain beta.ts) — no unverified writes.
-- Approving = INSERT into allowlist (scripts/beta.mjs approve); status here is
-- bookkeeping for the inbox, the gate itself reads only allowlist.
CREATE TABLE IF NOT EXISTS beta_requests (
  address    TEXT PRIMARY KEY,          -- lowercase 0x…, recovered from the signature
  discord    TEXT NOT NULL,             -- handle to DM the invite to
  note       TEXT,                      -- optional "where do you LP today?"
  status     TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'approved' | 'rejected'
  created_ts INTEGER NOT NULL,
  updated_ts INTEGER NOT NULL
);

-- Browser-side error reports (POST /client-log on the api worker) — the diagnosis
-- companion to `events`. The UI shows only viem's short message; the verbatim error
-- (request-args dump and all) lands here, keyed by wallet so a Discord report
-- ("position 7 failed to close") resolves to one query joined against events/snapshots.
-- Spam-bounded server-side: per-IP rate limit + size caps; rows are disposable.
CREATE TABLE IF NOT EXISTS client_errors (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          INTEGER NOT NULL,         -- server clock, unix seconds
  address     TEXT,                     -- lowercase 0x… (null if wallet not connected)
  action      TEXT NOT NULL,            -- what the user was doing, e.g. "open — approve WETH"
  position_id INTEGER,
  pool_id     TEXT,
  tx_hash     TEXT,                     -- bridge to an on-chain trace when the tx landed
  message     TEXT NOT NULL,            -- raw error, capped at 4k
  url         TEXT,
  ua          TEXT
);
CREATE INDEX IF NOT EXISTS idx_client_errors_address ON client_errors(address);
CREATE INDEX IF NOT EXISTS idx_client_errors_ts ON client_errors(ts);

-- Funnel telemetry (POST /event from the web app). Added 2026-07-25 when the beta gate
-- came off: without this, "nobody came" and "came and bounced before connecting" are
-- indistinguishable, which is exactly how the 07-24 launch failed silently. Deliberately
-- carries NO ip and no account: `visitor` is a random first-party id from localStorage,
-- `session` is per-tab. Disposable — safe to truncate any time.
CREATE TABLE IF NOT EXISTS client_events (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  ts       INTEGER NOT NULL,         -- server clock, unix seconds
  name     TEXT NOT NULL,            -- page_view | wallet_connect | open_plan | open_success | discord_click
  visitor  TEXT,                     -- random localStorage id, not PII, not resolvable to a person
  session  TEXT,                     -- random per-tab id, so sessions can be counted
  path     TEXT,                     -- pathname only (never the query string)
  referrer TEXT,                     -- referring ORIGIN only, not the full url
  source   TEXT,                     -- ?ref= / utm_source, so a campaign is attributable
  address  TEXT,                     -- lowercase 0x… only once a wallet is connected
  meta     TEXT,                     -- tiny JSON for per-event extras, capped
  ua       TEXT
);
CREATE INDEX IF NOT EXISTS idx_client_events_ts ON client_events(ts);
CREATE INDEX IF NOT EXISTS idx_client_events_name_ts ON client_events(name, ts);
CREATE INDEX IF NOT EXISTS idx_client_events_visitor ON client_events(visitor);

-- Per-owner NAV series (2026-08-02): liquid wallet (WETH + native) + open position
-- marks, recorded each snapshot pass. Powers true portfolio-change-over-time. Values
-- are quote-unit wei as TEXT; WETH-rail books assumed (like every cross-position sum).
-- Position values include unclaimed fees NET of the owning manager's perf cut
-- (added 2026-08-02, same pass it launched).
-- `bags` (2026-08-03): loose token balances, valued in the quote rail. An exit that comes
-- back IN KIND (no zap venue, no sweep venue) leaves the position's whole value sitting in
-- the wallet as tokens. Counting only WETH + native made NAV drop by the full position and
-- jump back when the sweep landed — a live book read 0.42 while the wallet held 0.59, and
-- twice in one day that looked like money had vanished. The bag is inventory, not a loss.
CREATE TABLE IF NOT EXISTS nav_snapshots (
  owner     TEXT NOT NULL,
  ts        INTEGER NOT NULL,
  liquid    TEXT NOT NULL,
  positions TEXT NOT NULL,
  bags      TEXT,
  nav       TEXT NOT NULL,
  PRIMARY KEY (owner, ts)
);
