// Shared SDK types. The write surface is unsigned-builders-only by design: every
// builder returns a TxRequest for the caller's wallet to sign — the SDK never holds
// keys, so it composes with any signer (a bot's viem WalletClient, an agent wallet,
// WalletConnect).
import type { Address, Hex } from "viem";
import type { HookVerdict, ManagerDeployment, PoolKey } from "@friar/chain";
import type { PlannedBin, Shape } from "@friar/core";

/** An unsigned transaction, ready for any wallet. All manager calls are nonpayable. */
export interface TxRequest {
  to: Address;
  data: Hex;
  value: bigint;
  chainId: number;
  /** human/agent-readable description of what signing this does */
  summary: string;
}

/** The manager's Bin struct (what open/openNew take on-chain). */
export interface ContractBin {
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
}

/** The manager's SwapIn struct. `enabled: false` = no-swap path (first-class). */
export interface SwapIn {
  enabled: boolean;
  venue: PoolKey;
  zeroForOne: boolean;
  amountIn: bigint;
  minAmountOut: bigint;
  sqrtPriceLimitX96: bigint;
}

/** The manager's Zap struct for decrease/close/collect. */
export interface Zap {
  enabled: boolean;
  venue: PoolKey;
  zeroForOne: boolean;
}

export interface PoolState {
  live: boolean;
  sqrtPriceX96: bigint;
  tick: number;
  /** current dynamic fee in pips (1/100 bp); this is the live Friar fee gauge */
  lpFee: number;
}

/**
 * Which pool a plan targets — exactly one of:
 * - `pool`: bring-your-own-pool, ANY v4 PoolKey (hooked incumbents included; hooks
 *   that run on liquidity removal are refused — they can trap or tax exits).
 * - `token`: the standard Friar pool for token/quote (created via openNew if missing).
 * `quote` orients the position (which side "%below/%above" and budgets refer to). For a
 * brought pool it must be one of the pool's sides; omitted, it defaults to USDG, then
 * WETH, then currency1.
 */
export interface PoolRef {
  /** bring-your-own-pool: the exact v4 pool to LP */
  pool?: PoolKey;
  /** the token being LP'd (ignored when `pool` is set) */
  token?: Address;
  /** quote side; see PoolRef docs for defaulting */
  quote?: Address;
  /** tick spacing for token-derived Friar pools; default 100. Brought pools use their own. */
  spacing?: number;
  /**
   * The FriarTier fee-tier hook to open a NEW pool under (base fee lives in the hook, so
   * which hook = which fee). Pick from `FEE_TIERS`. Omit to use the legacy standard hook.
   * A given `(token, quote, spacing, feeHook)` names one pool; joining a live pool via `pool`
   * ignores this (that pool already has a hook). Ignored when `pool` is set.
   */
  feeHook?: Address;
}

export interface PlanOpenInput extends PoolRef {
  shape: Shape;
  /** price depth covered below spot, in % (bids, quote token) */
  depthBelowPct: number;
  /** price depth covered above spot, in % (asks, base token) */
  depthAbovePct: number;
  /** budget for the bid side, in quote token wei */
  amountQuote: bigint;
  /** budget for the ask side, in base token wei */
  amountBase: bigint;
  /** for "exp"-style steepness tuning; passed through to the shape math */
  growth?: number;
  /** init price for a pool that doesn't exist yet (openNew). Ignored for live pools. */
  initSqrtPriceX96?: bigint;
  /** Plan around THIS price instead of a live pool's own. For stale/pinned EMPTY pools
   * (every position closed, price frozen at wherever flow left it — often a range edge):
   * anchor at the true market price and pair the open with a sync swapIn (venue = the
   * pool itself, amountIn 1 wei, sqrtPriceLimitX96 = this) so the pool slides to market
   * inside the same unlock before the mint. Ignored when the pool isn't live. */
  anchorSqrtPriceX96?: bigint;
}

/** A "simple" position: ONE bin spanning [-below%, +above%] — a v3-style single range.
 * Pays the manager's simple fee tier (1% of fees vs 10% for shaped). */
