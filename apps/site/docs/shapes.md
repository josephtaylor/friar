# Positions, bins and shapes

A Friar position is a set of **bins**. Each bin is one narrow price range holding some
liquidity. You choose how wide the whole thing is, how many bins to spread across, and how
the liquidity is distributed between them.

If you've used a bin-based LP venue before, this is the same model. If you haven't, the short
version is that it's Uniswap concentrated liquidity with the range chopped into slices you
can shape.

## The three shapes

<figure>
  <div class="frame"><img src="/docs/img/shapes.gif" alt="Animation cycling between three liquidity distributions: Bid-Ask weighted to the edges, Spot flat across the range, and Curve concentrated around the current price." /></div>
  <figcaption>Gold bins below the price hold the quote token and act as resting buys. Green
  bins above hold the token and act as resting sells. The pale bin straddling the price holds
  both, and earns the most, because every swap trades through it.</figcaption>
</figure>

- **Spot** spreads liquidity evenly. No view on where price goes.
- **Curve** concentrates it around the current price. Earns the most if price chops in place,
  and stops earning fastest if price runs.
- **Bid-Ask** weights the edges and leaves the middle thin. Buys dips and sells rips.

Bins below the price only need the quote token. Bins above only need the token. So a
single-sided shape needs no swap at all, which is why opening one is cheaper than opening a
two-sided one.

## What the contract actually does

The app shows you one object. Underneath, the manager mints **one Uniswap v4 LP position per
bin**, all inside a single transaction, and stores one record of the set.

<figure>
  <div class="frame"><img src="/docs/img/shape-anatomy.svg" alt="Diagram: you choose shape, range, bin count and deposit; the manager computes a liquidity distribution across bins and mints one Uniswap v4 LP position per bin, each identified by its tick range and a salt derived from the position id and bin index." /></div>
  <figcaption>You choose the range, the shape and the bin count. The manager mints one v4 LP
  position per bin in a single transaction and keeps a single record of the set.</figcaption>
</figure>

Each bin becomes a v4 position keyed by four things: the pool, the owner, the tick range, and
a **salt**.

```
salt = keccak256(abi.encodePacked(uint256 positionId, uint256 binIndex))
```

The owner Uniswap sees is the manager contract, the same for everybody. The salt is what keeps
your bins separate from everyone else's: it's derived from your position id, so no two
positions can collide even in the same pool at the same ticks. That is what isolates one
owner's bins from another's.

Some consequences worth knowing:

- **Fees accrue per bin, separately.** The app sums them. A bin that price never reached
  earned nothing, and the split shows that.
- **`close` unwinds everything in one call.** It burns every bin, collects all their fees,
  takes the performance fee in-kind, and pays out once.
- **Bin width is the pool's `tickSpacing`,** so it's fixed for the life of the pool. 160 ticks
  is about 1.6% per bin. Wider bins mean coarser granularity and a higher base fee, because
  the base fee is `baseFactor × tickSpacing`.
- **Up to 100 bins per position.** More bins means finer shaping and more gas.

## What happens as price moves

A bin only earns while price is inside it, so your position converts from one token to the
other as price travels through the range, and stops earning once it's past the last bin.

Which edge you exit matters a lot, the pool's own price stops telling the truth once you're
breached, and the fees-versus-inventory split is how to read the result. That is
[its own page](/docs/range).
