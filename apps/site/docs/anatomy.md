# Where your money sits

Two contracts. Every function either one exposes is listed below, and all of it is readable on
the explorer.

> **The position manager isn't audited**, and it's immutable — no pause, no upgrade, no
> rescue. The same immutability means no admin key can take your funds either.

## The shape of it

Friar is two contracts, the manager and the hook. Opening a position calls the manager, which
calls Uniswap's PoolManager, and that's the one holding your money. The hook isn't in that
path at all. It only runs when somebody swaps.

<figure>
  <div class="frame"><img src="/docs/img/anatomy.svg" alt="Diagram: your wallet signs calls to the Friar position manager, which mints liquidity inside Uniswap v4's PoolManager where the funds are held. The hook only sets the dynamic swap fee. The treasury only receives the performance fee and can only waive it." /></div>
  <figcaption>The manager doesn't custody anything. It mints your bins inside Uniswap's
  PoolManager and stores a record of what it minted. When you withdraw, it reads your address
  off that record and sends the funds there.</figcaption>
</figure>

## Who can do what

Each row is enforced by a check in the code, with the revert name in brackets. This is the
full list of roles. There aren't any others.

| Address | Can | Cannot | Worst case if the key is stolen |
|---|---|---|---|
| **You**, the position owner | open, add, remove, collect, close. Only your own positions | touch anyone else's position (`NotPositionOwner`) | your funds, same as any wallet |
| **Treasury**, Friar's revenue address | receive the performance fee, hand the role on in two steps, **waive** the fee for an address | raise a fee, touch principal, move a position, redirect a payout (`NotTreasury`) | **Friar stops getting paid.** The key cannot reach user funds at all |
| **The hook** | set the dynamic swap fee, capped at 10% | hold, move or approve tokens, or run at all while liquidity is being added or removed | nothing. It has no owner and no keys |
| **Friar**, the team | run servers, deploy new contracts you'd have to opt into | everything else. There's no admin function, no pause, no upgrade, no sweep | the app goes offline. Positions keep working |

### What nothing can do

- **No function sends your funds anywhere but to you.** Payout calls don't take a recipient
  argument. The address comes off the position record.
- **No pause, no upgrade, no proxy, no delegatecall.** Both contracts are immutable.
- **The manager holds no idle balance.** Funds go from your wallet into Uniswap and back in
  the same transaction. There's no pot sitting in the middle.
- **The fee rate can't be raised.** The 5% rate is an immutable constructor value, under a
  hard 20% sanity cap.
- **The hook can't run when you deposit or withdraw.** Its permissions have
  `beforeAddLiquidity`, `afterAddLiquidity`, `beforeRemoveLiquidity` and
  `afterRemoveLiquidity` all set to false, which is readable off the hook's address. It only
  fires on `afterInitialize` and `beforeSwap`.
- **The v4 callback can't be called by anyone else.** `unlockCallback` reverts unless
  Uniswap's PoolManager is the caller.
- **Your exit doesn't need our servers.** The whole position, owner and pool and every bin,
  is stored on-chain. The position id is all you need to withdraw.

## The complete external surface

Thirteen functions. Counting the write functions on the explorer gives the same list.

| | |
|---|---|
| `open` `openNew` | mint your bins. `openNew` also creates the pool |
| `increase` `decrease` | add to or withdraw from your bins |
| `close` `collect` | exit fully, or take fees and leave the liquidity |
| `getPosition` `positionsOf` `binSalt` | views. read-only, callable by anyone |
| `unlockCallback` | Uniswap's callback. reverts for any other caller |
| `setTreasury` `acceptTreasury` | two-step handover of the revenue address |
| `setExempt` (on the shared `FeeExemptionRegistry`) | discount only. can waive a fee, never raise one |

All six position functions start with `if (p.owner != msg.sender) revert NotPositionOwner()`.
The treasury functions start with `if (msg.sender != treasury) revert NotTreasury()`, and the
registry's `setExempt` with its own admin check. That's the whole permission system.

## What's still worth worrying about

| Risk | Why it's real | What limits it |
|---|---|---|
| **A bug in the manager** | Not audited, and immutable, so there's no pause and no way to claw anything back. This is the one that could actually cost you money. | The surface is small, the source is public, and an exploit has to come through the same calls everyone else uses. |
| **Token approvals** | Zaps need an unlimited allowance to Uniswap's SwapRouter02, and it stays there after you close. | That's Uniswap's router and it has been audited. The allowance you give the Friar manager has a ceiling on it. You can revoke either one whenever you want. |
| **The token you pick** | Providing liquidity means holding inventory. If the token falls you end up holding more of it, and no fee schedule fixes that. | Nothing limits it. Friar prices the fee and reports the split; token selection is the LP's. |
| **Our servers** | Charts, PnL and history all come from an indexer. If it's down or behind, the numbers you're looking at are stale. | You don't need any of it to move money. Withdrawing reads the chain. |

## Check it yourself

The source is verified on the explorer, so you can read the actual code in the browser.

| | |
|---|---|
| Position manager | [`0xBd76176c5524785452D80c4350f18e3A2040470E`](https://robinhoodchain.blockscout.com/address/0xBd76176c5524785452D80c4350f18e3A2040470E?tab=contract) |
| Friar hook, standard | [`0xFeDa24F0d3805170E7566cE617CfBa01cE05D080`](https://robinhoodchain.blockscout.com/address/0xFeDa24F0d3805170E7566cE617CfBa01cE05D080?tab=contract) |
| Friar hook, calm | [`0x5E6b0bbc811705b8d8234e9914c0507243fB1080`](https://robinhoodchain.blockscout.com/address/0x5E6b0bbc811705b8d8234e9914c0507243fB1080?tab=contract) |
| Uniswap v4 PoolManager | [`0x8366a39CC670B4001A1121B8F6A443A643e40951`](https://robinhoodchain.blockscout.com/address/0x8366a39CC670B4001A1121B8F6A443A643e40951) |
| Source | [github.com/josephtaylor/friar](https://github.com/josephtaylor/friar) |

**What to look for.** Open the manager's contract tab and count the write functions. You
should find six position verbs plus three treasury ones. Search the source for
`NotPositionOwner`, `NotTreasury` and `NotPoolManager` to see the three checks doing the
work. Then search for `selfdestruct`, `delegatecall`, `upgradeTo` and `pause`. None of them
are in there.

Uniswap reviewed the hook before adding it to their official hooklist, which is why their
router quotes these pools.
