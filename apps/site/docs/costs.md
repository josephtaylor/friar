# What Friar charges

A share of the fees your position earns. Nothing else, ever.

| | |
|---|---|
| **Any position** — shaped (Spot, Curve, Bid-Ask) or a simple single bin | **5%** of fees earned |
| The hook, at the pool level | **0%** |
| Deposits, withdrawals, principal | **never charged** |

The rate is an immutable constructor value on the manager, under a hard 20% sanity ceiling in
the code. There is no function that raises it. A different rate would be a different contract
that you'd have to choose to use.

## How it's taken

Uniswap v4 reports fees earned separately from principal whenever liquidity is touched. The
manager takes its share of **exactly that number**, in-kind, in the same transaction, and sends
it to the treasury. Your principal is never part of the calculation.

So if a position earns 0.05 WETH in fees and you collect:

```
fees earned      0.0500 WETH
performance fee  0.0025 WETH   (5%)
you receive      0.0475 WETH
principal        untouched
```

You only pay when you've earned. There's no management fee, no deposit fee, no withdrawal fee,
and nothing accrues while a position sits idle.

## Why one rate

Earlier managers split the rate by position type: 10% on shaped positions, 1% on a simple
single bin. Measured over the live positions that split showed no yield difference between
the types; it mostly taught people to optimise their bin count around the fee instead of
around the market. One flat rate for everything replaced it in August 2026.

Your rate is fixed by the manager your position opened on, for the position's whole life. A
position opened under an earlier manager keeps that manager's rates until it's closed.

## Fee exemption

The treasury can **waive** the fee for an address, and that's the only thing it can do to a
rate. It cannot raise one, for anybody. Exemptions live in a shared on-chain registry
(`FeeExemptionRegistry`) that survives manager upgrades, and its `setExempt` is
discount-only by construction, which is why a compromised treasury key can lose Friar revenue
and nothing else. Details in [where your money sits](/docs/anatomy).

## What you also pay, that isn't us

- **Gas.** Robinhood Chain blocks are ~100ms and gas is cents, but a 100-bin open is a large
  transaction. Fewer bins is cheaper.
- **Swap fees on zaps.** If you open from a single token, the swap leg pays whatever the venue
  it routes through charges. That goes to that pool's LPs.
- **The market.** Providing liquidity means holding inventory. No fee schedule fixes a token
  going down, and that's usually the number that dominates. See
  [when price leaves your range](/docs/range).
