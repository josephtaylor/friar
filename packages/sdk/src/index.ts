export { FriarClient, type FriarClientOptions } from "./client.ts";
export { FriarApi, FriarApiError, DEFAULT_API_URL } from "./api.ts";
export {
  planOpen,
  planSimpleOpen,
  resolvePoolRef,
  poolKeyFor,
  disabledSwapIn,
  toContractBins,
  DEFAULT_SPACING,
  STABLE_RAIL_SPACING,
  defaultSpacingFor,
  MAX_BINS,
} from "./plan.ts";
export {
  buildApprove,
  buildOpen,
  buildIncrease,
  buildDecrease,
  buildClose,
  buildCollect,
  disabledZap,
  proportionalDeltas,
  type ExitOpts,
} from "./tx.ts";
export {
  makePublicClient,
  fetchPoolState,
  fetchPoolLiquidity,
  fetchPoolKeyById,
  fetchDynamicFee,
  fetchPositionRecord,
  fetchPositionIds,
  fetchOnChainStatus,
  fetchAllowance,
  type OnChainStatus,
} from "./reads.ts";
export type {
  TxRequest,
  ContractBin,
  SwapIn,
  Zap,
  PoolState,
  PoolRef,
  PlanOpenInput,
  PlanSimpleOpenInput,
  OpenPlan,
  PositionRecord,
  ApiPool,
  ApiCandle,
  ApiPnlSummary,
  ApiPosition,
  ApiPositionDetail,
  ApiSnapshot,
  ApiTokenBoardEntry,
  ApiTokenSafety,
} from "./types.ts";

// Convenience re-exports so SDK consumers rarely need the inner packages directly.
export {
  ADDRESSES,
  robinhoodChain,
  poolId,
  encodePoolKey,
  DYNAMIC_FEE_FLAG,
  classifyHook,
  hookPermissions,
  isFriarHook,
  V3_VENUES,
  // FriarTier fee tiers: each hook is one immutable base fee, so base fee is pool identity.
  // Pass a tier's `hook` as PoolRef.feeHook to open a new pool at that fee.
  FEE_TIERS,
  deployedFeeTiers,
  feeTierForHook,
  type FeeTier,
  type HookVerdict,
  type HookFlag,
  type PoolKey,
} from "@friar/chain";

// Manager registry. Every position records the manager it was opened against and must
// exit against that address, so this is what you read to exit a position you did not open.
export {
  MANAGERS,
  currentManager,
  managerFor,
  managerForPosition,
  managerAddresses,
  friarPositionManagerAbi,
  type ManagerDeployment,
} from "@friar/chain";

// Direct StateView reads. Nothing here needs our API: give it an RPC and it answers.
export {
  stateViewAbi,
  getSlot0,
  getLiquidity,
  getPositionInfo,
  getFeeGrowthInside,
  binSalt,
  type Slot0,
} from "@friar/chain";

// Token screening and market lookup.
export { checkTokenSafety, type TokenRisk } from "@friar/chain";
export { dsTokenPairs, resolveIncumbent, fetchTokenMarket, railFor, type DsPair } from "@friar/chain";

// The math, unwrapped. This is the reusable core: tick math, per-bin liquidity
// decomposition, shape planning, and position marking. It touches no network and no
// framework, so it works anywhere a bigint does.
//
// One rule it enforces and you should keep: mark against the REAL market price, never
// the pool's own tick. A pool whose range has been breached has a frozen tick that will
// quietly misprice every position you value with it.
export {
  MIN_TICK,
  MAX_TICK,
  getSqrtPriceAtTick,
  getTickAtSqrtPrice,
  sqrtPriceX96FromPrice,
  liquidityForAmount0,
  liquidityForAmount1,
  amountsForLiquidity,
  binsForDepth,
  bucketOf,
  computePosition,
  computeShape,
  simpleRangeTicks,
  valuePosition,
  unclaimedFees,
  markPosition,
  price1e18,
  markPrice1e18,
  MIN_SQRT_PRICE,
  MAX_SQRT_PRICE,
  decompose,
  positionStatus,
  positionBar,
  type Amounts,
  type Side,
  type WeightScheme,
  type Shape,
  type PositionSpec,
  type PlannedBin,
  type ShapeSpec,
  type FeeGrowthInside,
  type FeeGrowthLast,
  type MarkableBin,
  type Mark,
  type Decomposition,
  type BinState,
  type StatusBin,
  type PositionStatus,
} from "@friar/core";
