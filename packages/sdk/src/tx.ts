// Unsigned transaction builders for FriarPositionManager. Pure encoding — no network,
// no keys. Every function returns a TxRequest the caller's wallet signs.
import {
  ADDRESSES,
  friarPositionManagerAbi,
  friarPositionManagerV1ExitsAbi,
  currentManager,
  robinhoodChain,
  type ManagerDeployment,
  type PoolKey,
} from "@friar/chain";
import { encodeFunctionData, erc20Abi, type Address } from "viem";
import { disabledSwapIn } from "./plan.ts";
import type { ContractBin, OpenPlan, SwapIn, TxRequest, Zap } from "./types.ts";

const MANAGER = ADDRESSES.positionManager as Address;
const CHAIN_ID = robinhoodChain.id;

function tx(data: `0x${string}`, summary: string, to: Address = MANAGER): TxRequest {
  return { to, data, value: 0n, chainId: CHAIN_ID, summary };
}

export function disabledZap(venue: PoolKey): Zap {
  return { enabled: false, venue, zeroForOne: false };
}

/** ERC-20 approve for the manager (or an explicit spender). */
export function buildApprove(token: Address, amount: bigint, spender: Address = MANAGER): TxRequest {
  const data = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, amount] });
  return tx(data, `approve ${spender === MANAGER ? "FriarPositionManager" : spender} to spend ${amount} of ${token}`, token);
}

/** open/openNew from a plan. Pass a SwapIn to zap; defaults to the plan's no-swap path. */
export function buildOpen(plan: OpenPlan, swapIn?: SwapIn): TxRequest {
  const s = swapIn ?? plan.swapIn;
  const data = plan.poolLive
    ? encodeFunctionData({
        abi: friarPositionManagerAbi,
        functionName: "open",
        args: [plan.key, plan.contractBins, s, plan.maxPay0, plan.maxPay1],
      })
    : encodeFunctionData({
        abi: friarPositionManagerAbi,
        functionName: "openNew",
        args: [plan.key, plan.initSqrtPriceX96!, plan.contractBins, s, plan.maxPay0, plan.maxPay1],
      });
  return tx(data, plan.summary);
}

/** Add liquidity to existing bins. `liquidityDeltas[i]` pairs with the record's bin i. */
export function buildIncrease(
  positionId: bigint,
  liquidityDeltas: bigint[],
  opts: { maxPay0: bigint; maxPay1: bigint; swapIn?: SwapIn; venue: PoolKey; manager?: ManagerDeployment },
): TxRequest {
  const s = opts.swapIn ?? disabledSwapIn(opts.venue);
  // `increase` has the same shape on every generation, but the ADDRESS still matters:
  // an existing position lives on the manager it was opened on.
  const m = opts.manager ?? currentManager();
  const data = encodeFunctionData({
    abi: friarPositionManagerAbi,
    functionName: "increase",
    args: [positionId, liquidityDeltas, s, opts.maxPay0, opts.maxPay1],
  });
  return tx(data, `increase position #${positionId} across ${liquidityDeltas.filter((d) => d > 0n).length} bins`, m.address);
}

/**
 * Bounds for an exit verb (decrease / close / collect).
 *
 * `minReceive0/1` floor the payout — set them whenever `zap.enabled`, or the swap executes
 * to the extreme price boundary and is sandwichable.
 *
 * `maxPay0/1` cap what the exit may CHARGE, and default to 0 because a normal exit only
 * ever pays out. They are the guard against a zap venue whose hook returns an unbounded
 * swap delta: the manager settles a negative delta by transferring from the owner, so
 * without a cap an exit can reach into the owner's wallet up to its ERC-20 allowance.
 * Raise them only to deliberately escape a pool that legitimately charges on exit.
 */
export interface ExitOpts {
  venue: PoolKey;
  /**
   * The deployment holding this position — take it from `fetchPositionRecord().manager`.
   * Managers are immutable, so an exit must target the contract the position was OPENED
   * on, never whichever one currently accepts opens. Defaults to the current deployment,
   * which is correct only for positions opened on it.
   */
  manager?: ManagerDeployment;
  zap?: Zap;
  minReceive0?: bigint;
  minReceive1?: bigint;
  maxPay0?: bigint;
  maxPay1?: bigint;
}

/** Partial withdraw. `liquidityDeltas[i]` pairs with the record's bin i. */
export function buildDecrease(
  positionId: bigint,
  liquidityDeltas: bigint[],
  opts: ExitOpts,
): TxRequest {
  const z = opts.zap ?? disabledZap(opts.venue);
  const m = opts.manager ?? currentManager();
  const data =
    m.exitAbi === "v1"
      ? encodeFunctionData({
          abi: friarPositionManagerV1ExitsAbi,
          functionName: "decrease",
          args: [positionId, liquidityDeltas, z, opts.minReceive0 ?? 0n, opts.minReceive1 ?? 0n],
        })
      : encodeFunctionData({
          abi: friarPositionManagerAbi,
          functionName: "decrease",
          args: [positionId, liquidityDeltas, z, opts.minReceive0 ?? 0n, opts.minReceive1 ?? 0n, opts.maxPay0 ?? 0n, opts.maxPay1 ?? 0n],
        });
  return tx(data, `decrease position #${positionId}${z.enabled ? " with zap-out" : ""}`, m.address);
}

/** Full close: burns all bins, auto-collects fees, deletes the record. */
export function buildClose(
  positionId: bigint,
  opts: ExitOpts,
): TxRequest {
  const z = opts.zap ?? disabledZap(opts.venue);
  const m = opts.manager ?? currentManager();
  const data =
    m.exitAbi === "v1"
      ? encodeFunctionData({
          abi: friarPositionManagerV1ExitsAbi,
          functionName: "close",
          args: [positionId, z, opts.minReceive0 ?? 0n, opts.minReceive1 ?? 0n],
        })
      : encodeFunctionData({
          abi: friarPositionManagerAbi,
          functionName: "close",
          args: [positionId, z, opts.minReceive0 ?? 0n, opts.minReceive1 ?? 0n, opts.maxPay0 ?? 0n, opts.maxPay1 ?? 0n],
        });
  return tx(data, `close position #${positionId}${z.enabled ? " with zap-out" : ""} (fees auto-collected)`, m.address);
}

/** Claim fees without touching liquidity. The manager's perf fee is taken here, in-kind. */
export function buildCollect(
  positionId: bigint,
  opts: ExitOpts,
): TxRequest {
  const z = opts.zap ?? disabledZap(opts.venue);
  const m = opts.manager ?? currentManager();
  const data =
    m.exitAbi === "v1"
      ? encodeFunctionData({
          abi: friarPositionManagerV1ExitsAbi,
          functionName: "collect",
          args: [positionId, z, opts.minReceive0 ?? 0n, opts.minReceive1 ?? 0n],
        })
      : encodeFunctionData({
          abi: friarPositionManagerAbi,
          functionName: "collect",
          args: [positionId, z, opts.minReceive0 ?? 0n, opts.minReceive1 ?? 0n, opts.maxPay0 ?? 0n, opts.maxPay1 ?? 0n],
        });
  return tx(data, `collect fees on position #${positionId}${z.enabled ? " with zap-out" : ""}`, m.address);
}

/** Proportional per-bin deltas for a percent withdraw (10000 bps = full). */
export function proportionalDeltas(bins: ReadonlyArray<ContractBin>, bps: bigint): bigint[] {
  if (bps <= 0n || bps > 10_000n) throw new Error("bps must be in (0, 10000]");
  return bins.map((b) => (b.liquidity * bps) / 10_000n);
}
