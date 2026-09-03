// Client-side pool resolution + open planning. Pure math from @friar/core; chain
// reads via viem against the live RPC (no indexer dependency for planning).
import { createPublicClient, fallback, http, erc20Abi, parseAbiItem, type Address, type Hex } from "viem";
import {
  robinhoodChain,
  ADDRESSES,
  getSlot0,
  getLiquidity,
  poolId,
  DYNAMIC_FEE_FLAG,
  classifyHook,
  feeTierForHook,
  feeTierHooks,
  type HookVerdict,
  type PoolKey,
} from "@friar/chain";
import {
  computeShape,
  binsForDepth,
  getTickAtSqrtPrice,
  getSqrtPriceAtTick,
  price1e18,
  sqrtPriceX96FromPrice,
  amountsForLiquidity,
  liquidityForAmount0,
  liquidityForAmount1,
  simpleRangeTicks,
  type Shape,
  type PlannedBin,
} from "@friar/core";

// fallback() so a 429/outage on one endpoint rolls over instead of failing the read. See
// the rpcUrls comment in @friar/chain: bare http() would pin every call to http[0].
export const publicClient = createPublicClient({
  chain: robinhoodChain,
  transport: fallback(robinhoodChain.rpcUrls.default.http.map((url) => http(url))),
});

export const E18 = 10n ** 18n;

// Base fee is `baseFactor × binStep` and binStep IS the pool's tickSpacing, so with the
// hooks' immutable baseFactor 5000 the base fee is a POOL choice: base% = 0.005 × spacing.
// Moved 100 → 160 on 2026-07-25 (0.50% → 0.80% base) on the strength of the flat-1% A/B
// (notes/harness/ab-vs-flat.mjs, DECISIONS.md): 160 still undercuts the incumbent 1% tier
// by 20bp in calm, but cuts the surge-flow retention needed to beat a flat 1% LP from 50%
// to 34% and has the best pessimistic floor. No new hook — the hooklist allowlists the
// HOOK, not the pool.
//
// USDG-rail pairs keep 100: that rail is the stock/RWA tokens, whose ranges are tight, and
// 160 gives 1.61%-wide bins — a ±2% range would be ~2 bins and the shape picker would be
// meaningless. Spacing is per-pool, so this is genuinely a per-rail decision.
const DEFAULT_SPACING = 160;
const STABLE_RAIL_SPACING = 100;

export const defaultSpacingFor = (quote: Address): number =>
  quote.toLowerCase() === ADDRESSES.usdg.toLowerCase() ? STABLE_RAIL_SPACING : DEFAULT_SPACING;
const WING_SAFETY_BPS = 9_500n;
const STALE_SYNC_PCT = 8; // live pool this far off market → sync it to market on open

export interface TokenInfo {
  address: Address;
  symbol: string;
  decimals: number;
}

export async function fetchToken(address: Address): Promise<TokenInfo> {
  const [symbol, decimals] = await Promise.all([
    publicClient.readContract({ address, abi: erc20Abi, functionName: "symbol" }),
    publicClient.readContract({ address, abi: erc20Abi, functionName: "decimals" }),
  ]);
  return { address, symbol, decimals };
}

export function poolKeyFor(
  token: Address,
  quote: Address = ADDRESSES.weth as Address,
  spacing = defaultSpacingFor(quote),
): { key: PoolKey; quoteIs0: boolean } {
  const quoteIs0 = quote.toLowerCase() < token.toLowerCase();
  const [currency0, currency1] = quoteIs0 ? [quote, token] : [token, quote];
  return {
    key: { currency0, currency1, fee: DYNAMIC_FEE_FLAG, tickSpacing: spacing, hooks: ADDRESSES.friarStandard },
    quoteIs0,
  };
}

/**
 * The PoolKey a fresh pool would be CREATED under. `feeHook` is the chosen FriarTier fee-tier
 * hook (base fee lives in the hook, so which hook = which fee); when omitted — no tiers
 * deployed yet, or the legacy path — it falls back to the V1 standard hook. Base fee being in
 * the hook means there's no config: the caller opens with plain `openNew`. Joining a live pool
 * never goes through here; it uses whatever hook that pool already has.
 */
export function createPoolKeyFor(
  token: Address,
  quote: Address = ADDRESSES.weth as Address,
  spacing = defaultSpacingFor(quote),
  feeHook?: Address,
): { key: PoolKey; quoteIs0: boolean } {
  const hooks = feeHook ?? (ADDRESSES.friarStandard as Address);
  const quoteIs0 = quote.toLowerCase() < token.toLowerCase();
  const [currency0, currency1] = quoteIs0 ? [quote, token] : [token, quote];
  return { key: { currency0, currency1, fee: DYNAMIC_FEE_FLAG, tickSpacing: spacing, hooks }, quoteIs0 };
}

export interface PoolState {
  live: boolean;
  sqrtPriceX96: bigint;
  tick: number;
  lpFee: number;
}

export async function fetchPoolState(key: PoolKey): Promise<PoolState> {
  const slot0 = await getSlot0(publicClient, poolId(key));
  if (slot0.sqrtPriceX96 > 0n) return { live: true, sqrtPriceX96: slot0.sqrtPriceX96, tick: slot0.tick, lpFee: slot0.lpFee };
  return { live: false, sqrtPriceX96: 0n, tick: 0, lpFee: 0 };
}

/**
 * Every v4 pool ever initialized for a pair, straight from the PoolManager's
 * Initialize logs — any fee/tickSpacing/hooks combination. This is what finds hooked
 * incumbent venues (launchpad hooks etc.) that no fixed candidate list can guess.
 * Cached per pair: the 6s replan loop must not re-scan the chain.
 */
const initializeEvent = parseAbiItem(
  "event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)",
);
const v4PoolCache = new Map<string, Promise<PoolKey[]>>();
export function discoverV4Pools(currency0: Address, currency1: Address): Promise<PoolKey[]> {
  const cacheKey = `${currency0}/${currency1}`.toLowerCase();
  const hit = v4PoolCache.get(cacheKey);
  if (hit) return hit;
  const scan = publicClient
    .getLogs({
      address: ADDRESSES.poolManager as Address,
      event: initializeEvent,
      args: { currency0, currency1 },
      fromBlock: 0n,
    })
    .then((logs) =>
      logs.map((l) => ({
        currency0,
        currency1,
        fee: Number(l.args.fee),
        tickSpacing: Number(l.args.tickSpacing),
        hooks: l.args.hooks as Address,
      })),
    )
    .catch(() => {
      v4PoolCache.delete(cacheKey); // transient RPC failure — retry on the next plan
      return [] as PoolKey[];
    });
  v4PoolCache.set(cacheKey, scan);
  return scan;
}

