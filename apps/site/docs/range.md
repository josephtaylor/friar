# When price leaves your range

A bin only earns while price is inside it. As price moves through your range, your position
converts from one token into the other, bin by bin. Once price is past the last bin you're
**out of range**: fully converted, earning nothing, waiting.

## Which edge matters

- **Out the top.** Your asks all filled. You sold into strength and you're holding the quote
  token. This is the benign one — you took profit on the way up, and the position stops earning
  until price comes back.
- **Out the bottom.** Your bids all filled. You bought the whole way down and you're holding the
  token. This is the dangerous one, and it's what impermanent loss feels like from the inside.

A range that breaches upward sold on the way up. A range that breaches downward absorbed the
whole fall as inventory.

## A breached pool's price lies

When price escapes the range entirely, the pool has no liquidity left to trade through, so its
own quoted price **freezes at the edge** while the real market keeps moving. It can sit there,
stale, for as long as nobody arbitrages it back.

This matters because a lot of dashboards mark positions at the pool's own price. If the pool is
frozen at −20% and the market is actually at −60%, those dashboards will tell you your position
is worth far more than it is.

> Friar marks everything — the dashboard, snapshots, breach checks — against a **reference
> market price** from the deepest venue for the pair, not the pool tick. When the two disagree
> the pool price is shown separately and labelled as pinned.

## Reading the split

Every LP position decomposes into two numbers, and the total on its own hides which situation
you're in:

- **fees earned** — the toll income. More volume through your bins, more fees.
- **inventory change** — what rebalancing did to you. If the token fell, you hold more of it,
  and this is negative.

A worked example from a real position we ran. The token fell 42% in about twelve hours:

```
fees earned       +14.75%
inventory change  −41.71%
net               −26.97%
```

The position is down 27%, and the fee side returned 14.75% of capital in half a day. Both are
true at once, and the net figure shows neither. A position down 27% that is still earning is a
different situation from one down 27% that has stopped, and only the split separates them.

## What to do about it

There's no automation yet. These are the manual options:

- **Collect** while you're in range. Fees stop accruing the moment you breach, and collecting
  realises them in-kind so they're banked rather than marked.
- **Close** if the thesis is gone. One call burns every bin, collects everything, and pays out.
- **Wait**, if you think price comes back. Out of range costs you nothing except the fees you
  aren't earning while you sit there.
- **Reopen around the new price** rather than waiting, if the token has genuinely repriced. A
  position centred where the market actually is earns; one centred where it used to be doesn't.

Token selection dominates the outcome. A well-shaped position in a token that goes to zero
still goes to zero, and no fee schedule changes that.

## If the numbers look stale

Charts, PnL and history all come from an indexer reading the chain. If it's behind, what you're
looking at is old. That's a display problem, never a fund problem — withdrawal reads the chain
directly and doesn't ask our servers anything. See
[where your money sits](/docs/anatomy).
