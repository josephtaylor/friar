# Positions and history

Two screens, one book. **Positions** is what's open, **History** is what's closed, and the
numbers are computed the same way on both.

## Positions

<figure>
  <div class="frame shot"><img src="/docs/img/ui-positions.png" alt="The Friar Positions dashboard: tiles for portfolio value 0.3176 WETH, open PnL minus 5.62 percent with a fees and inventory breakdown, fees earned plus 0.0046 WETH, and 2 open positions with 12 closed and 14 all-time; below, two position cards for APES/WETH and PONS/WETH each with a bin chart and its own PnL." /></div>
  <figcaption>The whole book in one screen. The tiles aggregate every open position; the cards
  are each one.</figcaption>
</figure>

The tiles across the top:

| Tile | What it is |
|---|---|
| **Portfolio value** | everything open, marked to market, with a sparkline of where it's been |
| **Open PnL** | aggregate return, and underneath it the split — `fees +1.36% · inv −6.99%` |
| **Fees earned** | total fee income across open positions, net of the performance fee |
| **Open positions** | how many are live, plus the closed and all-time counts |

The `fees … · inv …` line under Open PnL is the same decomposition as on a [position
page](/docs/guide-position), rolled up. It's the fastest read on the screen: it tells you
whether the book is being carried by fee income or dragged by inventory.

### The cards

<figure>
  <div class="frame shot"><img src="/docs/img/ui-position-card.png" alt="A position card for PONS/WETH #9: 63 bins, open 33.6 hours, an IN RANGE chip, a bin chart annotated '26% drop / 102% pump to breach', and minus 8.22 percent with fees plus 1.70 percent, inv minus 9.93 percent, value 0.2226 WETH." /></div>
</figure>

One card per open position, each with its shape drawn live. Three things to read:

- **the status chip** — IN RANGE, or which edge it has left
- **the breach line** under the chart — `26% drop / 102% pump to breach`. How far price has to
  move before this position stops earning, in both directions. It's the single most useful
  number on the card
- **the PnL block** on the right, with the same fees/inventory split

Click any card to open its [position page](/docs/guide-position).

With nothing open, the screen offers you the Tokens board and the open button instead.

## History

<figure>
  <div class="frame shot"><img src="/docs/img/ui-history.png" alt="The Friar History screen: tiles for realized PnL minus 0.1377 WETH, fees banked plus 0.0748 WETH, 12 closed positions with 8 of 12 closed green, and average hold 17.4 hours; below, a table of closed positions with final PnL, fees banked and inventory delta for each." /></div>
  <figcaption>Closed positions, frozen at close. The Export CSV button is top-right.</figcaption>
</figure>

Realized PnL and fees banked across everything closed, how many closed green, and how long you
typically hold. The table is one row per closed position, newest first, with the same three
numbers each time: final PnL, fees banked, inventory delta.

Read down the fees column and you learn something the PnL column hides. In the book above,
every single closed position banked positive fees — the losses are entirely inventory. That's
what LPing a volatile token looks like when the fee model is working and the token selection
isn't.

**Export CSV** downloads the lot — id, token, open and close timestamps, and the PnL, fees,
inventory and value columns in WETH — for whatever you do your accounting in.

Click any row for its [position page](/docs/guide-position), which stays available forever with
its numbers frozen at close.

## Sharing a book

Both screens are keyed by address and read from public ledger data, so either can be opened
read-only for any wallet:

```
https://app.friar.fi/?address=0xTheirAddressHere
https://app.friar.fi/history?address=0xTheirAddressHere
```

No wallet needed, no action buttons rendered. Useful for sharing your own book, or for looking
at someone else's.
