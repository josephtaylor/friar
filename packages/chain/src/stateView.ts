// Typed StateView reads — replaces poacher's hand-rolled hex eth_calls.
import { keccak256, type Address, type Hex, type PublicClient } from "viem";
import { ADDRESSES } from "./chain.ts";

export const stateViewAbi = [
  {
    type: "function",
    name: "getSlot0",
    stateMutability: "view",
    inputs: [{ name: "poolId", type: "bytes32" }],
    outputs: [
      { name: "sqrtPriceX96", type: "uint160" },
      { name: "tick", type: "int24" },
      { name: "protocolFee", type: "uint24" },
      { name: "lpFee", type: "uint24" },
    ],
  },
  {
    type: "function",
    name: "getLiquidity",
    stateMutability: "view",
    inputs: [{ name: "poolId", type: "bytes32" }],
    outputs: [{ name: "liquidity", type: "uint128" }],
  },
  {
    type: "function",
    name: "getPositionInfo",
    stateMutability: "view",
    inputs: [
      { name: "poolId", type: "bytes32" },
      { name: "owner", type: "address" },
      { name: "tickLower", type: "int24" },
      { name: "tickUpper", type: "int24" },
      { name: "salt", type: "bytes32" },
    ],
    outputs: [
      { name: "liquidity", type: "uint128" },
      { name: "feeGrowthInside0LastX128", type: "uint256" },
      { name: "feeGrowthInside1LastX128", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "getFeeGrowthInside",
    stateMutability: "view",
    inputs: [
      { name: "poolId", type: "bytes32" },
      { name: "tickLower", type: "int24" },
      { name: "tickUpper", type: "int24" },
    ],
    outputs: [
      { name: "feeGrowthInside0X128", type: "uint256" },
      { name: "feeGrowthInside1X128", type: "uint256" },
    ],
  },
] as const;

export interface Slot0 {
  sqrtPriceX96: bigint;
  tick: number;
  protocolFee: number;
  lpFee: number;
}

export async function getLiquidity(client: PublicClient, id: Hex): Promise<bigint> {
  return client.readContract({
    address: ADDRESSES.stateView,
    abi: stateViewAbi,
    functionName: "getLiquidity",
    args: [id],
  });
}

export async function getSlot0(client: PublicClient, id: Hex): Promise<Slot0> {
  const [sqrtPriceX96, tick, protocolFee, lpFee] = await client.readContract({
    address: ADDRESSES.stateView,
    abi: stateViewAbi,
    functionName: "getSlot0",
    args: [id],
  });
  return { sqrtPriceX96, tick, protocolFee, lpFee };
}

export async function getPositionInfo(
  client: PublicClient,
  id: Hex,
  owner: Address,
  tickLower: number,
  tickUpper: number,
  salt: Hex,
): Promise<{ liquidity: bigint; feeGrowthInside0LastX128: bigint; feeGrowthInside1LastX128: bigint }> {
  const [liquidity, feeGrowthInside0LastX128, feeGrowthInside1LastX128] = await client.readContract({
    address: ADDRESSES.stateView,
    abi: stateViewAbi,
    functionName: "getPositionInfo",
    args: [id, owner, tickLower, tickUpper, salt],
  });
  return { liquidity, feeGrowthInside0LastX128, feeGrowthInside1LastX128 };
}

export async function getFeeGrowthInside(
  client: PublicClient,
  id: Hex,
  tickLower: number,
  tickUpper: number,
): Promise<{ feeGrowthInside0X128: bigint; feeGrowthInside1X128: bigint }> {
  const [feeGrowthInside0X128, feeGrowthInside1X128] = await client.readContract({
    address: ADDRESSES.stateView,
    abi: stateViewAbi,
    functionName: "getFeeGrowthInside",
    args: [id, tickLower, tickUpper],
  });
  return { feeGrowthInside0X128, feeGrowthInside1X128 };
}

/** v4 position salt for a manager position's bin — mirrors FriarPositionManager.binSalt. */
export function binSalt(positionId: bigint, index: bigint): Hex {
  // keccak256(abi.encodePacked(uint256, uint256))
  const packed: Hex = `0x${positionId.toString(16).padStart(64, "0")}${index.toString(16).padStart(64, "0")}`;
  return keccak256(packed);
}
