# Getting started

Everything you need before you open anything, and a tour of the four screens the app has.

## What you need

- **A wallet on Robinhood Chain**, chain id 4663. Any EVM wallet works. The app will offer to
  add or switch the network for you.
- **ETH for gas.** Cents, but you need some, and it has to be ETH *on chain 4663* — a wallet
  that arrived holding only WETH can't pay for the approve.
- **The quote token, or ETH to wrap into it.** Most pools are quoted in WETH; the stock tokens
  are quoted in USDG. If you hold native ETH and the pool wants WETH, the app wraps it as part
  of the flow. You don't need to go and do that somewhere else first.

There's no allowlist, no signup, and no deposit cap. Connect and go.

## Connecting

<figure>
  <div class="frame shot"><img src="/docs/img/ui-connect.png" alt="The Friar top bar with a connect button on the right, and a screen reading 'connect a wallet to see your history' above a Connect wallet button." /></div>
  <figcaption>Walletless visitors land on Tokens, which is fully browsable. Positions and
  History need a wallet, because they're keyed to your address.</figcaption>
</figure>

You can look around the whole app without connecting — the Tokens board and the entire open
screen, including the live bin preview, work with no wallet attached. Only the submit button
and your own book need one.

## The screens

<figure>
  <div class="frame shot"><img src="/docs/img/ui-nav.png" alt="The Friar top bar: the FRIAR wordmark, then Tokens, Positions and History tabs, then a Discord link, an ETH/USD denomination toggle, an Open position button, and the connected wallet chip." /></div>
  <figcaption>The top bar is the whole navigation. It's the same on every screen.</figcaption>
</figure>

| | |
|---|---|
| **[Tokens](/docs/guide-tokens)** | what's trading on the chain, and where the fees are. Where you go to find something to LP |
| **[Positions](/docs/guide-history)** | your open positions, with portfolio value and the PnL split across all of them |
| **[History](/docs/guide-history)** | closed positions, realized PnL frozen at close, and a CSV export |
| **+ Open position** | the [creation screen](/docs/opening). Also reachable by clicking any row on the Tokens board |

Two controls sit next to them and are easy to miss:

- **Ξ / $** switches every number in the app between ETH and USD. It's purely a display
  choice — the pools quote in WETH either way, and the USD view is that number times a rate.
  Your choice is remembered.
- **Discord** is the community. Come and join it — ask questions, see what other people are
  LPing, and tell us what the app should do next.

## Viewing without connecting

Every read in the app is keyed by address and served from a public ledger, so any book can be
opened read-only by putting the address in the URL:

```
https://app.friar.fi/?address=0xYourAddressHere
```

That works for the dashboard, the history, and individual positions. It's how you'd share a
position with someone, or check a book from a device you'd rather not connect a wallet on.
It's read-only in the real sense — the action buttons don't render, because signing needs the
owner's wallet.

## Before you put money in

The manager contract **hasn't been audited**, and it's immutable — there's no pause and no
rescue if there's a bug in it. That cuts both ways: nobody can rug you with an admin key, and
nobody can save you either. [Where your money sits](/docs/anatomy) is the page that walks
through exactly what each contract can and can't do, and how to verify it on the explorer.

Then start with [the Tokens board](/docs/guide-tokens).
