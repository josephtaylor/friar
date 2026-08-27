# Friar UI — Design Brief

For the design session. The code is the source of truth (`apps/web/src`); this doc is
the intent, the learned rules, and the gaps. Everything described EXISTS and WORKS
against real money on Robinhood Chain unless marked *future*.

## What this is

A trader's terminal for dynamic-fee concentrated liquidity ("Positions" made of
"bins") on Robinhood Chain. Users open bin-ladder positions on memecoin pools, watch
them fill in real time, and close/zap out. The protocol takes a 5% performance fee on
fees earned. Open to anyone: no allowlist, no signup, no deposit cap.

**The user**: Meteora/DLMM LPs and memecoin traders. They live in charts, think in
percentages, and distrust pretty dashboards that hide mechanics. Vocabulary is
Meteora-native: Position, bins, Spot/Curve/Bid-Ask, claim/withdraw/close.

## Non-negotiable principles (each one was earned this session)

1. **Percentages first.** Traders judge in rates; absolutes are fine print. Tiles lead
   with signed colored % (vs invested capital), raw WETH beneath, small and dim.
2. **Trader units everywhere.** "46% drop to breach down · 9% pump to breach up," never
   raw ticks as the headline. Ranges are specified as % below/above current price.
3. **Market truth over pool truth.** A breached pool's own tick pins at the range edge
   and lies. All verdicts (in-range, breach distances, marks) judge against the
   reference market price; the pool tick is shown but labeled "(pinned)" when it
   diverges. This lesson cost real money once — the UI must never un-learn it.
4. **Not a marketing page.** No fee promos inside flows. The 5% perf fee appears in
   labels ("fees earned (net of 10%)") — stated, never sold.
5. **One button per intent; steppers for multi-tx.** Any flow needing multiple
   transactions opens a modal stepper that narrates each step ("approve WETH — allow
   the router to spend the wing budget"), auto-submits to the wallet as the previous
   step mines, and offers retry-from-failed-step. Wallets that support atomic batching
   (EIP-5792) get a single-confirmation button instead — detect, don't assume.
6. **Errors verbatim.** Surface the real revert/reason. No "something went wrong."
7. **Live means live.** Detail view polls chain price every 3s; positions appear in
   the list seconds after the open confirms (eager ingest). Never show a deposit as a
   loss while awaiting a first mark — show "marking…" placeholders instead.
8. **Severity semantics**: above-range = sold out = benign (gold/warn); below-range =
   bids all filled = danger (red). Green = fees/gains, red = losses, gold = accent/
   quote-side, dim for secondary.

## Screens (current inventory)

### Gate (allowlist beta)
Anonymous: brand + "Connect a wallet to enter" + one button per detected wallet
(EIP-6963 — never a single hijackable button). Connected-but-unlisted: "This wallet
isn't on the beta list" + their address. Nothing else renders, ever.

### Dashboard (`Dashboard.tsx`)
Portfolio stat tiles (value, open PnL, fees net, open count), portfolio value
sparkline (SVG), open positions as cards (id, token, PnL % + fees/inv/val row),
closed positions under "history". Card gap: token shows as truncated address —
needs symbol. `?address=0x…` renders any wallet's book read-only (post-gate).

### Position detail (`PositionDetail.tsx`) — the core screen
Top to bottom:
- **Token banner**: symbol / quote, full token address (click-to-select).
- Meta line: full pool id, manager ↗ (Blockscout), dexscreener links (exact pool if
  indexed there + deepest token chart — resolved via their API, direct pair URLs).
- **Four tiles**: net PnL, fees (net of 10%), inventory delta, current value — % first.
- **LIVE line**: pool tick (+"(pinned) · market tick N" when diverged), then either
  breach-distance summary or colored ABOVE/BELOW-range verdict.
- **BinChart** (`BinChart.tsx`): THE visual. Value-per-bin histogram, X = price in
  user orientation (cheap left), Y = quote value, colored by composition (gold =
  quote waiting, green = token held, white = active bin), red ▼ line at current
  market price, %-from-price labels at edges. Traders instantly see their shape and
  where price sits in it.
- **Actions** (owner-gated): claim fees · close (keep tokens) · close & zap to quote.
  Close&zap picks the deepest v4 venue (never the pool being closed) or falls back to
  a guided stepper (close → approve → v3 swap) for v3-only tokens.
- Bins table, activity log (event name + time + explorer tx link).

### Open position (`OpenPosition.tsx`)
Token address input → resolves symbol/decimals + pool state live ("pool live at tick
N (fee X%)" or "no Friar pool yet — this open will CREATE it at market price").
Inputs: shape (Spot/Curve/Bid-Ask), % below, % above, deposit mode (zap-from-WETH
with wing % | both tokens), amounts. Live preview: BinChart of the planned shape,
bin counts, max-pay caps. Balance pre-flight ("you hold X WETH but plan needs Y —
wrap ETH first"). Submit: single-confirmation batch where supported, else stepper.
v3-only tokens get the batched (or guided) pre-swap wing purchase automatically.

### TxStepper (modal, in `OpenPosition.tsx`)
Step list with status glyphs (○ ◐ ◑ ● ✕), per-step one-line explanations, auto-
advance on receipt, retry-from-failure, cancel.

## Future (design should leave room)

- **Main price chart = TradingView Advanced Charts** (license application pending):
  candles from our own API, full indicator suite (RSI/VPVR/etc.), range selection via
  TV's native drawing tools. BinChart stays as the position-shape view; lightweight
  SVG sparklines stay for dashboard mini-charts. TV attribution required.
- Pool board / scanner page: hot tokens ranked with incumbent-fee-tier verdicts
  ("🎯 undercut the 1%").
- Dust sweeper (one-click sell wallet leftovers to WETH via stepper).
- USDG as selectable quote (dollar-denominated positions — accounting already
  prioritizes USDG > WETH).
- Recipes (saved shape presets), position permalinks, mobile pass.

## Known warts for the redesign

Cards lack token symbols; empty/loading states are bare text; no mobile layout; the
aesthetic is "workbench" (functional dark terminal, gold accent, monospace) — keep
the *soul* (terminal honesty, density, %-first) even if every pixel changes; ▼ marker
and chart styling are minimal SVG; no toasts/notifications system; activity log is
unstyled; no USD display anywhere (deliberate so far — WETH-denominated; revisit).

## Hard constraints

- Data: REST from `apps/api` (positions/summaries/candles) + live chain reads via
  viem (3s slot0 polls). All bigint-as-string; format client-side.
- Wallet flows: wagmi v2; EIP-6963 connector discovery; EIP-5792 batch detection
  with sequential fallback. Chain 4663 auto-add config ships in `@friar/chain`.
- Quote orientation: WETH (or USDG) can be currency0 OR currency1 — user-price can
  run INVERSE to ticks. All chart/range/status code must respect `quoteIs0`. This
  produced four bugs in one day. Respect it.
- TradingView attribution once charts land.