/**
 * What did the user paste? A 64-hex id is a v4 PoolId (bring-your-own-pool); a 40-hex
 * string is an address — an ERC-20 or a v3 pool, the chain probe decides. Bare values
 * and pasted URLs (Dexscreener links embed the id/address in the path) both work.
 * Order matters: a 64-hex id contains a 40-hex substring.
 */
export interface PastedTarget {
  kind: "pool" | "address";
  value: `0x${string}`;
}
export function parsePastedTarget(raw: string): PastedTarget | null {
  const s = raw.trim();
  const m64 = s.match(/0x[0-9a-fA-F]{64}/);
  if (m64) return { kind: "pool", value: m64[0] as `0x${string}` };
  const m40 = s.match(/0x[0-9a-fA-F]{40}/);
  if (m40) return { kind: "address", value: m40[0] as `0x${string}` };
  return null;
}

/** PoolId → PoolKey. Ids are keccak hashes so they can't be reversed — but Initialize
 * indexes the id, so one topic-filtered log query recovers the full key. Cached. */
const poolKeyByIdCache = new Map<string, Promise<PoolKey | null>>();
export function poolKeyById(id: Hex): Promise<PoolKey | null> {
  const cacheKey = id.toLowerCase();
  const hit = poolKeyByIdCache.get(cacheKey);
  if (hit) return hit;
  const scan = publicClient
    .getLogs({ address: ADDRESSES.poolManager as Address, event: initializeEvent, args: { id }, fromBlock: 0n })
    .then((logs) => {
      const l = logs[0];
      if (!l) return null;
      return {
        currency0: l.args.currency0 as Address,
        currency1: l.args.currency1 as Address,
        fee: Number(l.args.fee),
        tickSpacing: Number(l.args.tickSpacing),
        hooks: l.args.hooks as Address,
      };
    })
    .catch(() => {
      poolKeyByIdCache.delete(cacheKey); // transient RPC failure — retry on next paste
      return null;
    });
  poolKeyByIdCache.set(cacheKey, scan);
  return scan;
}

/** A pasted v4 pool resolved for the open flow: which side the UI treats as the quote,
 * which as the token, and the hook verdict (block-level pools never reach planning).
 * Quote orientation: USDG > WETH > Dexscreener's listed quote side > currency1. When
 * neither side is a rail (`railQuote` false) the caller must safety-screen BOTH sides
 * and PnL displays in the quote token's own terms (no USD path yet). */
export interface ResolvedPool {
  key: PoolKey;
  quoteIs0: boolean;
  quoteAddress: Address;
  tokenAddress: Address;
  railQuote: "WETH" | "USDG" | null;
  verdict: HookVerdict;
}
export async function resolvePastedPool(id: Hex): Promise<ResolvedPool | { error: string }> {
  const key = await poolKeyById(id);
  if (!key) return { error: "no v4 pool with that id found on Robinhood Chain" };
  const c0 = key.currency0.toLowerCase();
  const c1 = key.currency1.toLowerCase();
  if (c0 === ZERO_ADDR.toLowerCase() || c1 === ZERO_ADDR.toLowerCase())
    return { error: "that pool is native-ETH — Friar positions need ERC-20 pairs; look for the WETH-quoted pool instead" };
  const usdg = ADDRESSES.usdg.toLowerCase();
  const weth = ADDRESSES.weth.toLowerCase();
  // prefer USDG as the quote when both sides are rails (dollar terms beat ETH terms)
  let quoteIs0: boolean;
  let railQuote: ResolvedPool["railQuote"] = null;
  if (c0 === usdg || c1 === usdg) {
    railQuote = "USDG";
    quoteIs0 = c0 === usdg;
  } else if (c0 === weth || c1 === weth) {
    railQuote = "WETH";
    quoteIs0 = c0 === weth;
  } else {
    // token/token pool — orient by Dexscreener's listing when it knows the pair,
    // else fall back to currency1-as-quote (the v3/v4 sorting convention)
    quoteIs0 = false;
    try {
      const res = await fetch(`https://api.dexscreener.com/latest/dex/pairs/robinhoodchain/${id}`);
      const data = (await res.json()) as { pairs?: Array<{ quoteToken?: { address?: string } }> };
      const q = data.pairs?.[0]?.quoteToken?.address?.toLowerCase();
      if (q === c0) quoteIs0 = true;
    } catch {
      // unlisted pair — currency1 stays the quote
    }
  }
  const quoteAddress = (quoteIs0 ? key.currency0 : key.currency1) as Address;
  const tokenAddress = (quoteIs0 ? key.currency1 : key.currency0) as Address;
  return { key, quoteIs0, quoteAddress, tokenAddress, railQuote, verdict: classifyHook(key.hooks as Address) };
}

