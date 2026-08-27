// Chain-direct reads: everything needed to know and exit a position with only an RPC —
// no Friar backend. This is the governing principle made code: the on-chain record is
// sufficient to get your money out.
import {
  ADDRESSES,
  binSalt,
  friarPositionManagerAbi,
  getFeeGrowthInside,
  getLiquidity,
  getPositionInfo,
  getSlot0,
  MANAGERS,
  poolId,
  robinhoodChain,
  type ManagerDeployment,
  type PoolKey,
} from "@friar/chain";
import { markPosition, unclaimedFees, type Mark } from "@friar/core";
import { createPublicClient, erc20Abi, http, parseAbiItem, type Address, type Hex, type PublicClient } from "viem";
import type { PoolState, PositionRecord } from "./types.ts";

const MANAGER = ADDRESSES.positionManager as Address; // current deployment: new opens + approvals

export function makePublicClient(rpcUrl?: string): PublicClient {
  return createPublicClient({ chain: robinhoodChain, transport: http(rpcUrl) });
}

export async function fetchPoolState(client: PublicClient, key: PoolKey): Promise<PoolState> {
  const slot0 = await getSlot0(client, poolId(key));
  if (slot0.sqrtPriceX96 > 0n) {
    return { live: true, sqrtPriceX96: slot0.sqrtPriceX96, tick: slot0.tick, lpFee: slot0.lpFee };
  }
  return { live: false, sqrtPriceX96: 0n, tick: 0, lpFee: 0 };
}

export async function fetchPoolLiquidity(client: PublicClient, key: PoolKey): Promise<bigint> {
  return getLiquidity(client, poolId(key));
}

const initializeEvent = parseAbiItem(
  "event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)",
);

/**
 * PoolId → PoolKey. Ids are keccak hashes of the key, so they can't be reversed — but
 * the PoolManager's Initialize event indexes the id, so one topic-filtered log query
 * recovers the full key. This is how a Dexscreener v4 "pair address" (= the PoolId)
 * becomes something you can LP. Returns null for unknown ids.
 */
export async function fetchPoolKeyById(client: PublicClient, id: Hex): Promise<PoolKey | null> {
  const logs = await client.getLogs({
    address: ADDRESSES.poolManager as Address,
    event: initializeEvent,
    args: { id },
    fromBlock: 0n,
  });
  const l = logs[0];
  if (!l) return null;
  return {
    currency0: l.args.currency0 as Address,
    currency1: l.args.currency1 as Address,
    fee: Number(l.args.fee),
    tickSpacing: Number(l.args.tickSpacing),
    hooks: l.args.hooks as Address,
  };
}

const previewFeeAbi = [
  {
    type: "function",
    name: "previewFee",
    stateMutability: "view",
    inputs: [
      {
        name: "key",
        type: "tuple",
        components: [
          { name: "currency0", type: "address" },
          { name: "currency1", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "tickSpacing", type: "int24" },
          { name: "hooks", type: "address" },
        ],
      },
    ],
    outputs: [{ name: "", type: "uint24" }],
  },
] as const;

/**
 * The LIVE dynamic fee in pips, from the Friar hook's previewFee (slot0's lpFee is the
 * stored placeholder on dynamic-fee pools — the hook overrides it per swap). Null for
 * unhooked pools or hooks without previewFee.
 */
export async function fetchDynamicFee(client: PublicClient, key: PoolKey): Promise<number | null> {
  if (key.hooks.toLowerCase() === "0x0000000000000000000000000000000000000000") return null;
  try {
    const fee = await client.readContract({
      address: key.hooks as Address,
      abi: previewFeeAbi,
      functionName: "previewFee",
      args: [key],
    });
    return Number(fee);
  } catch {
    return null;
  }
}

/**
 * The on-chain position record, resolved against whichever manager deployment actually
 * holds the id.
 *
 * Managers are immutable, so shipping a new one leaves existing positions on the old
 * contract — a read pinned to the current address would revert `UnknownPosition` for
 * every pre-upgrade position. `getPosition` has the same shape on every generation, so
 * this probes deployments newest-first and returns the one that answers.
 *
 * Reverts (UnknownPosition) only when NO manager knows the id (closed or nonexistent).
 */
export async function fetchPositionRecord(client: PublicClient, positionId: bigint): Promise<PositionRecord> {
  const ordered = [...MANAGERS].reverse(); // newest first: most positions live there
  let lastError: unknown;
  for (const deployment of ordered) {
    try {
      return await readPositionFrom(client, positionId, deployment);
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError ?? new Error(`no manager holds position ${positionId}`);
}

async function readPositionFrom(
  client: PublicClient,
  positionId: bigint,
  deployment: ManagerDeployment,
): Promise<PositionRecord> {
  const [owner, key, bins] = await client.readContract({
    address: deployment.address,
    abi: friarPositionManagerAbi,
    functionName: "getPosition",
    args: [positionId],
  });
  return {
    manager: deployment,
    owner,
    key: {
      currency0: key.currency0,
      currency1: key.currency1,
      fee: key.fee,
      tickSpacing: key.tickSpacing,
      hooks: key.hooks,
    },
    bins: bins.map((b) => ({ tickLower: b.tickLower, tickUpper: b.tickUpper, liquidity: b.liquidity })),
  };
}

/**
 * Every open position id for an owner, across ALL manager deployments — an upgrade must
 * not make older positions disappear from an integrator's list. Ids are a single global
 * namespace (each deployment starts above the previous high-water mark), so the union
 * needs no disambiguation; sorted ascending for stable output.
 */
export async function fetchPositionIds(client: PublicClient, owner: Address): Promise<bigint[]> {
  const perManager = await Promise.all(
    MANAGERS.map(async (m) => {
      try {
        const ids = await client.readContract({
          address: m.address,
          abi: friarPositionManagerAbi,
          functionName: "positionsOf",
          args: [owner],
        });
        return [...ids];
      } catch {
        return [] as bigint[]; // a retired manager that is unreachable must not sink the list
      }
    }),
  );
  return perManager.flat().sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export interface OnChainStatus {
  record: PositionRecord;
  state: PoolState;
  /** principal + unclaimed fees, marked at the POOL price (see caveat below) */
  mark: Mark;
}

/**
 * Mark a position straight from the chain: record + slot0 + per-bin fee growth.
 * Caveat (the CASHCAT lesson): this marks at the POOL price, and a breached pool's
 * tick freezes and lies. For PnL truth use the API's true-market marks; this read is
 * for exit math and backend-down operation.
 */
export async function fetchOnChainStatus(client: PublicClient, positionId: bigint): Promise<OnChainStatus> {
  const record = await fetchPositionRecord(client, positionId);
  const id = poolId(record.key);
  const state = await fetchPoolState(client, record.key);

  const bins = await Promise.all(
    record.bins.map(async (b, i) => {
      const salt = binSalt(positionId, BigInt(i));
      const [info, insideNow] = await Promise.all([
        getPositionInfo(client, id, record.manager.address, b.tickLower, b.tickUpper, salt),
        getFeeGrowthInside(client, id, b.tickLower, b.tickUpper),
      ]);
      const fees = unclaimedFees(info.liquidity, insideNow, info);
      return { tickLower: b.tickLower, tickUpper: b.tickUpper, liquidity: info.liquidity, ...fees };
    }),
  );

  return { record, state, mark: markPosition(bins, state.sqrtPriceX96) };
}

export async function fetchAllowance(
  client: PublicClient,
  token: Address,
  owner: Address,
  spender: Address = MANAGER,
): Promise<bigint> {
  return client.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [owner, spender] });
}
