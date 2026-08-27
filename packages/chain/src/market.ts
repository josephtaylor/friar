// Market data for a token: the Dexscreener fold and the on-chain incumbent-fee
// resolution that the /tokens board is built from.
//
// This lives in @friar/chain rather than in the indexer because TWO workers now need
// the same numbers. The indexer folds the whole board on a cron; the API folds a single
// pasted contract address on demand, for a token that may not be on the board at all.
// Those must agree — a "fee/TVL" that means one thing on the board and another on the
// creation screen is worse than not showing it, so there is one definition here and no
// second copy. (Same reasoning as the accounting math in @friar/core.)
//
// FACTS ONLY — raw market data plus the dominant incumbent fee tier, resolved on-chain
// and factory-verified. No fit score, no labels; that selection opinion lives in Poacher.
//
// What is NOT here: the board's discovery net (search terms, the RWA registry leg) and
// its noise floors. Those decide what belongs ON the board. A direct address lookup is
// the user telling us what they want, so it deliberately applies no floors.
import type { PublicClient, Address, Hex } from "viem";
import { ADDRESSES } from "./chain.ts";
import { getSlot0 } from "./stateView.ts";

// This package compiles runtime-agnostic (no DOM/workers libs) — same declaration
// safety.ts uses; browsers, Cloudflare workers, and node >= 18 all have it.
declare const fetch: (url: string) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

const WETH = ADDRESSES.weth.toLowerCase();
const USDG = ADDRESSES.usdg.toLowerCase();

/** Native ETH, as Dexscreener spells it on native-quoted v4 pools. A WETH-equivalent
 * rail: wrapping is free, so arb makes a native venue and a WETH venue the same market —
 * and native is the dominant quote for the chain's launchpad pools, so ignoring it made
 * a token's real main venue invisible to incumbent resolution (STONKBROKER's $2.9M/day
 * native pool lost to its $57k WETH satellite, 2026-08-02). */
const NATIVE = "0x0000000000000000000000000000000000000000";

/** Quote rails, not plays: on a quote-paired venue WETH and USDG themselves aren't LP
 * targets (USDG/WETH is the dollar corridor, not a memecoin). Excluded as base. */
export const QUOTE_RAILS = new Set([WETH, USDG, NATIVE]);
/** The BASE rails: the two currencies a position can be denominated in directly. */
export const RAIL_SYM: Record<string, "WETH" | "USDG"> = { [WETH]: "WETH", [USDG]: "USDG", [NATIVE]: "WETH" };

/**
 * A token's rail is whatever its market is actually quoted in, and on this chain that is
 * no longer just WETH or USDG. Pons launches memecoins against STOCK tokens: INTISMERAN
 * trades $2.6M/day quoted in mrna, VACCINE $369k quoted in mrna, and SPCX alone has twenty
 * meme pairs. Those pools were invisible here, and worse than invisible — `railFor` used to
 * return "WETH" for a token with no rail pair at all, so INTISMERAN folded to a row reading
 * quote WETH whose `price_native` was denominated in MRNA. A consumer that trusted the pair
 * would have sized a position off a price 1/200th of the truth.
 *
 * So a rail is now: the two base rails, PLUS any stock token in the RWA registry. Stock
 * tokens qualify because they are the one other thing on this chain we can always price
 * (the registry is the authority, and they carry deep USDG pools), which is what a rail has
 * to be — not a preference, a routable and priceable unit.
 *
 * `railFor` returns null rather than a default when a token has no rail pair at all. A
 * caller that cannot answer "denominated in what?" must refuse the token, not guess.
 */
export interface RailPair {
  address: string;
  liq: number;
  /** display symbol: "WETH", "USDG", or a stock ticker */
  quote: string;
  /** the quote token's address — what routing actually needs */
  quoteAddr: string;
}

export interface DsPair {
  chainId: string;
  pairAddress: string;
  baseToken: { address: string; symbol: string };
  quoteToken?: { address?: string };
  priceNative?: string;
  priceUsd?: string;
  volume?: { h1?: number; h6?: number; h24?: number };
  liquidity?: { usd?: number };
  marketCap?: number;
  fdv?: number;
  priceChange?: { h1?: number; h6?: number; h24?: number };
}

