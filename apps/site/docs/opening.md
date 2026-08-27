# Opening a position

The open screen is one form. Chart on the left for price context, controls on the right, and a
bin preview in the middle of them that redraws as you type. Nothing is committed until you sign
— you can sit on this screen with no wallet connected and watch the shape change.

<figure>
  <div class="frame shot narrow"><img src="/docs/img/ui-open-form.png" alt="The full Friar open-position panel: a token/pool field, a WETH/USDG quote toggle, a live bin preview, Shaped/Simple and Spot/Curve/Bid-Ask selectors, percent below and above inputs with presets, a deposit toggle, amount fields, balance and gas checks, a summary block, and an Open position button." /></div>
  <figcaption>The whole panel, top to bottom. The rest of this page walks down it.</figcaption>
</figure>

## 1. Pick the pool

<figure>
  <div class="frame shot narrow"><img src="/docs/img/ui-open-pool.png" alt="The top of the open form: a TOKEN / POOL field holding a pasted contract address, a line underneath confirming the resolved token, its decimals, and that a Friar pool is live, and a market stats box with 24h volume, liquidity, market cap, 24h change, fee/TVL and the incumbent venue's fee." /></div>
  <figcaption>Paste anything that identifies the pair; the lines underneath tell you what it
  resolved to and how the token is trading right now.</figcaption>
</figure>

The top field takes a **token address, a v4 pool id, a v3 pair address, or a Dexscreener
link** and resolves it. Arriving from the Tokens board fills it for you.

**Quote** picks the other side of the pair, WETH or USDG. Stock tokens are USDG-quoted; almost
everything else is WETH. If you pasted a specific pool, the quote is whatever that pool uses
and the toggle disappears.

**Pool.** Once the pair is set, a dropdown lists every Friar pool that already exists for it,
each labelled by its fee tier and bin width, deepest first. Pick one to **join** it — you're
adding liquidity to a pool that's already there. The default is the deepest, which is usually
where you want to be, since depth is what routes flow. The last option is **Create a new
pool**, for when you want a fee or width that doesn't exist yet.

<figure>
  <div class="frame shot narrow"><img src="/docs/img/ui-open-join.png" alt="The POOL dropdown showing an existing pool selected, labelled 1% base and 1.0% bins, with a note underneath: joining an existing pool, pick Create a new pool to open a different fee tier or width." /></div>
  <figcaption>Joining. The dropdown names each existing pool by what it charges and how
  finely it's binned.</figcaption>
</figure>

Choosing *Create a new pool* reveals two more controls:

<figure>
  <div class="frame shot narrow"><img src="/docs/img/ui-open-create.png" alt="The POOL dropdown set to Create a new pool, revealing a FEE TIER picker showing 1% base fee and a BIN WIDTH picker showing 1.0% bins, with a note: new pool, you'll be the first LP; fee tier is the base fee; each fee tier and bin width is its own pool." /></div>
  <figcaption>Creating. Fee tier and bin width together name exactly one pool, and you'll be
  its first LP.</figcaption>
</figure>

- **Fee tier** — the pool's base fee: 0.3%, 0.8%, 1%, 2%, or 5%. Each is a separate,
  immutable pool, so this is what your pool *is*, not a setting you can change later. Higher
  tiers earn more per trade but see less flow; volatile launches often run high.
- **Bin width** — how finely liquidity is placed, from tight (0.5%) to wide (3.3%). Tighter
  concentrates more but needs a narrower range; wider covers more ground.

Fee tier and bin width are independent — any fee at any width is its own pool — so the two
together name exactly one pool. You'll be its first LP, and creating it is bundled into the
same transaction as your position.

> Two things get refused outright: tokens the safety checkers flag as honeypot, can't-sell or
> ruggable, and pools whose hook has permission to run on liquidity **removal** — a hook that
> can run on your way out can block or tax the exit.

## 2. Shaped or Simple

<figure>
  <div class="frame shot"><img src="/docs/img/ui-simple.png" alt="The Simple option selected, showing one solid block of liquidity spanning the whole range instead of individual bins." /></div>
  <figcaption>Simple is one Uniswap range, drawn flat across the whole span. One bin, one
  position.</figcaption>
</figure>

- **Shaped** cuts the range into bins and distributes liquidity across them according to a
  shape. This is the DLMM behaviour.
- **Simple** is a single Uniswap range — no bins, no shape, flat across your span.

Both are priced the same — a flat 5% of fees earned — so the choice is about behaviour, not
cost. [What Friar charges](/docs/costs) has the detail.

## 3. Shape

Shaped positions pick one of three distributions. Each answers "where in the range do I want my
liquidity concentrated".

<figure>
  <div class="frame shot"><img src="/docs/img/ui-shape-spot.png" alt="Spot shape preview: every bin the same height, an even block of liquidity across the range." /></div>
  <figcaption><b>Spot</b> — flat. Every bin gets the same liquidity. The neutral choice, and
  the one that behaves most like an ordinary concentrated range.</figcaption>
</figure>

