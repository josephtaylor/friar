# The Tokens board

The Tokens board is the app's front door. It lists what's actually trading on Robinhood Chain
and, for each token, how much fee income the incumbent venue's liquidity is earning.

<figure>
  <div class="frame shot"><img src="/docs/img/ui-tokens.png" alt="The Friar Tokens board: a table of tokens ranked by 24h volume, with columns for market cap, price change, volume, liquidity, fee over TVL, and the incumbent venue's fee tier, plus an Open button on each row." /></div>
  <figcaption>Ranked by 24h volume by default. Every column header sorts, and clicking
  anywhere on a row takes you to the open screen with that token filled in.</figcaption>
</figure>

## Reading the columns

| Column | What it is |
|---|---|
| **MCAP** | market cap, from Dexscreener |
| **24H** | price change over the selected window |
| **VOL 24H** | traded volume over the window. This is the raw material — no volume, no fees |
| **LIQ** | liquidity sitting in the incumbent venue |
| **FEE/TVL** | volume × the incumbent's fee ÷ liquidity. **The one to look at** |
| **INCUMBENT FEE** | the fee tier of the venue that currently has the highest flow |

**FEE/TVL is the column that matters.** It's what LPs at the existing venue actually earned per
dollar of liquidity over the window — the fee side of the return, before any inventory risk.
A token showing 99% is paying its LPs roughly a percent of TVL per day in fees. That is the
opportunity; it is not the outcome, because it says nothing about what the token's price did
to the inventory those LPs are holding. See [when price leaves your
range](/docs/range) for the other half of that.

When the incumbent's fee can't be resolved, FEE/TVL falls back to plain turnover — `3.2×`
means volume ran 3.2 times the liquidity, which is the same signal without the fee multiplier.

**INCUMBENT FEE** is what the dominant venue charges, and it is the multiplier behind
FEE/TVL. It is not a prediction about volume. A cheaper fee does not pull flow across on its
own: routers price the whole trade, so depth at the touch decides where an order goes and the
fee differential is a rounding error next to it. Read this column as the input to the yield
above, not as a reason the flow would move.

## Filters

- **All / Memes / Stocks** splits the board by kind. Stocks are the official Robinhood
  stock tokens, which quote in **USDG** rather than WETH.
- **1h / 6h / 24h** changes the window that the change, volume and FEE/TVL columns describe.
  A 1h FEE/TVL is much noisier and much more current than a 24h one.
- **search** matches symbol, name or address.

<figure>
  <div class="frame shot"><img src="/docs/img/ui-tokens-stocks.png" alt="The Tokens board filtered to Stocks, showing NVDA, SPCX, GME, TSLA, RDDT, RBLX, AAPL and MSFT, most quoted in USDG, each with a green verified badge." /></div>
  <figcaption>The Stocks filter. These come from the official stock-token registry, which is
  why they carry a badge — it means the token is the registry's, not that the trade is
  safe.</figcaption>
</figure>

## Safety marks

Two different things happen, and it's worth knowing which is which.

**Tokens flagged as honeypot, can't-sell or ruggable never reach the board at all.** They're
dropped from the listing and refused by the open flow. So are pools whose hook holds permission
to run on liquidity **removal** — a hook that can run on the way out can block or tax your
exit, and no fee is worth that.

**A ⚠ next to the pair** is the softer case: the token is mintable, pausable, has a blacklist
function, or sits behind a proxy. It isn't blocked and it isn't a verdict. Hover it for the
list. It means know what you're LPing.

Neither check is a guarantee. Screeners are wrong in both directions, and token selection is
still the thing that dominates your outcome.

## Getting to the open screen

Click a row, or its **Open** button. Both land on the [open screen](/docs/opening) with the
token and its quote already filled in.

Some rows on this board have **no Friar pool yet**. That's not a problem — opening a position
on a token with no Friar pool creates the pool at market price as part of the same transaction,
and you're its first LP. The open screen tells you which case you're in before you sign.

You aren't limited to this list either. The open screen takes a pasted token address, v4 pool
id, v3 pair address or Dexscreener link, so any safe pool on the chain works — including v4
pools that aren't Friar's.