export interface PlanSimpleOpenInput extends PoolRef {
  depthBelowPct: number;
  depthAbovePct: number;
  /** budget for the quote side, wei */
  amountQuote: bigint;
  /** budget for the token side, wei */
  amountBase: bigint;
  /** init price for a pool that doesn't exist yet (openNew). Ignored for live pools. */
  initSqrtPriceX96?: bigint;
  /** see PlanOpenInput.anchorSqrtPriceX96 — the stale-empty-pool re-entry case */
  anchorSqrtPriceX96?: bigint;
}

export interface OpenPlan {
  key: PoolKey;
  quoteIs0: boolean;
  /** false → this plan targets openNew (pool created + seeded atomically) */
  poolLive: boolean;
  /** set when poolLive is false; the sqrtPriceX96 openNew initializes at */
  initSqrtPriceX96: bigint | null;
  state: PoolState;
  /** planned bins with weights/amounts, in user semantics (bid/ask/active) */
  bins: PlannedBin[];
  /** the exact structs open/openNew take */
  contractBins: ContractBin[];
  /** exact deposit the manager will pull, per pool currency */
  needs0: bigint;
  needs1: bigint;
  /** pay caps passed on-chain (needs + 1% buffer) */
  maxPay0: bigint;
  maxPay1: bigint;
  /** no-swap v1 planning: always disabled; supply your own SwapIn to buildOpen to zap */
  swapIn: SwapIn;
  /** hook classification for brought pools (null for Friar-derived pools) */
  hookVerdict: HookVerdict | null;
  summary: string;
}

// ---- REST API response shapes (mirrors apps/api/src/worker.ts) ----

export interface ApiPool {
  pool_id: string;
  currency0: string;
  currency1: string;
  fee: number;
  tick_spacing: number;
  hooks: string;
  ref_pool: string | null;
  watched: number;
  lastPrice: string | null;
  vol24h0: string;
  vol24h1: string;
  swaps24h: number;
  openPositions: number;
}

export interface ApiCandle {
  ts: number;
  open: string;
  high: string;
  low: string;
  close: string;
  vol0: string;
  vol1: string;
  swaps: number;
}

export interface ApiPnlSummary {
  valueQuote: string;
  cashflowQuote: string;
  pnlQuote: string;
  feesNetQuote: string;
  inventoryQuote: string;
  perfFeeQuote: string;
  investedQuote?: string;
  unclaimedFees0: string;
  unclaimedFees1: string;
  priceUsed: string;
  markedAt: number | null;
}

export interface ApiPosition {
  position_id: number;
  owner: string;
  pool_id: string;
  opened_ts: number;
  closed_ts: number | null;
  open_delta0: string;
  open_delta1: string;
  flow0: string;
  flow1: string;
  fees0: string;
  fees1: string;
  perf0: string;
  perf1: string;
  currency0: string;
  currency1: string;
  summary: ApiPnlSummary;
}

export interface ApiPositionDetail extends ApiPosition {
  fee: number;
  tick_spacing: number;
  hooks: string;
  bins: Array<{ bin_index: number; tick_lower: number; tick_upper: number; liquidity: string }>;
  events: Array<{ block: number; ts: number; name: string; data: string; tx_hash: string }>;
  latestSnapshot: ApiSnapshot | null;
}

export interface ApiSnapshot {
  ts: number;
  sqrt_price: string;
  market_sqrt_price: string | null;
  amount0: string;
  amount1: string;
  fees0: string;
  fees1: string;
}

export interface ApiTokenBoardEntry {
  address: string;
  symbol: string;
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
  friarPoolId: string | null;
  friarBaseFee: number;
  undercutsIncumbent: boolean | null;
}

export interface ApiTokenSafety {
  address: string;
  level: string;
  flags: string[];
  sources: string[];
  stale?: boolean;
}

/** The on-chain position record — sufficient to exit with no backend. */
export interface PositionRecord {
  /** Which manager deployment holds this position. Exits MUST target this contract with
   * its own ABI generation — not whichever manager is currently accepting opens. */
  manager: ManagerDeployment;
  owner: Address;
  key: PoolKey;
  bins: ContractBin[];
}
