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

## Adaptive window vs LB's constant

Same base fee, spacing 150, `k=3`, floor 10s, ceil 300s.

| regime | constant | adaptive | revenue | time to grind fee back to base |
|---|---|---|---|---|
| dense 3.7s | 1.406% avg, $366 | 1.415% avg, $368 | **+0.7%** | 90s both (identical, by design) |
| routed 10.5s | 0.364% avg, $1,760 | 0.422% avg, $2,041 | **+16%** | 80s → 140s |
| thin 57s | 0.313% avg, $265 | 0.668% avg, $566 | **+113%** | 70s → 1,889s |

On the thin pool the constant leaves the fee at base for **79.6%** of swaps; adaptive cuts
that to 5.6%. The dense case is deliberately flat: that is the floor doing its job.

### Why the floor is a safety property, not a preference

With `filterFloor` removed, on dense (3.7s) flow and whole-second `block.timestamp`, the
EWMA collapses toward zero, every swap re-anchors the reference, the accumulator never
builds, and **revenue halves** versus the constant ($267 vs $564). The floor makes
adaptivity one-way: the window can only ever be longer than LB's constant, never shorter.
`MIN_FILTER_FLOOR` is enforced at registration, revalidated at initialize, and clamped
again locally in `_window`.

## Attack economics

Costs include the price impact required to move buckets, computed from real liquidity. Gas
is $0.0003/swap at 0.0202 gwei and ETH $1,900, so gas alone never bounds an attack here.

| attack | constant | adaptive |
|---|---|---|
| suppress (grind fee to base) | 70-90s | 140s routed, 1,889-4,796s thin |
| wait-it-out | fee drops after 10s | holds past 10s, decays from 30s |
| grief (pin fee high) | $386,156/hr | $16,775/hr thin, $838,842/hr routed |

Grief reaches the 10% cap on **both** designs; it is uneconomic on both because moving
price costs more per hour than the pool's entire turnover. Counting only gas makes it look
viable, which is the mistake to avoid.

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
