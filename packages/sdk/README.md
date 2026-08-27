
# @josephtaylor/friar-sdk

TypeScript SDK for building on **Friar** — a **DLMM** (Dynamic Liquidity Market Maker)
and LP position manager on **Robinhood Chain** (chain id **4663**).

Friar positions are **bins**: discrete concentrated-liquidity ranges opened, managed,
and closed as one unit, in one transaction, in a chosen **shape** —
`spot` (uniform), `curve` (bell around price), or `bidask` (weighted to the edges).
Pool fees are dynamic — a low base that surges with realized volatility — and the SDK
reads the live fee straight from the hook.

The SDK is three layers:

1. **Reads** — pool board, candles, positions, PnL via the public REST API
   (`api.friar.fi`), plus trustless chain-direct reads that need nothing but an RPC.
2. **Planning** — pure math (from `@friar/core`) that compiles a shape (depth %,
   budgets) into exact per-bin liquidity and the structs the contract takes.
3. **Unsigned transaction builders** — every write returns
   `{ to, data, value, chainId, summary }` for **your** wallet to sign (`summary` is
   a plain-English description of what signing does). The SDK never holds keys, by
   design: it composes with a bot's viem `WalletClient`, WalletConnect — any signer.

## Quickstart

```ts
import { FriarClient, robinhoodChain } from "@josephtaylor/friar-sdk";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const friar = new FriarClient(); // defaults: api.friar.fi + the canonical RPC
const account = privateKeyToAccount(process.env.PK as `0x${string}`);
const wallet = createWalletClient({ account, chain: robinhoodChain, transport: http() });

// 1. Orient: discovery board + live pool state (incl. the live dynamic fee)
const board = await friar.api.tokens();
const token = board[0].address as `0x${string}`;
const { state, dynamicFeePips } = await friar.poolState(token);
console.log(`current fee: ${(dynamicFeePips ?? 0) / 10_000}%`);

// 2. Screen: safety verdicts served by the Friar API
const safety = await friar.api.tokenSafety(token);
if (safety.level === "block") throw new Error(`unsafe token: ${safety.flags.join(", ")}`);

// 3. Plan: compile a shape into exact per-bin liquidity
const plan = await friar.planOpen({
  token,
  shape: "curve",
  depthBelowPct: 15,        // bids covering 15% below spot (quote token)
  depthAbovePct: 15,        // asks covering 15% above spot (base token)
  amountQuote: 10n ** 17n,  // 0.1 WETH on the bid side
  amountBase: 0n,           // base-side budget (0 + depthAbovePct: 0 = pure bid ladder, no swap needed)
});
console.log(plan.summary, plan.needs0, plan.needs1);

// 4. Sign: approvals (only if allowance is short) + the open, in signing order
const txs = await friar.openTxs(plan, account.address);
for (const tx of txs) {
  const hash = await wallet.sendTransaction({ to: tx.to, data: tx.data, value: tx.value });
  await friar.chain.waitForTransactionReceipt({ hash });
}

// 5. Manage (each returns an unsigned tx the same way)
const [positionId] = await friar.positionIds(account.address);
await friar.collectTx(positionId);                           // claim fees
await friar.increaseTxs(positionId, 5000n, account.address); // grow every bin by 50%
await friar.decreaseTx(positionId, 2500n);                   // withdraw 25%
await friar.closeTx(positionId);                             // full exit — burns auto-collect fees
```

If the pool doesn't exist yet, `planOpen` returns `poolLive: false` and `openTxs`
targets `openNew` — the pool is created and seeded in the same transaction. Your
first LP is the pool creator.

## Reads

`FriarClient` wraps both paths — `friar.api` (fast, indexed) and chain-direct
(trustless, RPC-only):

| Method | Returns |
|---|---|
| `friar.poolState(token, quote?, spacing?)` | pool key, live price/tick, and the hook's **live dynamic fee** (pips; ÷ 10 000 = %) |
| `friar.positionIds(owner)` / `friar.positionRecord(id)` | on-chain enumeration + the full bin record |
| `friar.onChainStatus(id)` | record + pool state + mark, from the RPC alone |
| `friar.api.pools()` / `friar.api.tokens()` | indexed pool list / hot-token discovery board |
| `friar.api.candles(id, { interval, from, to })` | OHLCV (`id` = v4 poolId **or** an incumbent v3 pool address) |
| `friar.api.positions(owner)` / `friar.api.position(id, owner)` | positions with PnL summaries / full detail (bins, events, snapshots) |
| `friar.api.positionSnapshots(id, owner)` / `friar.api.portfolioHistory(owner)` | 5-minute mark history / portfolio value series |
| `friar.api.tokenSafety(address)` | malicious-token verdict (see below) |

