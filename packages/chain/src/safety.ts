// Token-safety screening: is this ERC-20 flagged as malicious? Two independent
// sources, merged:
//   - Uniswap's interface gateway (Blockaid-powered protectionInfo) — the data behind
//     app.uniswap.org's token warnings, and it covers chain ROBINHOOD. Unofficial
//     endpoint, so treat it as best-effort: fail-open if it changes or rejects us.
//   - GoPlus token_security — static contract analysis, answers for chain 4663.
// Policy: BLOCK on catastrophic vectors (honeypot, can't buy/sell, hidden owner,
// selfdestruct, owner can rewrite balances); WARN on suspicion (mintable, pausable,
// blacklist function, proxy, unverified source, Blockaid non-benign). A source that
// errors contributes nothing — `sources` records which ones actually answered, so
// callers can tell "clean" from "unchecked".

// This package compiles runtime-agnostic (no DOM/workers libs) — declare the two
// globals this module needs; browsers, Cloudflare workers, and node ≥18 all have them.
declare const fetch: (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: unknown },
) => Promise<{ ok: boolean; json(): Promise<unknown> }>;
declare const AbortSignal: { timeout(ms: number): unknown };

export interface TokenRisk {
  level: "ok" | "warn" | "block";
  flags: string[];
  sources: string[];
  /** Transfer taxes as fractions (0.015 = 1.5%). null means nobody told us, which is NOT
   *  the same as zero and must never be treated as a reason to block. */
  buyTax: number | null;
  sellTax: number | null;
}

const UNISWAP_GQL = "https://interface.gateway.uniswap.org/v1/graphql";
const GOPLUS_URL = "https://api.gopluslabs.io/api/v1/token_security/4663";
const FETCH_TIMEOUT_MS = 8_000;

/**
 * A transfer tax above this blocks the token.
 *
 * This is a hard incompatibility, not a judgement about quality. FriarPositionManager
 * settles an EXACT amount, so when it pulls the token side from a wallet a fee-on-transfer
 * token delivers less than it must settle and the mint reverts. Measured 2026-08-08 across
 * every token the bot has ever traded: 61 tokens, zero taxed, because a taxed one cannot
 * become a position in the first place. Givest tried 7 times and burned 0.0222 WETH.
 */
const MAX_TRANSFER_TAX = 0.001;

// GoPlus "1"-valued fields that make a token un-exitable or owner-ruggable.
const GOPLUS_BLOCK = [
  "is_honeypot",
  "cannot_buy",
  "cannot_sell_all",
  "hidden_owner",
  "selfdestruct",
  "owner_change_balance",
] as const;
// Suspicious but common among live memecoins — surfaced, not blocked.
const GOPLUS_WARN = ["is_mintable", "transfer_pausable", "is_blacklisted", "is_proxy"] as const;

/**
 * Blockaid verdicts that BLOCK rather than warn.
 *
 * SPAM joined MALICIOUS on 2026-08-09, after HOODBIT. The board recorded
 * `["uniswap:SPAM","uniswap:UNSTABLE_TOKEN_PRICE"]` for it at 16:26:05; the bot opened a
 * position at 16:30:25, four minutes later, because a warn does not block. Twenty-five
 * minutes after that the token was down 99% with its liquidity gone from $96,564 to $5,234,
 * and the position came back as 570,054 worthless tokens and 30 microWETH: -0.131 WETH, 85%
 * of that day's entire drawdown.
 *
 * Measured over 181 closes before deciding: the four SPAM-flagged tokens returned -22.98% on
 * capital, and the ten tokens carrying ANY Blockaid flag account for -0.182 of the -0.197
 * total losses. The 171 tokens it called clean are flat at -0.08%. GoPlus saw nothing wrong
 * with HOODBIT on any field it checks, so Blockaid was the only source that knew, and its
 * verdict was being filed rather than acted on.
 *
 * UNSTABLE_TOKEN_PRICE co-occurs on exactly the same four tokens, so it is left as a warn:
 * blocking SPAM already catches them, and the narrower rule is the one the evidence supports.
 */
const UNISWAP_BLOCK_RESULTS: readonly string[] = ["MALICIOUS", "SPAM"];

type GoPlusToken = Record<string, string | undefined>;