const v3PairProbeAbi = [
  { type: "function", name: "token0", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "token1", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;

/** Is this address a v2/v3 pool? (Dexscreener rows paste as pair addresses.) */
export async function probePairAddress(addr: Address): Promise<{ token0: Address; token1: Address } | null> {
  try {
    const [token0, token1] = await Promise.all([
      publicClient.readContract({ address: addr, abi: v3PairProbeAbi, functionName: "token0" }),
      publicClient.readContract({ address: addr, abi: v3PairProbeAbi, functionName: "token1" }),
    ]);
    return { token0, token1 };
  } catch {
    return null;
  }
}

/** Max % a swap venue's spot price may deviate from the market reference before we
 * refuse to trade there. A venue outside the band isn't "expensive", it's wrong —
 * position 13's close zapped into a pool sitting 2× off market and realized half the
 * token side's value. 15% clears real venue spreads (≤3% fee + impact on thin books)
 * while rejecting stale or manipulated prices. */
export const MAX_VENUE_DEV_PCT = 15;

/** True when `sqrtPriceX96` prices within ±maxDevPct of the reference price. */
export function priceBandOk(refSqrtPriceX96: bigint, sqrtPriceX96: bigint, maxDevPct = MAX_VENUE_DEV_PCT): boolean {
  if (refSqrtPriceX96 <= 0n || sqrtPriceX96 <= 0n) return false;
  const ratio = (Number(sqrtPriceX96) / Number(refSqrtPriceX96)) ** 2;
  const dev = ratio >= 1 ? ratio : 1 / ratio;
  return dev <= 1 + maxDevPct / 100;
}

/** Ceiling for the estimated impact of selling a close's token side into the home
 * pool's REMAINING (post-burn) active liquidity. Under it, the home pool is allowed
 * as the exit venue — the exit fee stays with the remaining Friar LPs instead of
 * leaking to an outside pool. */
export const MAX_HOME_EXIT_IMPACT_PCT = 3;

/** Small-move estimate of the % price impact of selling `amountIn` into constant
 * active liquidity (ignores bin-crossing — fine for a gate, the minReceive floor
 * backstops). Δ√P/√P = y·Q96/(L·√P) selling currency1; x·√P/(L·Q96) selling
 * currency0; price moves ~2× its sqrt. */
export function estimateSellImpactPct(
  liquidity: bigint,
  sqrtPriceX96: bigint,
  amountIn: bigint,
  sellIsCurrency0: boolean,
): number {
  if (liquidity <= 0n || sqrtPriceX96 <= 0n) return Number.POSITIVE_INFINITY;
  const L = Number(liquidity);
  const sqrtP = Number(sqrtPriceX96);
  const Q96 = 2 ** 96;
  const relSqrt = sellIsCurrency0 ? (Number(amountIn) * sqrtP) / (L * Q96) : (Number(amountIn) * Q96) / (L * sqrtP);
  return 2 * relSqrt * 100;
}

/**
 * Best v4 swap venue for a pair: deepest-liquidity pool among the standard hookless
 * tiers, our own Friar pool, anything the indexer already watches, and every pool the
 * PoolManager's Initialize logs reveal (hooked launchpad venues included). In-unlock
 * swaps can only touch v4 pools — a token with only v3 liquidity genuinely can't be
 * zapped in-unlock, hence the v3 pre-swap fallback in planOpen.
 *
 * `refSqrtPriceX96` is the execution-sanity anchor: pass the true-market mark and any
 * venue priced outside MAX_VENUE_DEV_PCT of it is discarded no matter how deep it is —
 * depth at a wrong price is how the position-13 exit lost half its token side.
 */
export async function findSwapVenue(
  currency0: Address,
  currency1: Address,
  excludePoolId?: string,
  refSqrtPriceX96?: bigint,
): Promise<{ key: PoolKey; liquidity: bigint; slot0: { sqrtPriceX96: bigint; tick: number; lpFee: number } } | null> {
  const candidates: PoolKey[] = [
    // standard hookless tiers
    { currency0, currency1, fee: 100, tickSpacing: 1, hooks: ZERO_ADDR },
    { currency0, currency1, fee: 500, tickSpacing: 10, hooks: ZERO_ADDR },
    { currency0, currency1, fee: 3000, tickSpacing: 60, hooks: ZERO_ADDR },
    { currency0, currency1, fee: 10000, tickSpacing: 200, hooks: ZERO_ADDR },
    // our own dynamic-fee pools — both the current default spacing and the legacy 100
    // (fast-path seeds only; discoverV4Pools below is the real authority)
    { currency0, currency1, fee: DYNAMIC_FEE_FLAG, tickSpacing: DEFAULT_SPACING, hooks: ADDRESSES.friarStandard },
    { currency0, currency1, fee: DYNAMIC_FEE_FLAG, tickSpacing: STABLE_RAIL_SPACING, hooks: ADDRESSES.friarStandard },
  ];
  try {
    const res = await fetch(`${API_BASE}/pools`);
    const data = (await res.json()) as {
      pools?: Array<{ currency0: string; currency1: string; fee: number; tick_spacing: number; hooks: string }>;
    };
    for (const p of data.pools ?? []) {
      if (p.currency0.toLowerCase() === currency0.toLowerCase() && p.currency1.toLowerCase() === currency1.toLowerCase()) {
        candidates.push({
          currency0,
          currency1,
          fee: p.fee,
          tickSpacing: p.tick_spacing,
          hooks: p.hooks as Address,
        });
      }
    }
  } catch {
    // indexer API down — standard candidates still probed
  }
  // the chain itself is the authority: every initialized pool for the pair, any hook
  candidates.push(...(await discoverV4Pools(currency0, currency1)));

  const seen = new Set<string>();
  const unique = candidates.filter((k) => {
    const id = poolId(k);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });

  const probed = await Promise.all(
    unique.map(async (key) => {
      try {
        const id = poolId(key);
        const [liquidity, slot0] = await Promise.all([getLiquidity(publicClient, id), getSlot0(publicClient, id)]);
        return { key, liquidity, slot0 };
      } catch {
        return null;
      }
    }),
  );
  const live = probed.filter(
    (p): p is NonNullable<typeof p> =>
      p !== null &&
      p.liquidity > 0n &&
      p.slot0.sqrtPriceX96 > 0n &&
      (excludePoolId === undefined || poolId(p.key).toLowerCase() !== excludePoolId.toLowerCase()) &&
      (refSqrtPriceX96 === undefined || priceBandOk(refSqrtPriceX96, p.slot0.sqrtPriceX96)),
  );
  if (!live.length) return null;
  live.sort((a, b) => (b.liquidity > a.liquidity ? 1 : -1));
  return live[0]!;
}

const ZERO_ADDR = "0x0000000000000000000000000000000000000000" as Address;
const API_BASE = (import.meta as unknown as { env: Record<string, string | undefined> }).env.VITE_API_URL ?? "http://localhost:8788";

/** SwapRouter02.swapExactTokensForTokens — the v2 pre-swap leg (the 02 router's v2
 * functions take no deadline). The router resolves the pair from its own factoryV2. */
export const v2RouterAbi = [
  {
    type: "function",
    name: "swapExactTokensForTokens",
    stateMutability: "payable",
    inputs: [
      { name: "amountIn", type: "uint256" },
      { name: "amountOutMin", type: "uint256" },
      { name: "path", type: "address[]" },
      { name: "to", type: "address" },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
] as const;

/** SwapRouter02.exactInputSingle — the v3 pre-swap leg for 7702 batches. */
export const v3RouterAbi = [
  {
    type: "function",
    name: "exactInputSingle",
    stateMutability: "payable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "recipient", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "amountOutMinimum", type: "uint256" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
] as const;

const v3PoolAbi = [
  { type: "function", name: "fee", stateMutability: "view", inputs: [], outputs: [{ type: "uint24" }] },
  { type: "function", name: "factory", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;

/** An incumbent pool the SwapRouter02 can trade for us. `fee` is pips (1e6-scaled)
 * either way — v2 pairs charge a fixed 0.30% (3000). */
export interface RouterPool {
  kind: "v3" | "v2";
  address: Address;
  fee: number;
  priceNative: number;
}

/**
 * Deepest router-tradable pool of `token` against `quote` (WETH by default) via
 * Dexscreener, factory-verified on-chain: canonical v3 pools AND canonical v2 pairs
 * (some tokens' only real venue is v2 — e.g. utopia's $68k WETH pair). `priceNative`
 * is in the QUOTE's terms (quote per token) since we filter to quote-quoted pairs.
 * Spoof-guard: v3 legs only through canonical-factory pools; v2 legs are implicitly
 * safe — the router resolves the pair from its own factoryV2, the listing only
 * supplies the min-out price.
 */
export async function findRouterPool(
  token: Address,
  quote: Address = ADDRESSES.weth as Address,
): Promise<RouterPool | null> {
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${token}`);
    const data = (await res.json()) as {
      pairs?: Array<{ chainId: string; pairAddress: string; priceNative: string; labels?: string[]; liquidity?: { usd?: number }; quoteToken?: { address?: string } }>;
    };
    const pairs = (data.pairs ?? [])
      .filter((p) => /robinhood/i.test(p.chainId) && Number(p.priceNative) > 0)
      .filter((p) => (p.quoteToken?.address ?? "").toLowerCase() === quote.toLowerCase())
      .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
    for (const p of pairs.slice(0, 6)) {
      try {
        const addr = p.pairAddress as Address;
        // v3 pools and v2 pairs both expose factory(); v4 rows are 32-byte ids and throw
        const factory = await publicClient.readContract({ address: addr, abi: v3PoolAbi, functionName: "factory" });
        if (factory.toLowerCase() === ADDRESSES.v3Factory.toLowerCase()) {
          const fee = await publicClient.readContract({ address: addr, abi: v3PoolAbi, functionName: "fee" });
          return { kind: "v3", address: addr, fee, priceNative: Number(p.priceNative) };
        }
        if (factory.toLowerCase() === ADDRESSES.v2Factory.toLowerCase()) {
          return { kind: "v2", address: addr, fee: 3000, priceNative: Number(p.priceNative) };
        }
        continue; // unknown factory — not a venue we'll route through
      } catch {
        continue; // not a v3/v2 pool (v4/other dex row) — try next
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Seed price (sqrtPriceX96) for a not-yet-created pool, from Dexscreener. The reference
 * is `quote per token`: for a WETH quote that's the deepest WETH-pair's native price; for
 * a USDG quote it's the token's USD price (USDG ≈ USD), so a token needn't already have a
 * USDG pool to seed one. Decimals + orientation handled by the tested core seeder.
 */
export async function referenceSqrtPrice(
  token: Address,
  quoteIs0: boolean,
  tokenDecimals: number,
  quoteDecimals: number,
  quote: Address = ADDRESSES.weth as Address,
): Promise<bigint | null> {
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${token}`);
    const data = (await res.json()) as {
      pairs?: Array<{ chainId: string; priceNative: string; priceUsd?: string; liquidity?: { usd?: number }; quoteToken?: { address?: string } }>;
    };
    const pairs = (data.pairs ?? []).filter((p) => /robinhood/i.test(p.chainId));
    if (!pairs.length) return null;
    const byLiq = [...pairs].sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
    const best = byLiq[0]!;
    const isWeth = quote.toLowerCase() === ADDRESSES.weth.toLowerCase();

    let quotePerToken: number;
    if (isWeth) {
      // WETH per token — a WETH- or native-ETH-quoted pair's priceNative is unit-safe.
      // Any OTHER quote's priceNative is in THAT token's units (an AAPL-quoted meme
      // would seed a WETH pool ~9x off and get arbed at init) — for those, derive from
      // the unit-safe priceUsd through the WETH rate instead.
      const wethLike = new Set([ADDRESSES.weth.toLowerCase(), ZERO_ADDR.toLowerCase()]);
      const w = byLiq.find((p) => wethLike.has((p.quoteToken?.address ?? "").toLowerCase()));
      if (w) {
        quotePerToken = Number(w.priceNative);
      } else {
        const rate = await fetch(`${API_BASE}/rate`)
          .then((r) => r.json() as Promise<{ usdPerWeth: number | null }>)
          .then((j) => j.usdPerWeth)
          .catch(() => null);
        if (!rate || !(rate > 0)) return null;
        quotePerToken = Number(best.priceUsd) / rate;
      }
    } else {
      // USDG per token ≈ USD per token (the deepest pair's USD price)
      quotePerToken = Number(best.priceUsd);
    }
    if (!(quotePerToken > 0)) return null;
    return sqrtPriceX96FromPrice(quotePerToken, tokenDecimals, quoteDecimals, quoteIs0);
  } catch {
    return null;
  }
}

export interface TokenSafety {
  level: "ok" | "warn" | "block";
  flags: string[];
  sources: string[];
}

/** Safety flags for humans: "goplus:is_mintable" → "mintable", "uniswap:HONEYPOT" →
 * "honeypot". Deduped — both checkers can fire the same vector. */
export function prettyRiskFlags(flags: string[]): string[] {
  return [
    ...new Set(
      flags.map((f) => (f.split(":").pop() ?? f).replace(/^is_/, "").replace(/_/g, " ").toLowerCase()),
    ),
  ];
}

/** Malicious-token verdict from the API (Uniswap/Blockaid + GoPlus, D1-cached).
 * null = API unreachable — fail open, the board is already server-side filtered. */
const safetyCache = new Map<string, Promise<TokenSafety | null>>();
export function fetchTokenSafety(address: Address): Promise<TokenSafety | null> {
  const addr = address.toLowerCase();
  const hit = safetyCache.get(addr);
  if (hit) return hit;
  const req = fetch(`${API_BASE}/token/${addr}/safety`)
    .then((r) => (r.ok ? (r.json() as Promise<TokenSafety>) : null))
    .catch(() => {
      safetyCache.delete(addr); // transient — retry on the next plan
      return null;
    });
  safetyCache.set(addr, req);
  return req;
}

export interface OpenPlanInput {
  token: TokenInfo;
  /** Quote/base token the position pairs against (WETH or USDG). */
  quote: Address;
  quoteDecimals: number;
  shape: Shape;
  depthBelowPct: number;
  depthAbovePct: number;
  /** "both" = deposit both tokens; "zap" = WETH only, wing bought in-unlock */
  mode: "both" | "zap";
  amountQuote: bigint; // WETH budget (bids; in zap mode: bids + wing)
  amountBase: bigint; // token budget for asks ("both" mode only)
  wingPct: number; // zap mode: % of quote spent buying the ask side (ignored in simple mode)
  /** Simple mode: ONE bin spanning the whole range (v3-style single range) instead of a
   * shaped bin ladder. Pays the manager's simple fee tier. Zap wing is auto-sized from
   * the range geometry — no wing dial. */
  simple?: boolean;
  /** Bring-your-own-pool: plan against this exact pool instead of deriving the Friar
   * key from token+quote. Never creates or syncs the pool; drift is informational. */
  explicit?: { key: PoolKey; quoteIs0: boolean } | null;
  /**
   * The pool the user picked in the selector, when the selector is driving:
   *   - `{ kind: "join", key }` — an existing Friar pool chosen from the dropdown; plan
   *     against it exactly (join, with sync). No anti-fork guessing.
   *   - `{ kind: "create", feeHook, spacing }` — "Create a new pool": the chosen tier hook
   *     and bin width. `feeHook` is the FriarTier hook (base fee lives in the hook).
   * Absent = legacy auto-derive (rail default spacing, standard hook, anti-fork to the
   * deepest existing pool). Ignored when `explicit` (a brought pool) is set.
   */
  poolChoice?: { kind: "join"; key: PoolKey } | { kind: "create"; feeHook?: Address; spacing?: number };
}

export interface OpenPlan {
  key: PoolKey;
  quoteIs0: boolean;
  pool: PoolState;
  initSqrtPrice: bigint | null; // set when pool must be created (openNew)
  bins: PlannedBin[];
  contractBins: Array<{ tickLower: number; tickUpper: number; liquidity: bigint }>;
  swapIn: { enabled: boolean; venue: PoolKey; zeroForOne: boolean; amountIn: bigint; minAmountOut: bigint; sqrtPriceLimitX96: bigint };
  /** true when the in-unlock swapIn is a POOL SYNC (slide a stale/empty pool to market)
   * rather than a wing buy — the UI shows a cost/confirm dialog for this. */
  willSync: boolean;
  /** the price the bins are actually placed around — the live/market price the pool will
   * hold at mint (market when syncing; the pool's own price otherwise). The chart anchors
   * here, NOT at a stale pool's frozen tick. */
  anchorTick: number;
  anchorSqrt: bigint;
  /** Router pre-swap leg (7702 batch only): set when the wing must be bought on an
   * incumbent v3 pool or v2 pair via SwapRouter02 (no in-unlock v4 venue exists). */
  routerSwap: { kind: "v3" | "v2"; pool: Address; fee: number; amountIn: bigint; minOut: bigint } | null;
  maxPay0: bigint;
  maxPay1: bigint;
  needsQuote: bigint; // WETH to approve
  needsBase: bigint; // token to approve
  /** For a LIVE pool: how far its price sits from the deep market reference. A big drift
   * = a stale/ghost pool (common early on when nothing has traded it back to market);
   * opening a balanced position anchors to the stale price → instant arb bait. */
  drift: { poolTick: number; marketTick: number; pricePct: number } | null;
  error: string | null;
}

const isRailQuote = (quote: Address): boolean => {
  const q = quote.toLowerCase();
  return q === ADDRESSES.weth.toLowerCase() || q === ADDRESSES.usdg.toLowerCase();
};

/** A live Friar pool for a pair, as offered in the open flow's pool dropdown. */
export interface FriarPoolOption {
  key: PoolKey;
  state: PoolState;
  liquidity: bigint;
  /** base fee % from the FriarTier tier, or null for a legacy (non-tier) Friar pool */
  feePct: number | null;
  spacing: number;
}

/** Every LIVE Friar-hooked pool for a pair (all tiers × spacings + legacy hooks), deepest
 * first. This is what populates the pool selector so an LP picks an existing pool from a list
 * instead of guessing a (tier, width) combo that may not exist. Cached via discoverV4Pools. */
export async function discoverFriarPools(currency0: Address, currency1: Address): Promise<FriarPoolOption[]> {
  const ours = new Set([
    ADDRESSES.friarStandard.toLowerCase(),
    ADDRESSES.friarCalm.toLowerCase(),
    ADDRESSES.friarV2.toLowerCase(),
    ...feeTierHooks().map((h) => h.toLowerCase()),
  ]);
  const keys = (await discoverV4Pools(currency0, currency1)).filter((k) => ours.has(k.hooks.toLowerCase()));
  const probed = await Promise.all(
    keys.map(async (key): Promise<FriarPoolOption | null> => {
      try {
        const state = await fetchPoolState(key);
        if (!state.live) return null;
        const liquidity = await getLiquidity(publicClient, poolId(key));
        if (liquidity <= 0n) return null;
        return { key, state, liquidity, feePct: feeTierForHook(key.hooks)?.pct ?? null, spacing: key.tickSpacing };
      } catch {
        return null;
      }
    }),
  );
  const live = probed.filter((p): p is FriarPoolOption => p !== null);
  live.sort((a, b) => (b.liquidity > a.liquidity ? 1 : b.liquidity < a.liquidity ? -1 : 0));
  return live;
}

/** Deepest live Friar pool, or null. The legacy auto-join fallback (pre-selector). */
async function findExistingFriarPool(
  currency0: Address,
  currency1: Address,
): Promise<{ key: PoolKey; state: PoolState } | null> {
  const [deepest] = await discoverFriarPools(currency0, currency1);
  return deepest ? { key: deepest.key, state: deepest.state } : null;
}

export async function planOpen(input: OpenPlanInput): Promise<OpenPlan> {
  // Key derivation, in priority order: a brought pool, then the selector's explicit choice
  // (join a specific pool, or create at a chosen tier+width), then the legacy auto-derive.
  const derive = (): { key: PoolKey; quoteIs0: boolean } => {
    if (input.explicit) return input.explicit;
    const c = input.poolChoice;
    if (c?.kind === "join") return { key: c.key, quoteIs0: c.key.currency0.toLowerCase() === input.quote.toLowerCase() };
    if (c?.kind === "create")
      return createPoolKeyFor(input.token.address, input.quote, c.spacing ?? defaultSpacingFor(input.quote), c.feeHook);
    return createPoolKeyFor(input.token.address, input.quote, defaultSpacingFor(input.quote));
  };
  let { key, quoteIs0 } = derive();
  let pool = await fetchPoolState(key);

  // Legacy anti-fork: when NOTHING explicit is driving (no brought pool, no selector choice),
  // a fresh derived pool auto-joins the deepest existing Friar pool instead of forking depth.
  // The selector supersedes this — once it drives, the user's pick is authoritative and a
  // "create" is a real create, so we do NOT silently swap them onto a different pool.
  if (!input.explicit && !input.poolChoice && !pool.live) {
    const existing = await findExistingFriarPool(key.currency0 as Address, key.currency1 as Address);
    if (existing) {
      key = existing.key;
      pool = existing.state;
    }
  }

  // bring-your-own-pool: re-verify the hook here too (resolution already screens, but
  // planning is the last gate before calldata) and never create the pool ourselves
  if (input.explicit) {
    const hv = classifyHook(key.hooks as Address);
    if (hv.level === "block") return emptyPlan(key, quoteIs0, pool, hv.reasons[0] ?? "this pool's hook is unsafe to LP");
    if (!pool.live) return emptyPlan(key, quoteIs0, pool, "that pool isn't initialized on-chain");
  }

  // hard gate: no plans for flagged-malicious tokens (honeypot / can't-sell / ruggable);
  // in a token/token pool the quote side is an arbitrary token too — screen both
  const safety = await fetchTokenSafety(input.token.address);
  if (safety?.level === "block")
    return emptyPlan(key, quoteIs0, pool, `${input.token.symbol} is flagged as malicious (${prettyRiskFlags(safety.flags).join(", ")}) — opening positions in it is disabled`);
  const railQuote = isRailQuote(input.quote);
  if (!railQuote) {
    const qSafety = await fetchTokenSafety(input.quote);
    if (qSafety?.level === "block")
      return emptyPlan(key, quoteIs0, pool, `the quote side is flagged as malicious (${prettyRiskFlags(qSafety.flags).join(", ")}) — opening positions in it is disabled`);
  }

  let initSqrtPrice: bigint | null = null;
  let sqrtPrice = pool.sqrtPriceX96;
  let tick = pool.tick;
  let drift: OpenPlan["drift"] = null;
  let needsSync = false;
  let marketSqrt = 0n; // sync target (market sqrtPriceX96) when needsSync
  if (!pool.live) {
    initSqrtPrice = await referenceSqrtPrice(input.token.address, quoteIs0, input.token.decimals, input.quoteDecimals, input.quote);
    if (initSqrtPrice === null)
      return emptyPlan(key, quoteIs0, pool, "pool doesn't exist and no market reference found on Dexscreener");
    sqrtPrice = initSqrtPrice;
    tick = getTickAtSqrtPrice(sqrtPrice);
  } else if (railQuote) {
    // live pool → measure how far it's drifted from the market reference (Dexscreener,
    // same seeding math as pool creation; rail quotes only — token/token pairs have no
    // single-lookup reference). Big drift ⇒ stale/ghost pool; surface it so the opener
    // can warn (and, on our own pools, auto-sync to market before minting).
    const refSqrt = await referenceSqrtPrice(input.token.address, quoteIs0, input.token.decimals, input.quoteDecimals, input.quote);
    if (refSqrt !== null) {
      const marketTick = getTickAtSqrtPrice(refSqrt);
      const pricePct = Math.abs(Math.pow(1.0001, pool.tick - marketTick) - 1) * 100;
      drift = { poolTick: pool.tick, marketTick, pricePct };
      if (pricePct > STALE_SYNC_PCT && !input.explicit) {
        // stale pool → the open will slide it to market (via the in-unlock sync swap)
        // before minting, so place the bins (and anchor the chart) at the MARKET price,
        // not the stale pool's frozen tick. NEVER on a brought pool: it isn't ours to
        // sync, and a pool with real depth won't move for a nominal swap anyway.
        needsSync = true;
        marketSqrt = refSqrt;
        tick = marketTick;
        sqrtPrice = refSqrt;
      }
    }
  }

  // simple mode: one bin spanning the whole range — no shape ladder, no wing dial
  if (input.simple) {
    return planSimple(input, key, quoteIs0, pool, { sqrtPrice, tick, drift, needsSync, marketSqrt, initSqrtPrice });
  }

  const spacing = key.tickSpacing;
  const bidBins = binsForDepth(input.depthBelowPct, spacing, "bid");
  const askBins = binsForDepth(input.depthAbovePct, spacing, "ask");
  if (bidBins + askBins === 0) return emptyPlan(key, quoteIs0, pool, "zero range — set a depth");
  if (bidBins + askBins > 100) return emptyPlan(key, quoteIs0, pool, `${bidBins + askBins} bins > MAX_BINS 100 — narrow the range`);

  // zap mode: wing bought in-unlock through the DEEPEST *price-sane* v4 venue for the
  // pair (own pool, hookless tiers, or any indexer-known pool) — never limited to our
  // own pool, and swapping a thin own-pool would move our own price before minting
  // anyway. The pool's price anchors the band: it just passed the drift check against
  // the market reference (or IS the market reference on a fresh pool), and the wing's
  // minOut derives from the venue's own quote — banding is what keeps that honest.
  let amountBase = input.amountBase;
  let wingQuote = 0n;
  let wingMinOut = 0n;
  let venue: PoolKey = key;
  let routerSwap: OpenPlan["routerSwap"] = null;
  if (input.mode === "zap" && askBins > 0) {
    wingQuote = (input.amountQuote * BigInt(Math.round(input.wingPct * 100))) / 10_000n;
    // when syncing, the in-unlock swapIn is reserved for the pool sync, so fund the wing
    // via the router pre-swap instead of the in-unlock v4 zap (best = null forces that path).
    const best = needsSync ? null : await findSwapVenue(key.currency0, key.currency1, undefined, sqrtPrice);
    if (best) {
      // in-unlock v4 zap through the deepest venue
      venue = best.key;
      const px = price1e18(best.slot0.sqrtPriceX96); // venue price, currency1 per currency0
      const grossOut = quoteIs0 ? (wingQuote * px) / E18 : (wingQuote * E18) / px;
      const afterFee = (grossOut * (1_000_000n - BigInt(best.slot0.lpFee))) / 1_000_000n;
      amountBase = (afterFee * WING_SAFETY_BPS) / 10_000n;
      wingMinOut = amountBase;
    } else {
      // no v4 venue: wing bought via SwapRouter02 (v3 pool or v2 pair) as a batched pre-swap (7702)
      const rp = await findRouterPool(input.token.address, input.quote);
      if (!rp)
        return emptyPlan(key, quoteIs0, pool, "no v4/v3/v2 pool for this token against the quote — can't zap; deposit both tokens");
      const wingHuman = Number(wingQuote) / 10 ** input.quoteDecimals;
      const grossTokens = wingHuman / rp.priceNative;
      const minOutHuman = grossTokens * (1 - rp.fee / 1e6) * (Number(WING_SAFETY_BPS) / 10_000);
      const minOut = BigInt(Math.floor(minOutHuman * 10 ** input.token.decimals));
      if (minOut <= 0n) return emptyPlan(key, quoteIs0, pool, "wing too small for this token's price");
      routerSwap = { kind: rp.kind, pool: rp.address, fee: rp.fee, amountIn: wingQuote, minOut };
      amountBase = minOut; // asks sized to guaranteed swap output; contract pulls it post-swap
      wingMinOut = 0n; // no in-unlock swap
    }
  }

  const { bids, asks, active } = computeShape({
    shape: input.shape,
    spacing,
    activeTick: tick,
    sqrtPriceX96: sqrtPrice,
    quoteIs0,
    bidBins,
    askBins,
    amountQuote: input.amountQuote - wingQuote,
    amountBase,
  });
  // active bin fills the spot gap (mixed); its base is carved out of amountBase and its
  // quote out of the bid budget, so the pay caps below (sized off amountBase) still hold.
  const bins = [...bids, ...active, ...asks];
  if (!bins.length || bins.some((b) => b.liquidity <= 0n))
    return emptyPlan(key, quoteIs0, pool, "amounts too small for this range");

  // pay caps: quote side pays at most the full budget (+1% rounding headroom);
  // base side pays the asks budget in "both" mode, and NOTHING in zap mode.
  const quotePayMax = (input.amountQuote * 101n) / 100n;
  // base pulled from wallet in "both" mode AND in the router-preswap path (swap output
  // lands in the wallet, then open pulls it); only the in-unlock v4 zap keeps it at 0
  const basePayMax = input.mode === "both" || routerSwap !== null ? (amountBase * 101n) / 100n : 0n;
  const [maxPay0, maxPay1] = quoteIs0 ? [quotePayMax, basePayMax] : [basePayMax, quotePayMax];

  return {
    key,
    quoteIs0,
    pool,
    initSqrtPrice,
    bins,
    contractBins: bins.map((b) => ({ tickLower: b.tickLower, tickUpper: b.tickUpper, liquidity: b.liquidity })),
    swapIn: needsSync
      ? // POOL SYNC: slide the stale/empty pool to the market price (the limit) before
        // minting. Empty ⇒ nothing to trade against ⇒ 0 tokens move; amountIn is nominal.
        { enabled: true, venue: key, zeroForOne: marketSqrt < pool.sqrtPriceX96, amountIn: 1n, minAmountOut: 0n, sqrtPriceLimitX96: marketSqrt }
      : { enabled: wingQuote > 0n && routerSwap === null, venue, zeroForOne: quoteIs0, amountIn: routerSwap === null ? wingQuote : 0n, minAmountOut: wingMinOut, sqrtPriceLimitX96: 0n },
    willSync: needsSync,
    routerSwap,
    maxPay0,
    maxPay1,
    needsQuote: quotePayMax,
    needsBase: basePayMax,
    drift,
    anchorTick: tick,
    anchorSqrt: sqrtPrice,
    error: null,
  };
}

const LREF = 1n << 96n; // reference liquidity for ratio probes; scale cancels out

// single source of truth in @friar/core (shared with the SDK); re-exported for the tests
export { simpleRangeTicks };

/**
 * Simple mode: ONE bin spanning [-below%, +above%] around the anchor price — a
 * v3-style single range in Meteora clothing. Zap wing is auto-sized from range
 * geometry: a range implies its own token split, so there's no wing dial to get wrong.
 */
async function planSimple(
  input: OpenPlanInput,
  key: PoolKey,
  quoteIs0: boolean,
  pool: PoolState,
  ctx: {
    sqrtPrice: bigint;
    tick: number;
    drift: OpenPlan["drift"];
    needsSync: boolean;
    marketSqrt: bigint;
    initSqrtPrice: bigint | null;
  },
): Promise<OpenPlan> {
  const spacing = key.tickSpacing;
  const { sqrtPrice, tick } = ctx;
  const below = input.depthBelowPct;
  const above = input.depthAbovePct;
  if (below <= 0 && above <= 0) return emptyPlan(key, quoteIs0, pool, "zero range — set a depth");

  const { tickLower, tickUpper } = simpleRangeTicks(tick, spacing, below, above, quoteIs0);
  const sqrtA = getSqrtPriceAtTick(tickLower);
  const sqrtB = getSqrtPriceAtTick(tickUpper);

  // zap: the range geometry fixes the value split, so the wing sizes itself — the
  // base side's share of a reference-L deposit at this price, in quote terms
  let amountBase = input.amountBase;
  let wingQuote = 0n;
  let wingMinOut = 0n;
  let venue: PoolKey = key;
  let routerSwap: OpenPlan["routerSwap"] = null;
  if (input.mode === "zap") {
    const probe = amountsForLiquidity(sqrtPrice, tickLower, tickUpper, LREF);
    const px = price1e18(sqrtPrice); // currency1 per currency0
    const q = quoteIs0 ? probe.amount0 : probe.amount1;
    const bRaw = quoteIs0 ? probe.amount1 : probe.amount0;
    const bInQuote = px > 0n ? (quoteIs0 ? (bRaw * E18) / px : (bRaw * px) / E18) : 0n;
    const tot = q + bInQuote;
    wingQuote = tot > 0n ? (input.amountQuote * bInQuote) / tot : 0n;
    if (wingQuote > 0n) {
      // same funding ladder as shaped: in-unlock v4 venue, else router pre-swap (7702)
      const best = ctx.needsSync ? null : await findSwapVenue(key.currency0, key.currency1, undefined, sqrtPrice);
      if (best) {
        venue = best.key;
        const vpx = price1e18(best.slot0.sqrtPriceX96);
        const grossOut = quoteIs0 ? (wingQuote * vpx) / E18 : (wingQuote * E18) / vpx;
        const afterFee = (grossOut * (1_000_000n - BigInt(best.slot0.lpFee))) / 1_000_000n;
        amountBase = (afterFee * WING_SAFETY_BPS) / 10_000n;
        wingMinOut = amountBase;
      } else {
        const rp = await findRouterPool(input.token.address, input.quote);
        if (!rp)
          return emptyPlan(key, quoteIs0, pool, "no v4/v3/v2 pool for this token against the quote — can't zap; deposit both tokens");
        const wingHuman = Number(wingQuote) / 10 ** input.quoteDecimals;
        const grossTokens = wingHuman / rp.priceNative;
        const minOutHuman = grossTokens * (1 - rp.fee / 1e6) * (Number(WING_SAFETY_BPS) / 10_000);
        const minOut = BigInt(Math.floor(minOutHuman * 10 ** input.token.decimals));
        if (minOut <= 0n) return emptyPlan(key, quoteIs0, pool, "wing too small for this token's price");
        routerSwap = { kind: rp.kind, pool: rp.address, fee: rp.fee, amountIn: wingQuote, minOut };
        amountBase = minOut; // asks sized to guaranteed swap output; contract pulls it post-swap
        wingMinOut = 0n; // no in-unlock swap
      }
    }
  }

  // L from the final budgets — the binding side sets it, surplus stays in the wallet
  const quoteAmt = input.amountQuote - wingQuote;
  const a0 = quoteIs0 ? quoteAmt : amountBase;
  const a1 = quoteIs0 ? amountBase : quoteAmt;
  let liquidity: bigint;
  if (sqrtPrice <= sqrtA) liquidity = liquidityForAmount0(sqrtA, sqrtB, a0);
  else if (sqrtPrice >= sqrtB) liquidity = liquidityForAmount1(sqrtA, sqrtB, a1);
  else {
    const l0 = liquidityForAmount0(sqrtPrice, sqrtB, a0);
    const l1 = liquidityForAmount1(sqrtA, sqrtPrice, a1);
    liquidity = l0 < l1 ? l0 : l1;
  }
  if (liquidity <= 0n) return emptyPlan(key, quoteIs0, pool, "amounts too small for this range");

  // side tag for the preview: a range above pool-spot holds currency0, below holds
  // currency1; map through quoteIs0 to the user's bid/ask semantics
  const side: PlannedBin["side"] =
    sqrtPrice <= sqrtA ? (quoteIs0 ? "bid" : "ask") : sqrtPrice >= sqrtB ? (quoteIs0 ? "ask" : "bid") : "active";
  const bins: PlannedBin[] = [{ tickLower, tickUpper, weight: 1, amount: quoteAmt, liquidity, side }];

  const quotePayMax = (input.amountQuote * 101n) / 100n;
  const basePayMax = input.mode === "both" || routerSwap !== null ? (amountBase * 101n) / 100n : 0n;
  const [maxPay0, maxPay1] = quoteIs0 ? [quotePayMax, basePayMax] : [basePayMax, quotePayMax];

  return {
    key,
    quoteIs0,
    pool,
    initSqrtPrice: ctx.initSqrtPrice,
    bins,
    contractBins: bins.map((b) => ({ tickLower: b.tickLower, tickUpper: b.tickUpper, liquidity: b.liquidity })),
    swapIn: ctx.needsSync
      ? { enabled: true, venue: key, zeroForOne: ctx.marketSqrt < pool.sqrtPriceX96, amountIn: 1n, minAmountOut: 0n, sqrtPriceLimitX96: ctx.marketSqrt }
      : { enabled: wingQuote > 0n && routerSwap === null, venue, zeroForOne: quoteIs0, amountIn: routerSwap === null ? wingQuote : 0n, minAmountOut: wingMinOut, sqrtPriceLimitX96: 0n },
    willSync: ctx.needsSync,
    routerSwap,
    maxPay0,
    maxPay1,
    needsQuote: quotePayMax,
    needsBase: basePayMax,
    drift: ctx.drift,
    anchorTick: tick,
    anchorSqrt: sqrtPrice,
    error: null,
  };
}

function emptyPlan(key: PoolKey, quoteIs0: boolean, pool: PoolState, error: string): OpenPlan {
  return {
    key,
    quoteIs0,
    pool,
    initSqrtPrice: null,
    bins: [],
    contractBins: [],
    swapIn: { enabled: false, venue: key, zeroForOne: false, amountIn: 0n, minAmountOut: 0n, sqrtPriceLimitX96: 0n },
    willSync: false,
    routerSwap: null,
    maxPay0: 0n,
    maxPay1: 0n,
    needsQuote: 0n,
    needsBase: 0n,
    drift: null,
    anchorTick: 0,
    anchorSqrt: 0n,
    error,
  };
}