PnL summaries decompose the way LPs actually think: **fees earned vs inventory change
vs net**, quote-denominated, marked at the true market price — never a breached pool's
frozen tick.

## Token safety

`friar.api.tokenSafety(address)` returns `{ level, flags, sources }` from Friar's
hosted screening service (aggregated third-party checkers, cached 6h). The screening
implementation is server-side (`safety.ts` is excluded from the public mirror) — the
public SDK just reads verdicts. Semantics to respect:

- **Never LP a token with `level: "block"`** (honeypot / can't-sell / ruggable
  flags). The Friar app refuses to; your bot should too.
- **Empty `sources` means unchecked, not clean** — the checkers didn't answer.

## The exit guarantee

`friar.onChainStatus(positionId)` needs only the RPC: the on-chain position record
(owner, pool key, bins) is sufficient to exit even if every Friar server is down.
`closeTx` / `decreaseTx` build from that record, not from the API. PnL truth
(true-market marks, fee history) comes from the API; the chain path is the trustless
floor.

## Quote tokens

WETH is the default quote. **USDG** (`ADDRESSES.usdg` — beware ticker impostors; only
the canonical address counts) is the chain's dollar rail: USDG-quoted positions hold
dollar inventory with zero ETH beta. Pass `quote: ADDRESSES.usdg` to `planOpen`.

## Coming from other bin-based LP SDKs

The verbs map to what your bot already does: open (create position + add liquidity by
strategy) → `planOpen` + `openTxs`, add liquidity → `increaseTxs`, partial remove →
`decreaseTx`, claim-and-close → `closeTx` (one tx — burns auto-collect fees, no
rent-account cleanup), claim fees → `collectTx`. Explicit bins also allow
non-contiguous positions that contiguous strategy ranges can't express. Known gap: no
batch claim-all analogue yet — collect sequentially.

## Fees

The position manager takes a **5% performance fee on fees earned**, in-kind, at
collection — principal is never charged, and the rate is an immutable constructor
param (no function exists to raise it). Pool swap fees are dynamic (Liquidity Book
volatility accumulator): low base fee in calm, surging with volatility, decaying
back. Read the live fee via `poolState` / `fetchDynamicFee` — a dynamic-fee pool's
`slot0` lpFee is a placeholder, so don't read it from there.

## Lower-level surface

### Fee tiers

Base fee is part of a pool's identity: there is one immutable **FriarTier** hook per base
fee (0.3 / 0.8 / 1 / 2 / 5%), and a pool is `(pair, tickSpacing, hook)`. So `5% @ spacing
100` and `0.3% @ spacing 100` are different pools, and base fee varies independently of bin
width. To open a NEW pool at a chosen fee, pass that tier's hook as `feeHook`:

```ts
import { FEE_TIERS } from "@josephtaylor/friar-sdk";
const fivePct = FEE_TIERS.find((t) => t.pct === 5)!;
const plan = await friar.planOpen({ token, quote, spacing: 100, feeHook: fivePct.hook!, /* shape, amounts… */ });
const txs = await friar.openTxs(plan, owner);
```

Joining an existing pool needs no `feeHook` — pass `{ pool }` (or let the client resolve
the deepest). `FEE_TIERS`, `deployedFeeTiers()`, and `feeTierForHook(addr)` are exported.

## Lower-level surface

Everything the `FriarClient` facade does is exported directly: `planOpen` (pure,
given a `PoolState`), `poolKeyFor` (takes an optional `feeHook`), the
`buildOpen / buildIncrease / buildDecrease / buildClose / buildCollect / buildApprove`
encoders (pure), the `fetchPoolState / fetchDynamicFee / fetchPositionRecord /
fetchPositionIds / fetchOnChainStatus / fetchAllowance` chain reads,
`proportionalDeltas`, and `FriarApi`. Plus chain constants: `ADDRESSES`,
`robinhoodChain`, `poolId`, `DYNAMIC_FEE_FLAG`, `MAX_BINS`, `DEFAULT_SPACING`.
See `src/index.ts`.
