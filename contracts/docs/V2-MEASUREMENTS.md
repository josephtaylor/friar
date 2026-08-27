# FriarV2 — the measurements behind the defaults

Every parameter in `script/DeployFriarV2.s.sol` came from replaying real Robinhood Chain
(4663) swap history rather than from taste. This file records those numbers so the choices
can be checked without the private harness.

Method: raw v4 `Swap` logs pulled from the singleton PoolManager, replayed through a
BigInt-exact mirror of `FriarMath` that self-checks against the same vectors as
`test/FriarMath.t.sol`. Attacks were simulated against the same replay. Where an attack
required moving price, its cost was computed from the pool's real in-range liquidity
(`L × Δ√P`), not estimated.

## The three flow regimes

Inter-swap gaps vary by an order of magnitude across pools on the same token, and that
variation is what a constant `filterPeriod` cannot accommodate.

| regime | pool | median gap | in-range liquidity |
|---|---|---|---|
| dense | v3, 35,383 swaps over 36h | 3.7s | — |
| routed | v4 PONS/USDG, 1,724 swaps over 6.3h | 10.5s | 1.81e18 |
| thin | v4 PONS/USDG, 344 swaps over 6h | 57.1s | 9.02e17 |

Two facts worth keeping in view:

- Inter-swap gap tracks **routing share**, not the chain. Friar's own ~$200 pools showed
  49-224s gaps, which measured their lack of TVL rather than 4663's trading rhythm. Never
  tune fee parameters from an unrouted pool.
- Swaps are **bursty**. On the routed pool the median gap is 6.1s overall but **1.2s**
  inside top-decile volatility windows, and 79% of swaps there arrive within 10s. The
  daily mean hides the only distribution that matters for the accumulator.

## The adaptive window: measured, then cut

An earlier version of this hook made `filterPeriod` adaptive, tracking an EWMA of
inter-swap gaps. Replayed against a fixed swap trace it looked strong: +16% revenue on the
routed pool, +113% on the thin one, no regression on dense flow, and 1.75x to 27x longer to
grind the fee back to base.

**It was cut anyway.** The replay's numbers were real and the conclusion drawn from them was
not, because every one of them assumed flow was exogenous. Four things killed it:

- **Cadence is not economically meaningful.** A $0.01 swap and a $100k swap are one
  observation each. On a chain where gas rounds to $0.0003, that signal is cheap to steer.
- **Normalising it economically collapses it.** The natural normaliser is notional over
  active liquidity, which *is* price displacement, which is what the LB accumulator already
  measures. The separate cadence channel does not measure anything independent.
- **Routing is endogenous.** Adaptive charges more; charging more on a thin pool costs
  routing. Estimated loop gain for fee → routing → cadence → fee was **0.264 in the thin
  regime against 0.059 routed** — 4.5x stronger exactly where a bootstrapping pool lives.
  So the earlier claim that adaptive was "strictly dominant, never worse by construction"
  was wrong: the floor protects the accumulator's behaviour, not the pool's competitiveness.
- **Sparse observation is a symptom, not a cause.** A pool sees long gaps because it is
  losing routes. Making it charge its few remaining trades more attacks the causal chain
  backwards. More usable liquidity near spot attacks it at the front:
  better execution → more routes → more frequent reference updates → smaller observed
  episodes → lower variable fees → more routes.

What replaced it is per-pool `filterPeriod` as **configuration**, defaulting to LB's 10s.
That gets a flow-matched window without a runtime controller, without a second endogenous
signal, and without a feedback loop to defend.

### Why the default is the short end, not a matched value

The failure directions are asymmetric:

| `filterPeriod` | effect | severity |
|---|---|---|
| too short | references re-anchor constantly, surge never fires, pool behaves like a static-fee pool | benign |
| too long | references stop refreshing, accumulator ratchets to its ceiling, fee pins high | **starves routing** |

Regime drift runs thin → routed, which is *into* the severe direction. And the usual escape
hatch — launch a new pool with a better config — means splitting depth, which for a venue
competing on depth is not a real option. So the default is LB's value and lengthening it
needs positive evidence a pool will stay sparse.

## Base fee

The bar: a pool must earn more LP fee revenue than a static 1% pool or nobody uses it. On
$483,325 of routed flow, spacing 150:

| base | avg fee | revenue | vs static 1% ($4,833) |
|---|---|---|---|
| 0.30% | 0.422% | $2,041 | 42% |
| 0.60% | 0.722% | $3,491 | 72% |
| **0.90%** | 1.022% | $4,940 | **+2.2%** |
| 1.00% | 1.122% | $5,423 | +12.2% |

The surge adds a base-independent **+12.2 bps** on routed flow and **+36.8 bps** on thin
flow, so break-even against a static 1% pool is a **0.878%** base routed, **0.63%** thin.
The 0.90% default clears both.

Separately, and against the low-base case: on two static-fee pools of the same token in the
same window, the 0.350% pool captured **2.7x** the volume per unit of in-range liquidity of
the 0.799% pool. Fee level clearly moves routing share. But revenue per unit of depth was
only **15% lower** for the pricier pool (implied elasticity ≈ -1.2, so revenue ≈ `fee^-0.2`),
which is close enough to flat that two data points cannot distinguish it from zero. Fee
level is therefore roughly revenue-neutral and materially volume-relevant. Treat that as a
single point estimate, not a curve.

## What this does NOT establish

The replay treats routed flow as **exogenous**: a fixed swap trace goes in, fees come out.
Live behaviour is a loop — fee affects routing, routing affects cadence, cadence affects the
window, the window affects fee. Estimated loop gain at the two measured operating points is
0.059 (routed) and 0.264 (thin), and the clamps force it to zero outside the adaptive band,
because a pinned window has no cadence sensitivity. That is reassuring, not conclusive:
interior gain could peak higher, since the surge-vs-gap slope was linearised from two points
and routing elasticity may rise sharply where a quote crosses a competing route.

The elasticity underpinning all of it is also weaker than its sample size suggests. It was
inferred from two pools with different fees and different volumes, so it is a correlation:
depth, price impact, competitor liquidity and arbitrage all move both variables, and part of
the -1.2 may be common market conditions rather than flow reacting to fees.

The decisive test is therefore not another fixed-trace backtest. It is a simulation where
route allocation is computed from actual quotes against a competing pool, so elasticity
*emerges* and can be compared with the -1.2 estimate, scored on LP net PnL and routing share
rather than fee revenue. Until that exists, treat the revenue figures above as an upper bound
measured under an assumption that production will violate.

## Accepted limitations

- **One fee per swap.** v4 fixes the fee in `beforeSwap`, so a swap's fee is independent of
  its own size and a trade can be split (small leg to walk price onto the reference, then a
  large leg at base). Measured on the routed pool: the reversion leg costs ~$7,323, only
  **2 of 1,724 swaps (0.1%)** are large enough to profit, and total surge revenue falls
  0.1%. Structural to v4, not to this hook; native LB avoids it by charging per bin crossed.
- **The EWMA counts swaps, not volume**, so dust can steer the window. It cannot breach the
  floor, so it cannot make this less safe than the constant, but the uplift above the floor
  is manipulable. Volume-weighting would fix it at the cost of another storage word.
- **Spacing-invariance of the surge ceiling stops below ~5-tick spacing**, where the derived
  uint24 accumulator clamps. Exact at 10 and 5; clamped at 4 and 1.