export interface HotToken {
  addr: string;
  sym: string;
  name: string | null;
  logo: string | null;
  kind: "meme" | "rwa";
  vol: number;
  vol1: number;
  vol6: number;
  liq: number;
  mcap: number;
  pools: number;
  priceNative: number;
  priceUsd: number | null;
  ch1: number | null;
  ch6: number | null;
  ch24: number | null;
  /** Rail-quoted pairs (WETH/USDG/stock), deepest first — incumbent-venue candidates. */
  railPairs: RailPair[];
}

export interface RwaAsset {
  addr: string;
  sym: string;
  name: string;
  logo: string | null;
}

/** The rail the token actually trades on: its deepest rail pair. NULL when it has none —
 * see the RailPair note above for why this must not default. */
export const railFor = (t: HotToken): string | null => t.railPairs[0]?.quote ?? null;
/** …and the pair itself, for callers that need the address to route through. */
export const railPairFor = (t: HotToken): RailPair | null => t.railPairs[0] ?? null;

/** All pairs for known token addresses, 30 per request. `failed` flags a lost chunk so
 * callers can skip a prune instead of delisting every token in it. */
export async function dsTokenPairs(addrs: string[]): Promise<{ pairs: DsPair[]; failed: boolean }> {
  const pairs: DsPair[] = [];
  let failed = false;
  for (let i = 0; i < addrs.length; i += 30) {
    const chunk = addrs.slice(i, i + 30);
    try {
      const r = await fetch(`https://api.dexscreener.com/tokens/v1/robinhood/${chunk.join(",")}`);
      const j = (await r.json()) as DsPair[];
      if (!Array.isArray(j)) throw new Error("unexpected shape");
      pairs.push(...j.filter((p) => /robinhood/i.test(p.chainId)));
    } catch {
      failed = true;
    }
  }
  return { pairs, failed };
}

/** Fold a deduped pair set into per-token aggregates. Registry metadata classifies
 * kind and supplies name/logo; everything else is summed/maxed across pairs. */
export function aggregatePairs(pairs: DsPair[], rwaByAddr: Map<string, RwaAsset>): Record<string, HotToken> {
  const tok: Record<string, HotToken & { _dl: number }> = {};
  for (const p of pairs) {
    const a = p.baseToken.address.toLowerCase();
    if (QUOTE_RAILS.has(a)) continue; // WETH/USDG are quote rails, not plays
    const reg = rwaByAddr.get(a);
    const t =
      tok[a] ||
      (tok[a] = {
        addr: p.baseToken.address,
        sym: reg?.sym ?? p.baseToken.symbol,
        name: reg?.name ?? null,
        logo: reg?.logo ?? null,
        kind: reg ? "rwa" : "meme",
        vol: 0,
        vol1: 0,
        vol6: 0,
        liq: 0,
        mcap: 0,
        pools: 0,
        priceNative: 0,
        priceUsd: null,
        ch1: null,
        ch6: null,
        ch24: null,
        railPairs: [],
        _dl: 0,
      });
    const liq = p.liquidity?.usd ?? 0;
    t.vol += p.volume?.h24 ?? 0;
    t.vol1 += p.volume?.h1 ?? 0;
    t.vol6 += p.volume?.h6 ?? 0;
    t.liq += liq;
    t.mcap = Math.max(t.mcap, p.marketCap ?? p.fdv ?? 0);
    t.pools++;
    const qa = (p.quoteToken?.address ?? "").toLowerCase();
    // base rail, else a stock token from the registry — see RailPair
    const rail = RAIL_SYM[qa] ?? rwaByAddr.get(qa)?.sym ?? null;
    if (rail && Number(p.priceNative) > 0) {
      t.railPairs.push({ address: p.pairAddress, liq, quote: rail, quoteAddr: qa });
    }
    // price + price-action taken from the deepest pool (most reliable print)
    if (liq >= t._dl) {
      t._dl = liq;
      t.priceNative = Number(p.priceNative) || t.priceNative;
      t.priceUsd = p.priceUsd != null ? Number(p.priceUsd) : t.priceUsd;
      t.ch1 = p.priceChange?.h1 ?? null;
      t.ch6 = p.priceChange?.h6 ?? null;
      t.ch24 = p.priceChange?.h24 ?? null;
    }
  }
  for (const t of Object.values(tok)) t.railPairs.sort((a, b) => b.liq - a.liq);
  return Object.fromEntries(Object.entries(tok).map(([k, { _dl, ...t }]) => [k, t]));
}

