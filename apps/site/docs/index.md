# Friar docs

Friar is a DLMM for Robinhood Chain. Two contracts: a Uniswap v4 hook that sets a dynamic
swap fee, and a position manager that turns a shaped set of bins into one atomic unit you can
open and close in a single transaction.

These docs come in two halves. The **user guide** is how to drive the app, screen by screen.
**How it works** is the mechanism underneath, and everything in it is checkable on the
explorer.

## User guide

- **[Getting started](/docs/guide-start)** — what you need, connecting, and a tour of the four
  screens.
- **[The Tokens board](/docs/guide-tokens)** — finding something to LP, and what FEE/TVL
  actually tells you.
- **[The Friar Pools page](/docs/guide-pools)** — Friar's own venue, ranked by TVL, and
  opening straight into a pool.
- **[Opening a position](/docs/opening)** — the whole form, one control at a time, including
  fee tiers and the pool picker.
- **[Your position page](/docs/guide-position)** — reading the tiles, the bin chart, and the
  fees-versus-inventory split.
- **[Collecting fees](/docs/guide-fees)** — what Claim fees does, what it costs, when to bother.
- **[Closing a position](/docs/guide-close)** — Close versus Close & zap, and the guards on the
  exit.
- **[Positions and history](/docs/guide-history)** — the dashboard, the archive, the CSV.

## How it works

- **[Positions, bins and shapes](/docs/shapes)** — a position is one Uniswap LP position per
  bin. How that works underneath.
- **[How the fee is set](/docs/fees)** — the volatility accumulator, and what the base fee
  depends on.
- **[What Friar charges](/docs/costs)** — 5% of fees earned, nothing on principal, ever.
- **[Where your money sits](/docs/anatomy)** — which contract holds your funds, what each
  address can do, and how to verify it.
- **[When price leaves your range](/docs/range)** — out of range, why a breached pool's price
  lies, and how to read fees against inventory.

## The short version

<figure>
  <div class="frame"><img src="/docs/img/anatomy.svg" alt="Your wallet calls the Friar position manager, which mints liquidity inside Uniswap's v4 PoolManager. The Friar hook sets the dynamic swap fee and is never called on deposits or withdrawals. The treasury only receives the performance fee." /></div>
  <figcaption>The manager doesn't custody anything. Your liquidity lives in Uniswap's own
  PoolManager, and the manager keeps a record of what it minted there.</figcaption>
</figure>

- Your funds sit in **Uniswap's** v4 PoolManager, not in a Friar contract.
- The manager holds no balance. It mints, records, and routes payouts back to you.
- Payouts have no recipient argument. The address comes off the position record, so funds
  can only go to the position owner.
- The hook only sets the swap fee. Its permission bits mean it can't even run while
  liquidity is being added or removed.
- The fee is 5% of fees earned, an immutable constructor value. Principal is never charged.

## Addresses

| | |
|---|---|
| Position manager | [`0xBd76176c5524785452D80c4350f18e3A2040470E`](https://robinhoodchain.blockscout.com/address/0xBd76176c5524785452D80c4350f18e3A2040470E?tab=contract) |
| Friar hook, standard | [`0xFeDa24F0d3805170E7566cE617CfBa01cE05D080`](https://robinhoodchain.blockscout.com/address/0xFeDa24F0d3805170E7566cE617CfBa01cE05D080?tab=contract) |
| Friar hook, calm | [`0x5E6b0bbc811705b8d8234e9914c0507243fB1080`](https://robinhoodchain.blockscout.com/address/0x5E6b0bbc811705b8d8234e9914c0507243fB1080?tab=contract) |
| Uniswap v4 PoolManager | [`0x8366a39CC670B4001A1121B8F6A443A643e40951`](https://robinhoodchain.blockscout.com/address/0x8366a39CC670B4001A1121B8F6A443A643e40951) |
| Source | [github.com/josephtaylor/friar](https://github.com/josephtaylor/friar) |

Chain id is 4663. Both hooks are source-verified, and both are on Uniswap's official
hooklist, which is why their router quotes these pools.

## Risk

**The position manager isn't audited**, and it's immutable — no pause, no upgrade, no rescue.
The same immutability means nobody can rug you with an admin key either. [Where your money
sits](/docs/anatomy) has the detail. Size accordingly.