/**
 * ONE REQUEST PER ADDRESS, deliberately.
 *
 * `contract_addresses` is documented as comma-separated and this used to send 20 at a time,
 * but on chain 4663 the endpoint returns exactly ONE token however many you pass — measured
 * 2026-08-08 at batch sizes 1, 2, 3, 5, 10, 20 and 30, all of which came back with a single
 * key. So the batching was screening 1 token in 20 and reporting all 20 as checked.
 *
 * That makes each address a subrequest, so callers MUST bound the set (see `goPlusAddresses`)
 * rather than hand this a whole board. Per-address try/catch, because one 429 in the middle
 * of a run should cost that token's verdict and not the other twenty-four.
 */
async function goPlus(addresses: string[]): Promise<Map<string, GoPlusToken>> {
  const out = new Map<string, GoPlusToken>();
  for (const addr of addresses) {
    try {
      const res = await fetch(`${GOPLUS_URL}?contract_addresses=${addr}`, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      const json = (await res.json()) as { result?: Record<string, GoPlusToken> };
      for (const [a, data] of Object.entries(json.result ?? {})) out.set(a.toLowerCase(), data);
    } catch {
      // this token stays unchecked; `sources` will say so
    }
  }
  return out;
}

/** GoPlus reports taxes as decimal strings, and reports "we could not tell" as an empty
 *  string. Both of those must come back null, never 0 — a missing reading that arrives as
 *  zero is indistinguishable from a clean token. */
function taxFraction(raw: string | undefined): number | null {
  if (raw === undefined || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

interface ProtectionInfo {
  result?: string;
  attackTypes?: Array<string | null>;
  /** Blockaid's own tax reading, as FRACTIONS (0.01 = 1%). */
  blockaidFees?: { buy?: number | null; sell?: number | null; transfer?: number | null };
}

interface UniToken {
  protectionInfo?: ProtectionInfo | null;
  /** Uniswap's fee-on-transfer numbers, in BASIS POINTS (100 = 1%). */
  feeData?: { buyFeeBps?: string | number | null; sellFeeBps?: string | number | null } | null;
}

/** Uniswap's tax reading for one token, normalised to fractions. Two fields say it: the
 *  interface's own `feeData` in bps, and Blockaid's in fractions. Measured 2026-08-08 on
 *  ETHEREUM, both agree (Statera and RFI: feeData 100/100, blockaidFees 0.01/0.01) — and
 *  both are null for every token on 4663, including one that demonstrably taxes 1.5%. So
 *  this is a source that costs nothing to ask and cannot yet be relied on. */
function uniTax(t: UniToken | undefined): { buy: number | null; sell: number | null } {
  const bps = (v: string | number | null | undefined): number | null => {
    if (v === null || v === undefined || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n / 10_000 : null;
  };
  const frac = (v: number | null | undefined): number | null =>
    v === null || v === undefined || !Number.isFinite(v) ? null : v;
  const bf = t?.protectionInfo?.blockaidFees;
  const pick = (a: number | null, b: number | null): number | null =>
    a === null ? b : b === null ? a : Math.max(a, b);
  return {
    buy: pick(bps(t?.feeData?.buyFeeBps), frac(bf?.buy)),
    sell: pick(bps(t?.feeData?.sellFeeBps), frac(bf?.sell)),
  };
}

async function uniswapProtection(addresses: string[]): Promise<Map<string, UniToken>> {
  // one aliased query for the whole set — the gateway resolves each token independently
  const fields = addresses
    .map(
      (a, i) =>
        `t${i}: token(chain: ROBINHOOD, address: "${a}") { ` +
        `protectionInfo { result attackTypes blockaidFees { buy sell transfer } } ` +
        `feeData { buyFeeBps sellFeeBps } }`,
    )
    .join("\n");
  const res = await fetch(UNISWAP_GQL, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://app.uniswap.org" },
    body: JSON.stringify({ query: `query {\n${fields}\n}` }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const json = (await res.json()) as { data?: Record<string, UniToken | null> };
  if (!json.data) throw new Error("no data");
  const out = new Map<string, UniToken>();
  addresses.forEach((a, i) => {
    const t = json.data?.[`t${i}`];
    // An entry counts as ANSWERED when the gateway said something about this token, whether
    // that is a protection verdict or a fee reading. A token it returns nothing for stays
    // absent, so `sources` can distinguish clean from unchecked.
    if (t && (t.protectionInfo || t.feeData)) out.set(a.toLowerCase(), t);
  });
  return out;
}

/**
 * Screen a set of token addresses. Returns a lowercase-address-keyed map; every input
 * address gets an entry (level "ok" with empty `sources` when nothing answered).
 *
 * `opts.goPlusAddresses` bounds the GoPlus half to a subset, because it costs one request
 * per address (see `goPlus`). Uniswap's gateway resolves the whole set in one query, so it
 * is always asked about everything. Omit the option to look up all of them, which is only
 * appropriate for a handful.
 */
export async function checkTokenSafety(
  addresses: string[],
  opts: { goPlusAddresses?: string[] } = {},
): Promise<Map<string, TokenRisk>> {
  const addrs = [...new Set(addresses.map((a) => a.toLowerCase()))];
  const wanted = opts.goPlusAddresses
    ? new Set(opts.goPlusAddresses.map((a) => a.toLowerCase()))
    : null;
  const gpTargets = wanted ? addrs.filter((a) => wanted.has(a)) : addrs;
  const [gp, uni] = await Promise.all([
    gpTargets.length ? goPlus(gpTargets).catch(() => null) : null,
    addrs.length ? uniswapProtection(addrs).catch(() => null) : null,
  ]);

  const out = new Map<string, TokenRisk>();
  for (const addr of addrs) {
    const block: string[] = [];
    const warn: string[] = [];
    const sources: string[] = [];

    // A source counts as having ANSWERED only when it returned something about THIS
    // address. Crediting it because the request as a whole succeeded is how the batch bug
    // above stayed invisible: 19 tokens in 20 were reported "goplus checked, clean" with no
    // GoPlus data behind them, and `sources` is the field callers use to tell a clean
    // verdict from an unchecked one.
    const t = uni?.get(addr);
    const p = t?.protectionInfo;
    if (t) sources.push("uniswap");
    if (p) {
      const attacks = (p.attackTypes ?? []).filter((a): a is string => !!a);
      if (attacks.includes("HONEYPOT")) block.push("uniswap:HONEYPOT");
      if (p.result && UNISWAP_BLOCK_RESULTS.includes(p.result)) block.push(`uniswap:${p.result}`);
      else if (p.result && p.result !== "BENIGN") warn.push(`uniswap:${p.result}`);
      for (const a of attacks) if (a !== "HONEYPOT") warn.push(`uniswap:${a}`);
    }

    const g = gp?.get(addr);
    if (g) sources.push("goplus");
    if (g) {
      for (const f of GOPLUS_BLOCK) if (g[f] === "1") block.push(`goplus:${f}`);
      for (const f of GOPLUS_WARN) if (g[f] === "1") warn.push(`goplus:${f}`);
      if (g.is_open_source === "0") warn.push("goplus:unverified_source");
    }

    // Taxes: whichever source will say, worst reading wins. Two independent sources because
    // neither covers 4663 alone — GoPlus answers about one token in six from a Worker's
    // egress, and Uniswap's fee fields are populated on Ethereum but null here.
    const ut = uniTax(t);
    const worst = (a: number | null, b: number | null): number | null =>
      a === null ? b : b === null ? a : Math.max(a, b);
    const buyTax = worst(g ? taxFraction(g.buy_tax) : null, ut.buy);
    const sellTax = worst(g ? taxFraction(g.sell_tax) : null, ut.sell);
    // Fails OPEN: only a POSITIVE reading blocks. 43 of 61 traded tokens come back with no
    // tax reading at all, so blocking on silence would veto most of the board.
    if (buyTax !== null && buyTax > MAX_TRANSFER_TAX) block.push(`tax:buy_${(buyTax * 100).toFixed(2)}%`);
    if (sellTax !== null && sellTax > MAX_TRANSFER_TAX) block.push(`tax:sell_${(sellTax * 100).toFixed(2)}%`);

    out.set(addr, {
      level: block.length ? "block" : warn.length ? "warn" : "ok",
      flags: [...block, ...warn],
      sources,
      buyTax,
      sellTax,
    });
  }
  return out;
}
