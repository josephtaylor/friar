# The Friar Pools page

The Tokens board is "what could I LP." The **Friar Pools** page is the other question:
"where is Friar's liquidity now." It lists Friar's own pools — the ones people have actually
opened positions in — ranked by how much value is locked in each.

<figure>
  <div class="frame shot"><img src="/docs/img/ui-pools.png" alt="The Friar Pools page: a total value locked banner, then a table of pools with one row per pool showing the pair, its base fee and bin width, TVL, 24h volume, fee/TVL, LP count, and an Open button." /></div>
  <figcaption>The venue at a glance: the TVL banner, then every live pool with its fee tier,
  bin width, and how hard its liquidity is working.</figcaption>
</figure>

## The total, up top

The banner at the top is Friar's **total value locked**: every open Friar position, marked to
the true market price, summed across all pools. It's the one number that says how much
liquidity the venue is carrying.

## The pools, ranked by TVL

Below it, one row per pool, biggest first. Each row shows:

- **Pool** — the pair, the pool's **fee tier** (its base fee), and its **bin width**. A pair
  can appear more than once, because each fee tier and width is a separate pool.
- **TVL** — value locked in that pool, in dollars.
- **24h vol** — how much traded through it in the last day.
- **Fee / TVL** — a rough read on how hard the liquidity is working: the last day's fees as a
  share of the value locked. Higher means more fee income per dollar deposited.
- **LPs** — how many open positions are in the pool.

Only pools that actually hold liquidity appear here; empty pools are left off.

## Opening into a pool

Every row has an **Open** button. It drops you into the open screen with that exact pool
already selected — the pair, the quote side, the fee tier, and the bin width all filled in —
so you land straight on "join this pool" and just set your range and amounts. It's the fastest
way to add to a pool you can already see is working.

If the pool you want doesn't exist yet, open from the [Tokens board](/docs/guide-tokens) or the
[open screen](/docs/opening) instead and pick *Create a new pool*.
