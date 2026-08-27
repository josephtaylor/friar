import { defineChain } from "viem";

export const robinhoodChain = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://rpc.mainnet.chain.robinhood.com"] },
  },
  blockExplorers: {
    default: { name: "Blockscout", url: "https://explorer.mainnet.chain.robinhood.com" },
  },
});

/** Deployed addresses on Robinhood Chain (4663). */
export const ADDRESSES = {
  poolManager: "0x8366a39CC670B4001A1121B8F6A443A643e40951",
  stateView: "0xF3334192D15450CdD385c8B70e03f9A6bD9E673b",
  weth: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
  /** Global Dollar (Paxos) — canonical on 4663; the deep USDG/WETH corridor is the chain's dollar rail. */
  usdg: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
  friarStandard: "0xFeDa24F0d3805170E7566cE617CfBa01cE05D080",
  friarCalm: "0x5E6b0bbc811705b8d8234e9914c0507243fB1080",
  /** FriarV2 (2026-07-31): base fee decoupled from tick spacing, spacing-invariant surge
   * ceiling, and per-pool parameters registered before initialize and frozen at it. One
   * deployment replaces the standard/calm pair, since variableFeeControl is now per-pool
   * config rather than a separate hook. Same two permission bits. */
  friarV2: "0x188Df8E99E8289A606e1396657329cE989975080",
  /** Shared fee-exemption list, read by every registry-aware manager. Deployed once and
   * reused forever: exemptions are configuration and must outlive manager redeploys. */
  feeExemptionRegistry: "0x8F347a4D3820cb1cdf8cef674EA4272B933Fa6f6",
  /** FriarPositionManager accepting NEW opens — redeployed 2026-07-27, block 20714167.
   * Flat 5% perf fee on fees earned, both tiers, with exemptions in the shared
   * FeeExemptionRegistry; ids continue the previous deployment rather than colliding.
   *
   * Existing positions are NOT migrated and must be exited against the manager they were
   * opened on — see `MANAGERS` in ./managers.ts, which is the authority for anything
   * touching an existing position. Use this constant only for new opens. */
  positionManager: "0xBd76176c5524785452D80c4350f18e3A2040470E",
  /** Interim treasury (rotatable on-chain via setTreasury/acceptTreasury). */
  treasury: "0x1fe8E51635636628415f5dee7bc71A3d7A6cF9BE",
  /** Canonical v3 stack for the chain's memecoin liquidity (NOXA pools) — verified
   * 2026-07-17: SwapRouter02.factory() == the factory behind the CASHCAT v3 pool. */
  v3SwapRouter02: "0xCaf681a66D020601342297493863E78C959E5cb2",
  v3Factory: "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA",
  /** Canonical v2 factory — verified 2026-07-20: SwapRouter02.factoryV2() == the
   * factory behind the deep utopia/WETH v2 pair. The router's v2 functions resolve
   * pairs from THIS factory, so routing v2 legs through SwapRouter02 can't be
   * redirected to a spoofed pair. */
  v2Factory: "0x8bcEaA40B9AcdfAedF85AdF4FF01F5Ad6517937f",
  /** Multicall3 at its canonical cross-chain address — verified deployed on 4663
   * (3808 bytes) 2026-07-25. Per-bin StateView reads MUST go through this: the public
   * sequencer RPC answers "Too Many Requests" long before a few hundred loose eth_calls
   * finish, which is what stalled position marking for an hour. */
  multicall3: "0xcA11bde05977b3631167028862bE2a173976CA11",
  /** Universal Router — the chain's canonical v4 swap entrypoint for EOAs, identified
   * 2026-08-03 by tallying the `sender` on PoolManager Swap events (625 of the 2,015
   * swaps in one 22h window) and confirming both `execute` selectors in its bytecode.
   * v4 pools cannot be swapped from an EOA directly: PoolManager only talks to a
   * contract that implements the unlock callback. Without this the bot can only reach
   * v3/v2 venues, which is how a token whose deep venue is v4 became unsellable. */
  universalRouter: "0x8876789976dEcBfCbBbe364623C63652db8C0904",
  /** Permit2 at its canonical cross-chain address (verified deployed on 4663, 9152
   * bytes). The Universal Router pulls ERC20 inputs through this, never by direct
   * transferFrom, so selling a token needs BOTH an ERC20 approve to Permit2 and a
   * Permit2 approve to the router. */
  permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
} as const satisfies Record<string, `0x${string}`>;

/**
 * Every v3-style deployment we can actually ROUTE through, as (factory → its router).
 *
 * A router does not take a pool address, it DERIVES one from its own factory plus the
 * pair. So a pool minted by a different factory is not merely untrusted, it is
 * unreachable through the wrong router — and a fake "pool" contract can be listed on an
 * aggregator by anyone, so the factory check is a safety gate too. Knowing exactly one
 * factory therefore meant silently skipping whole DEXes: MEOWSHI's deepest venue is a
 * $64.8k WETH pool on the second deployment below, and because it was unknown the bot
 * closed into a bag it could not sell.
 *
 * Adding a deployment means proving the router is CALLABLE, not merely present: a
 * contract can contain the exactInputSingle selector and appear in a pool's swap history
 * (via an aggregator or a smart account) while reverting on a direct call. That mistake
 * was made on 2026-08-03 with 0xE51960f1's apparent router 0x7Bcb750D — it answers
 * neither factory() nor WETH9() and reverts empty. Simulate a real sale before trusting
 * one; sweepToken now does exactly that and falls through to v4 when it fails.
 */
export const V3_VENUES = [
  {
    /** canonical NOXA stack, verified 2026-07-17 */
    factory: "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA",
    router: "0xCaf681a66D020601342297493863E78C959E5cb2",
  },
  {
    /** Second v3 deployment, verified 2026-08-03 the right way: found by tallying the
     * indexed `sender` on the POOL's own Swap events (the contract that actually calls
     * swap), not tx.to — tx.to is dominated by 4337 wallets and aggregators and sent the
     * first search to a contract that merely contained the selector. This router's
     * factory() returns the factory below, and exactInputSingle against it reverts "STF"
     * (SafeTransferFrom, i.e. allowance 0) rather than empty — it resolved the pool and
     * reached the token pull, which is what proves the route.
     * Holds MEOWSHI/WETH ($64.8k), the venue whose absence stranded a bag. */
    factory: "0xE51960f1B45f1C9FB6D166E6a884F866fC70433B",
    router: "0xB2d8eD81e79eb64A0751352459eC215FbAFad669",
  },
] as const;
