# Collecting fees

Fees accrue inside your bins as people trade through them. They sit there, uncollected, until
you do something about it — collecting turns them from a number on a screen into tokens in your
wallet.

<figure>
  <div class="frame shot"><img src="/docs/img/ui-position-actions.png" alt="The position action row with Claim fees highlighted among Share PnL, Close, and Close and zap to WETH." /></div>
  <figcaption><b>Claim fees</b> takes the fees and leaves the liquidity exactly where it
  is.</figcaption>
</figure>

## What Claim fees does

One transaction. It sweeps the accrued fees out of every bin, takes the performance fee, and
sends the rest to you. **Your liquidity isn't touched** — the bins stay minted, the shape is
unchanged, and the position keeps earning the moment the transaction lands.

You get paid **in kind**: whatever the bins accrued. A position that's been trading in both
directions pays out some of each token, not just the quote.

The payout goes to the position's owner and nowhere else. The call takes no recipient
argument — the address comes off the on-chain position record, so there's no version of this
that sends your fees somewhere you didn't choose.

## What it costs

The performance fee is taken here, at collection, on-chain:

- **10%** of fees earned on a shaped (multi-bin) position
- **1%** on a simple (single-bin) one

**Principal is never charged.** Both rates are immutable constructor values on the manager,
under a hard 20% cap that can't be raised by anyone, including us. [What Friar
charges](/docs/costs) has the full picture.

The `Fees earned` tile on your position page is already **net** of this — it's what you'd
actually receive, not a gross number you have to discount.

## When to collect

There's no schedule and no automation. The tradeoffs:

- **Fees stop accruing the moment you go out of range.** Collecting while you're in range
  realises them; leaving them uncollected while price runs away means they're still yours, but
  they've stopped growing.
- **Uncollected fees are still marked.** They show up in `Fees earned` and in your portfolio
  value whether or not you've claimed them, so collecting doesn't change your PnL — it changes
  where the money sits.
- **Each collect costs gas.** Cents on this chain, but it's not free, and collecting a dust
  amount is worth less than the transaction.
- **Closing collects everything anyway.** If you're about to close, don't claim first — a
  [close](/docs/guide-close) sweeps the fees in the same call.

The honest summary: collect when the amount is worth banking, or when you want the tokens for
something else. There's no penalty for leaving them, and no reward beyond getting them into
your wallet.

## After collecting

The page refreshes itself once the transaction confirms — the app pushes the transaction into
the indexer directly rather than waiting for the polling loop to reach that block, so the tile
updates in seconds rather than minutes.

The claimed fees land in your wallet as the raw tokens. If you'd rather hold the quote, sell
them yourself, or use the sweeper on a closed position described in [closing a
position](/docs/guide-close).
