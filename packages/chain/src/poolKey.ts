import { encodeAbiParameters, keccak256, type Address, type Hex } from "viem";

/** Uniswap v4 PoolKey. Currencies sorted ascending; fee 0x800000 = dynamic. */
export interface PoolKey {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
}

export const DYNAMIC_FEE_FLAG = 0x800000;

const POOL_KEY_ABI = [
  {
    type: "tuple",
    components: [
      { name: "currency0", type: "address" },
      { name: "currency1", type: "address" },
      { name: "fee", type: "uint24" },
      { name: "tickSpacing", type: "int24" },
      { name: "hooks", type: "address" },
    ],
  },
] as const;

/** abi.encode(PoolKey) — five words. */
export function encodePoolKey(key: PoolKey): Hex {
  return encodeAbiParameters(POOL_KEY_ABI, [
    {
      currency0: key.currency0,
      currency1: key.currency1,
      fee: key.fee,
      tickSpacing: key.tickSpacing,
      hooks: key.hooks,
    },
  ]);
}

/** PoolId = keccak256(abi.encode(PoolKey)). Pure JS — no cast shell-out. */
export function poolId(key: PoolKey): Hex {
  return keccak256(encodePoolKey(key));
}