<figure>
  <div class="frame shot"><img src="/docs/img/ui-shape-curve.png" alt="Curve shape preview: bins tallest next to the current price and tapering away in both directions." /></div>
  <figcaption><b>Curve</b> — concentrated at the middle. Most of the capital sits next to the
  current price, where the volume is. Earns hardest while price stays put, converts fastest
  when it doesn't.</figcaption>
</figure>

<figure>
  <div class="frame shot"><img src="/docs/img/ui-shape-bidask.png" alt="Bid-Ask shape preview: bins tallest at both far edges of the range and thinnest in the middle." /></div>
  <figcaption><b>Bid-Ask</b> — concentrated at the edges. Buys hardest at the bottom, sells
  hardest at the top, does least in the middle. The mean-reversion shape.</figcaption>
</figure>

[Positions, bins and shapes](/docs/shapes) covers what these are underneath.

## 4. Range

**% below** and **% above** set the span, as percentages of the current price. They aren't
symmetric by default and they don't need to be:

- **Below is bids** — quote token, waiting to buy on the way down.
- **Above is asks** — the token itself, waiting to sell on the way up.

<figure>
  <div class="frame shot"><img src="/docs/img/ui-open-preview.png" alt="A bin preview chart showing orange WETH bid bins to the left of the current price, a pale active bin, and green token ask bins to the right, with the range marked minus 31 percent to plus 12 percent." /></div>
  <figcaption>The preview redraws as you type. Orange is quote waiting to buy, green is token
  waiting to sell, and pale is the bin the price is sitting in right now.</figcaption>
</figure>

A one-sided range only needs one token. `50 / 0` is a pure bid ladder that never needs you to
hold the token at all, which makes it the cheapest thing to open — no swap leg, nothing to
route.

The preset pills below the inputs are shortcuts: `±5%`, `±10%`, `30 / 10`, `wide` (±50%), and
`binchicken` (40 below, 8 above, Bid-Ask). Bins are capped at **100** — wider ranges spend that
budget on span rather than granularity.

> If your range is far from where the market actually is, the app says so rather than letting
> you anchor a fresh position at a stale price. On a pool nothing has traded in a while, that's
> a real hazard — and if the pool is one of ours, the open will offer to slide it to market
> first and show you the cost before you commit.

## 5. Deposit

**Zap from WETH** takes one token and buys whatever the ask side needs inside the transaction.
**Both tokens** takes exactly what you supply, and swaps nothing.

With a zap, **wing % → asks** controls how much of your deposit gets converted to the token for
the upper bins. Leave it alone if you don't have a view; it's sized to your range by default.
With **Simple**, the token side is computed for you and there's nothing to set.

Then the amount. Three checks run underneath it and all three have to pass:

- your **quote balance** — including "will wrap N ETH first ✓" when you're short WETH but long
  ETH
- your **token balance**, when you're supplying both sides
- your **gas** — ETH on chain 4663, which a wallet that arrived holding only WETH won't have

The submit button reports these directly rather than letting you reach a wallet prompt you can
only reject. *"Open position: no ETH for gas"* is a disabled button, not a failure.

## 6. Read the summary

<figure>
  <div class="frame shot"><img src="/docs/img/ui-open-summary.png" alt="The open summary: bins 36 bid / 10 ask, pays at most 0.1010 WETH, wing swap in-tx 0.0080 WETH min-out guarded, dynamic fee now 0.00%, and a note that the 5% fee applies to fees earned, charged on-chain at collection, and principal is never touched." /></div>
  <figcaption>The last thing before you sign. "Pays at most" is a real cap enforced
  on-chain.</figcaption>
</figure>

| Row | What it means |
|---|---|
| **bins** | how the shape came out — `23 bid / 6 ask`, or `single range (1 bin)` for Simple |
| **pays at most** | the ceiling on what leaves your wallet. Enforced by the contract, not a display |
| **wing swap in-tx** | the zap leg, if there is one, with a min-out guard on it |
| **dynamic fee now** | what the pool is charging swappers *at this moment*. It moves — see [how the fee is set](/docs/fees) |

Below it, the fee disclosure: 5% of fees earned, charged on-chain at collection, principal
never touched.

## 7. Sign

What you sign depends on your wallet.

- **Wallets that support atomic batching (EIP-5792)** get one signature for the whole thing:
  wrap if needed, approvals, the swap leg, and the mint.
- **Everything else** gets a guided stepper — one narrated transaction at a time, each with a
  label saying what it's for, and a retry on the step that failed rather than a restart.

The note under the button tells you which one you're getting before you press it.

Two approvals are worth knowing about. The allowance to the **Friar manager is capped** at what
the position needs, not unlimited. The allowance to **Uniswap's SwapRouter02**, used for zaps,
is unlimited and persists after you close, because re-approving on every open is worse. That's
Uniswap's own router rather than ours, and you can revoke it whenever you like.

## After it lands

The position page opens as soon as the transaction confirms. It reads the chain directly, so it
shows up immediately even if the indexer hasn't caught the event yet, and the history fills in
behind it.

Next: [your position page](/docs/guide-position).
