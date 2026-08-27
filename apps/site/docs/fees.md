# How the fee is set

A Friar pool recomputes the swap fee on every swap, from how far price has moved recently. It
has two parts: a base fee fixed by the pool's configuration, and a variable part driven by
realised volatility.

<figure>
  <div class="frame"><img src="/docs/img/fee-curve.svg" alt="Chart: the fee sits flat at a 0.80% base while the market is calm, spikes near-vertically to the 10% cap when price runs, then steps back down as each quiet swap halves the surge. A dashed line marks 1% for scale." /></div>
  <figcaption>Simulated with the real math and the deployed parameters, not drawn freehand.
  Flat at base, a near-vertical climb when price runs, then a staircase down as each quiet
  swap applies the 50% reduction.</figcaption>
</figure>

## The two parts

```
base     = the pool's fixed base fee (set by which fee tier it belongs to)
variable = (volatilityAccumulator × tickSpacing)² × variableFeeControl / 100
fee      = min(base + variable, 10%)
```

**The base is a property of the pool, not of Friar, and it is part of the pool's identity.**
Each base fee is its own immutable hook, so a pool's base fee is fixed the moment it is
created and can never be retuned. When you create a pool you pick a **fee tier**:

| fee tier | base fee |
|---|---|
| 0.30% | 0.30% |
| 0.80% | 0.80% |
| 1% | 1% |
| 2% | 2% |
| 5% | 5% |

Base fee is **independent of bin width**. The same pair can have a 5% pool at 1%-wide bins and
a 5% pool at 3.3%-wide bins, and they are different pools; likewise a 0.30% and a 5% pool at
the same bin width. (This is the model Meteora LPs know: pick your fee, pick your granularity,
each combination is its own pool.) Older Friar pools set base fee from bin width instead — a
frozen `baseFactor × tickSpacing` — and still work; the fee tiers are how new pools are made.

The variable part is **quadratic** in the accumulator, so small movements barely move the fee
and large ones escalate it quickly. The total is capped at 10%.

## The volatility accumulator

The mechanism comes from LFJ's Liquidity Book (`joe-v2`, MIT). It is a state machine that
tracks how far price has moved since the pool was last quiet.

- Price is tracked in buckets, one bucket per `tickSpacing`. Every bucket price has moved away
  from its reference adds to the score.
- If the pool has been quiet for the **filter period** (10 seconds), the reference re-anchors
  to the current price and the score is cut by the **reduction factor** (50%).
- After a full **decay period** (10 minutes) of quiet, it's back to zero.
- The score is capped, so the fee can't run away.

The accumulator measures **swap-to-swap gaps, not wall clock time**. During heavy trading the
gaps are short, the reference does not re-anchor, and the score builds across the whole move.
When trading thins out, each swap re-anchors and halves it, which is the staircase in the chart
above.

| Parameter | Value | What it does |
|---|---|---|
| `baseFeePips` | 0.3 / 0.8 / 1 / 2 / 5% | the base fee — one immutable hook per tier |
| `filterPeriod` | 10s | quiet gap before the reference re-anchors |
| `decayPeriod` | 600s | quiet gap for the surge to fully reset |
| `reductionFactor` | 50% | how much of the score survives each re-anchor |
| `variableFeeControl` | 40000 | surge steepness |
| `maxVolatilityTicks` | 7000 | the price move at which the surge saturates |

Every fee-tier hook shares these surge parameters and differs only in its base fee. They are
all immutable, so a pool's fee behaviour is fixed at creation and no one, including us, can
change it afterward. The surge ceiling is expressed in **ticks** of price movement (not bin
units), so it saturates at the same price move whatever bin width the pool uses.

## What it looks like on a pool

On a pool with steady memecoin flow, the fee spends most of its time at or near base, with the
surge concentrated in short windows. Typical behaviour over a day of trading:

- the volume-weighted average fee sits modestly **above** the base, since most swaps arrive
  while the pool is calm
- the peak reaches the 10% cap during the sharpest moves
- a minority of swaps, in the region of one in ten, arrive while the fee is already above 1%

The last one is the part that decides how much the surge is worth. Each pool's fee history is
recorded per five-minute bucket, so the average and the peak for any given pool are visible in
the app rather than estimated.

## Reading it live

The hook exposes `previewFee(poolKey)`, a read-only view of the exact fee the next swap would
pay. The app uses it for the live fee gauge, and anyone can call it.

One deviation from Liquidity Book worth stating: LB escalates the fee *within* a single swap as
it crosses bins. A `beforeSwap` hook prices each swap from movement observed **before** it, so
the swap that causes a big move pays the pre-move fee and the surge lands on everything after
it. Since the reference doesn't re-anchor inside the filter window, the movement isn't lost,
just priced one swap late. In practice the followers are the arbitrage flow the fee exists to
charge.