const v3PoolAbi = [
  { type: "function", name: "fee", stateMutability: "view", inputs: [], outputs: [{ type: "uint24" }] },
  { type: "function", name: "factory", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;

/**
 * The incumbent venue for a token: its deepest rail-quoted (WETH/USDG) pool with a
 * verifiable static fee tier — that tier is what the Friar's dynamic fee competes
 * against. Three venue kinds resolve:
 *  - v4 pools (Dexscreener pairAddress = 32-byte PoolId): slot0.lpFee via StateView.
 *    A Friar pool must never be reported as its own incumbent, and dynamic-fee pools
 *    (lpFee 0 / hook-set garbage) aren't a static tier — only sane values pass.
 *  - v3 pools / v2 pairs: factory-verified (a spoofed `fee()` must not make us claim
 *    a false undercut; v2 pairs charge a fixed 0.30% = 3000 pips).
 * Run server-side so no client fans out RPC of its own.
 */
export async function resolveIncumbent(
  client: PublicClient,
  t: HotToken,
  friarPoolIds: Set<string>,
): Promise<{ pool: string; fee: number } | null> {
  for (const p of t.railPairs.slice(0, 4)) {
    if (/^0x[0-9a-fA-F]{64}$/.test(p.address)) {
      if (friarPoolIds.has(p.address.toLowerCase())) continue;
      try {
        const s = await getSlot0(client, p.address as Hex);
        if (s.sqrtPriceX96 > 0n && s.lpFee > 0 && s.lpFee <= 100_000) {
          return { pool: p.address, fee: s.lpFee };
        }
      } catch {
        /* unreadable pool id */
      }
      continue;
    }
    try {
      const addr = p.address as Address;
      const factory = await client.readContract({ address: addr, abi: v3PoolAbi, functionName: "factory" });
      if (factory.toLowerCase() === ADDRESSES.v3Factory.toLowerCase()) {
        const fee = await client.readContract({ address: addr, abi: v3PoolAbi, functionName: "fee" });
        return { pool: addr, fee: Number(fee) };
      }
      if (factory.toLowerCase() === ADDRESSES.v2Factory.toLowerCase()) {
        return { pool: addr, fee: 3000 };
      }
      continue; // unknown factory — not a venue we compare against
    } catch {
      continue; // not a v3/v2 pool (other-dex row) — try the next-deepest
    }
  }
  return null;
}

/**
 * Market data for ONE token address, folded exactly as the board folds it.
 *
 * Returns null only when Dexscreener knows of no pair for the address on this chain.
 * That is NOT an error for our purposes: a token with no venue yet is precisely the
 * first-LP case, and the caller is expected to render it with blank metrics rather
 * than reject it. Distinguish "no pairs" (null) from "bad address" upstream.
 *
 * `rwaByAddr` is optional because a caller resolving an arbitrary pasted address has no
 * registry in hand; without it a stock token folds as kind "meme" until the board's RWA
 * leg catches up on its next run. That only affects the kind label, never the numbers.
 */
export async function fetchTokenMarket(
  address: string,
  rwaByAddr: Map<string, RwaAsset> = new Map(),
): Promise<HotToken | null> {
  const addr = address.toLowerCase();
  if (QUOTE_RAILS.has(addr)) return null; // a rail is not a play
  const { pairs } = await dsTokenPairs([addr]);
  // The batch endpoint returns every pair each address appears in, including ones where
  // our token is the QUOTE side. aggregatePairs keys on baseToken, so those fold into a
  // different token entirely — take our address's entry, not the first one.
  return aggregatePairs(pairs, rwaByAddr)[addr] ?? null;
}
