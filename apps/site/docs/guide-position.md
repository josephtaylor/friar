# Your position page

One position, everything about it. This is where you check on it, and where the four actions
live.

<figure>
  <div class="frame shot"><img src="/docs/img/ui-position.png" alt="A Friar position page for PONS/WETH #9: a header with an IN RANGE chip and the Share PnL, Claim fees, Close and Close and zap buttons; four tiles reading net PnL minus 8.20 percent, fees earned plus 1.70 percent, inventory delta minus 9.90 percent and current value 0.222655 WETH; and a bin chart with orange bins on the left, a pale active bin, and green bins on the right." /></div>
  <figcaption>A live 63-bin Curve position. The red line in the bin chart is where the price
  actually is.</figcaption>
</figure>

## The header

<figure>
  <div class="frame shot"><img src="/docs/img/ui-position-actions.png" alt="Position header: PONS / WETH, id number 9, open 33.7 hours, an IN RANGE chip, and the buttons Share PnL, Claim fees, Close, and Close and zap to WETH." /></div>
</figure>

The pair, the position id, how long it's been open, and a status chip. The chip is the fastest
read on the page: **IN RANGE** means price is inside your bins and you're earning. **ABOVE
RANGE** or **BELOW RANGE** means it isn't, and you're not — see [when price leaves your
range](/docs/range).

Click the token symbol to copy its contract address. `pool 0x5a46…8a0b` under it is the pool
id, and `pool chart ↗` opens the pair on Dexscreener.

The four buttons on the right are covered in [collecting fees](/docs/guide-fees) and [closing a
position](/docs/guide-close). They only render for the owner — opening someone else's position
through a `?address=` link shows the page read-only.

## The four tiles

<figure>
  <div class="frame shot"><img src="/docs/img/ui-position-tiles.png" alt="Four tiles: NET PNL minus 8.20 percent (minus 0.019906 WETH), FEES EARNED plus 1.70 percent (plus 0.004128 WETH), INVENTORY DELTA minus 9.90 percent (minus 0.024034 WETH), and CURRENT VALUE 0.222655 WETH, invested 0.242562." /></div>
  <figcaption>Net PnL is the sum of the two middle tiles. Reading it on its own tells you
  almost nothing.</figcaption>
</figure>

This decomposition is the point of the page.

- **Fees earned** — toll income. Always positive, always growing while you're in range.
- **Inventory delta** — what rebalancing did to you. Negative when the token fell and you
  bought the whole way down; positive when it rose and you sold into it.
- **Net PnL** — those two added together.
- **Current value** — what the position is worth right now, against `invested`.

In the position above: down 8.20% net, but the fee side has returned 1.70% of capital in 33
hours while inventory is −9.90%. **Both are true at once, and the net figure shows neither.**
A position down 8% that's still earning is a different situation from one down 8% that has
stopped, and only the split separates them.

> Everything here is marked against a **reference market price** from the deepest venue for the
> pair — never the pool's own tick. A pool whose price has escaped your range freezes at the
> edge and lies about what your position is worth. That's the single most common way LP
> dashboards mislead people. [When price leaves your range](/docs/range) explains it.

## The bin chart

<figure>
  <div class="frame shot"><img src="/docs/img/ui-position-bins.png" alt="Liquidity per bin: orange 'quote waiting' bins on the left, a pale 'active' bin at the price line, green 'token held' bins on the right, labelled 19 waiting / 1 active / 43 token, spanning minus 26 percent to plus 102 percent." /></div>
</figure>

Each bar is one bin, and the colour tells you what's actually in it right now:

- **orange — quote waiting.** Bids below the price, holding the quote token, waiting to buy.
- **green — token held.** Asks above the price, holding the token, waiting to sell.
- **pale — active.** The one bin the price is sitting in. This is the only bin earning fees at
  this instant.

The counts top-right (`19 waiting / 1 active / 43 token`) are the same thing as a number. As
price moves through your range, bins flip from orange to green — that *is* the position
converting from one token into the other, one bin at a time.

The red line is the market price. The percentages at either end are how far each edge sits from
it, so `−26% … +102%` means a 26% drop empties your bids and a 102% pump fills your asks.

## The price chart

Below the bins, a candle chart for the pair, with a link out to Dexscreener. It's context
only — nothing on the page is computed from it.

## When numbers look stale

Charts, PnL and history all come from an indexer reading the chain. If it's behind, what you're
looking at is old. That's a display problem, never a fund problem — the position itself, every
bin and its owner, lives on-chain, and withdrawal reads the chain directly without asking our
servers anything. See [where your money sits](/docs/anatomy).

## Sharing

<figure>
  <div class="frame shot narrow"><img src="/docs/img/ui-share.png" alt="The Share PnL dialog showing a generated card with the FRIAR wordmark, PONS/WETH, minus 8.20 percent, fees plus 1.70 percent, and controls to switch between percent and amount, WETH and USD, amounts and percent-only, plus Post on X, Copy link and Download PNG buttons." /></div>
  <figcaption>Pair, duration, PnL and fees. Never your shape, your range, or your
  wallet.</figcaption>
</figure>

**Share PnL** renders a card for the position. You choose whether the headline number is a
percent or an amount, whether it's denominated in WETH or USD, and whether absolute amounts
appear at all — `% only` publishes the return without publishing the size. Then post it, copy
the link, or download the PNG.
