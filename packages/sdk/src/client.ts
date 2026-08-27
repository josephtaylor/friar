// FriarClient: the one-stop facade. Reads via the REST API (fast) and the chain
// (trustless), planning via @friar/core, writes as unsigned TxRequests.
import { classifyHook, type HookVerdict, type PoolKey } from "@friar/chain";
import { valuePosition } from "@friar/core";
import type { Address, Hex, PublicClient } from "viem";
import { DEFAULT_API_URL, FriarApi } from "./api.ts";
import { planOpen, planSimpleOpen, poolKeyFor, resolvePoolRef } from "./plan.ts";
import {
  fetchAllowance,
  fetchDynamicFee,
  fetchOnChainStatus,
  fetchPoolKeyById,
  fetchPoolState,
  fetchPositionIds,
  fetchPositionRecord,
  makePublicClient,
  type OnChainStatus,
} from "./reads.ts";
import {
  buildApprove,
  buildClose,
  buildCollect,
  buildDecrease,
  type ExitOpts,
  buildIncrease,
  buildOpen,
  proportionalDeltas,
} from "./tx.ts";
import type { OpenPlan, PlanOpenInput, PlanSimpleOpenInput, PoolState, PositionRecord, TxRequest, Zap } from "./types.ts";

export interface FriarClientOptions {
  /** REST API base; default https://api.friar.fi */
  apiUrl?: string;
  /** chain RPC; default the canonical Robinhood Chain RPC */
  rpcUrl?: string;
}

export class FriarClient {
  readonly api: FriarApi;
  readonly chain: PublicClient;

  constructor(opts: FriarClientOptions = {}) {
    this.api = new FriarApi(opts.apiUrl ?? DEFAULT_API_URL);
    this.chain = makePublicClient(opts.rpcUrl);
  }

  // ---- reads ----

  /** Live pool state (price, tick) + the hook's live dynamic fee for a token/quote pair. */
  async poolState(
    token: Address,
    quote?: Address,
    spacing?: number,
  ): Promise<{ key: PoolKey; quoteIs0: boolean; state: PoolState; dynamicFeePips: number | null }> {
    const { key, quoteIs0 } = poolKeyFor(token, quote, spacing);
    const [state, dynamicFeePips] = await Promise.all([
      fetchPoolState(this.chain, key),
      fetchDynamicFee(this.chain, key),
    ]);
    return { key, quoteIs0, state, dynamicFeePips };
  }

  positionRecord(positionId: bigint): Promise<PositionRecord> {
    return fetchPositionRecord(this.chain, positionId);
  }

  positionIds(owner: Address): Promise<bigint[]> {
    return fetchPositionIds(this.chain, owner);
  }

  /** Backend-independent position status: record + pool state + mark, RPC only. */
  onChainStatus(positionId: bigint): Promise<OnChainStatus> {
    return fetchOnChainStatus(this.chain, positionId);
  }

  /**
   * Bring-your-own-pool: resolve a v4 PoolId (e.g. a Dexscreener v4 "pair address")
   * to its PoolKey + hook verdict + live state. Returns null for unknown ids.
   */
  async poolById(id: Hex): Promise<{ key: PoolKey; verdict: HookVerdict; state: PoolState } | null> {
    const key = await fetchPoolKeyById(this.chain, id);
    if (!key) return null;
    const state = await fetchPoolState(this.chain, key);
    return { key, verdict: classifyHook(key.hooks as Address), state };
  }

  // ---- planning ----

  /** Plan a shaped open: fetches pool state, compiles the shape into contract bins.
   * Targets the standard Friar pool (`token`) or any brought v4 pool (`pool`). */
  async planOpen(input: PlanOpenInput): Promise<OpenPlan> {
    const { key } = resolvePoolRef(input);
    const state = await fetchPoolState(this.chain, key);
    return planOpen(input, state);
  }

  /** Plan a simple (single-range) open — one bin spanning the whole range. */
  async planSimpleOpen(input: PlanSimpleOpenInput): Promise<OpenPlan> {
    const { key } = resolvePoolRef(input);
    const state = await fetchPoolState(this.chain, key);
    return planSimpleOpen(input, state);
  }

  // ---- unsigned transactions ----

  /**
   * Approvals (if short) + the open/openNew call, in signing order.
   * `owner` is the address that will sign — used only to check current allowances.
   */
  async openTxs(plan: OpenPlan, owner: Address): Promise<TxRequest[]> {
    const txs: TxRequest[] = [];
    for (const [currency, needed] of [
      [plan.key.currency0, plan.maxPay0],
      [plan.key.currency1, plan.maxPay1],
    ] as Array<[Address, bigint]>) {
      if (needed === 0n) continue;
      const allowance = await fetchAllowance(this.chain, currency, owner);
      if (allowance < needed) txs.push(buildApprove(currency, needed));
    }
    txs.push(buildOpen(plan));
    return txs;
  }

  /** Add `addBps/10000` of each bin's current liquidity (e.g. 5000 = grow by 50%). */
  async increaseTxs(positionId: bigint, addBps: bigint, owner: Address): Promise<TxRequest[]> {
    const record = await fetchPositionRecord(this.chain, positionId);
    const state = await fetchPoolState(this.chain, record.key);
    const deltas = proportionalDeltas(record.bins, addBps);
    const deltaBins = record.bins.map((b, i) => ({ ...b, liquidity: deltas[i]! }));
    const needs = valuePosition(deltaBins, state.sqrtPriceX96);
    const maxPay0 = (needs.amount0 * 101n) / 100n;
    const maxPay1 = (needs.amount1 * 101n) / 100n;

    const txs: TxRequest[] = [];
    for (const [currency, needed] of [
      [record.key.currency0, maxPay0],
      [record.key.currency1, maxPay1],
    ] as Array<[Address, bigint]>) {
      if (needed === 0n) continue;
      const allowance = await fetchAllowance(this.chain, currency, owner, record.manager.address);
      if (allowance < needed) txs.push(buildApprove(currency, needed, record.manager.address));
    }
    txs.push(buildIncrease(positionId, deltas, { maxPay0, maxPay1, venue: record.key, manager: record.manager }));
    return txs;
  }

  /** Withdraw `bps/10000` of every bin (10000 = full → prefer closeTx). */
  async decreaseTx(
    positionId: bigint,
    bps: bigint,
    opts?: Omit<ExitOpts, "venue">,
  ): Promise<TxRequest> {
    const record = await fetchPositionRecord(this.chain, positionId);
    const deltas = proportionalDeltas(record.bins, bps);
    return buildDecrease(positionId, deltas, { venue: record.key, ...opts, manager: opts?.manager ?? record.manager });
  }

  /** Full close: burn all bins, auto-collect fees, delete the record. */
  async closeTx(
    positionId: bigint,
    opts?: Omit<ExitOpts, "venue">,
  ): Promise<TxRequest> {
    const record = await fetchPositionRecord(this.chain, positionId);
    return buildClose(positionId, { venue: record.key, ...opts, manager: opts?.manager ?? record.manager });
  }

  /** Claim fees (the fee tier — 10% shaped / 1% simple — is taken in-kind here; principal never charged). */
  async collectTx(
    positionId: bigint,
    opts?: Omit<ExitOpts, "venue">,
  ): Promise<TxRequest> {
    const record = await fetchPositionRecord(this.chain, positionId);
    return buildCollect(positionId, { venue: record.key, ...opts, manager: opts?.manager ?? record.manager });
  }
}
