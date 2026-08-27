# Closing a position

Closing burns every bin, collects every fee, and pays out. One call, whatever the shape.

There are two buttons, and the difference between them is what you're holding when it's over.

<figure>
  <div class="frame shot"><img src="/docs/img/ui-position-actions.png" alt="The position action row: Share PnL, Claim fees, Close, and the gold Close and zap to WETH button." /></div>
  <figcaption><b>Close</b> keeps the tokens. <b>Close &amp; zap</b> sells them for the
  quote.</figcaption>
</figure>

## Close

Burns the bins, sweeps the fees, sends you both sides as they are. If price was mid-range
you'll receive some quote and some token — that's what the position was actually holding.

Take this one when you want to keep the token, or when you'd rather choose your own moment and
venue to sell it.

## Close & zap to WETH

The same exit, plus a sale of the token side into the quote, so you end up holding one asset.
How that sale happens depends on what's available:

- **Best case, one transaction.** The app finds the deepest *price-sane* v4 venue for the pair
  and does the swap inside the same unlock as the burn. Nothing touches your wallet in between.
- **Otherwise, a guided three-step:** close, approve the router, sell on Uniswap's
  SwapRouter02 against the token's canonical v3 pool or v2 pair — each step narrated, with a
  min-out guard on the swap.

Two guards are worth knowing about, because they can make a close *revert* rather than fill:

- **A payout floor.** The quote you receive is floored at the last marked value less the venue
  fee and a 5% allowance for impact and staleness. A venue that has moved or is mispriced
  fails the transaction instead of quietly realising the loss for you.
- **Pay caps of zero.** An exit can never pull funds *from* your wallet. Without that cap, a
  venue whose hook returns an unbounded swap delta could turn "close my position" into a
  withdrawal against your allowance.

If the token has no route to the quote at all, the app says so and points you at plain
**Close** rather than guessing.

> The app may warn that it's routing through a **hooked venue** that takes its own swap fee.
> Launchpad pools (Doppler, Clanker, Pons-style) work this way and they're often the only real
> liquidity for the token, so they aren't excluded — the on-chain pay caps and the payout floor
> are what bound your downside, and the notice just tells you whose venue you're crossing.

## Choosing which

| | |
|---|---|
| **Close** | you want the token, or you'll sell it yourself later |
| **Close & zap** | you want to be flat and done, in one action |

If the thesis is gone, zap. If you'd have bought this token anyway, plain close and keep it.

## After it closes

<figure>
  <div class="frame shot"><img src="/docs/img/ui-position-closed.png" alt="A closed position page for LEMON.FUN/WETH #7: a CLOSED chip, realized PnL minus 44.10 percent, fees banked plus 12.58 percent, inventory delta minus 56.68 percent, current value zero, and a banner reading CLOSED, numbers frozen at close, with a link to the close transaction." /></div>
  <figcaption>A real closed position. The fee side returned 12.58% of capital in 36 hours; the
  token fell hard enough that inventory took 56.68% back. Net −44.10%.</figcaption>
</figure>

The page stays, and the numbers **freeze at close**. `Realized PnL`, `Fees banked` and
`Inventory delta` are final; current value goes to zero because there's nothing left in the
bins. The banner links to the close transaction on the explorer.

The position moves to [History](/docs/guide-history), and its bin chart becomes "shape at
close" — what the position looked like at the end.

**Leftover tokens.** If you used plain Close and later want to be flat, the closed position
page offers a sweeper for the owner: it sells your whole wallet balance of that token into the
quote through its canonical v3 or v2 pool. It runs off your balance rather than the position,
so it also mops up dust from earlier claims. A token with no direct pool against the quote
can't be swept there, and the app says so rather than pretending.

## If you'd rather wait

Closing isn't the only answer to a position that's gone against you. Out of range costs you
nothing except the fees you aren't earning while you sit there, and a position whose token has
genuinely repriced is often better *reopened around the new price* than held or dumped.
[When price leaves your range](/docs/range) is the page on that decision.

## What you don't need us for

Your exit doesn't depend on our servers. The whole position — owner, pool and every bin — is
stored on-chain, and the manager's `close` is callable directly from the explorer with nothing
but the position id. If the app is down, the indexer is behind, or Friar disappears entirely,
the money still comes out. That's the [governing
principle](/docs/anatomy) of the split between what's on-chain and what isn't.
