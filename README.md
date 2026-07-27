# Friar

**Friar** (`src/Friar.sol`) is a **DLMM** — Dynamic Liquidity Market Maker — built as a
Uniswap v4 dynamic-fee hook for Robinhood Chain: the Liquidity Book volatility-accumulator
fee model (LFJ `joe-v2`, MIT — LFJ calls Liquidity Book a DLMM too; it's the same
mechanism behind Meteora's DLMM fees) on standard v4 pools. Low base fee in calm markets,
surging fee during volatility, decaying back after. Fee-override permission bits only:
no custody, no owner, no upgradeability, no protocol fee.

The base fee is a **pool** choice, not a hook constant: `base = baseFactor × tickSpacing`,
so one deployed hook serves 0.30%/0.50%/0.80%/1.00% pools depending on the spacing chosen
at `initialize()`. See `docs/SPEC.md`.

See `docs/SPEC.md` for the mechanism, deviations from Liquidity Book, and
deployment details.

> Every pool has a Friar; the Friar always eats.

```
src/FriarMath.sol             LB fee math, ported to v4 units
src/Friar.sol                 the hook (afterInitialize + beforeSwap only)
src/FriarPositionManager.sol  multi-bin position manager (atomic open/close/zap, tiered fee)
src/CurrencySettler.sol       vendored from v4-core (kept out of the dep's test tree)
test/                         unit vectors + PoolManager integration tests
test/*Hostile.t.sol           adversarial hooks: unbounded swap-delta venues
test/*Adversarial.t.sol       adversarial currencies + reentrancy pinning
test/*Invariants.t.sol        stateful invariants over arbitrary verb sequences
script/DeployFriar.s.sol      CREATE2/HookMiner deployment
```

## Setup

Dependencies are gitignored. Install them **at their pinned commits** — the script is the
source of truth, so a rebuild here maps to exactly one bytecode:

```bash
./scripts/install-deps.sh
forge test
```

| Dependency | Commit |
|---|---|
| `Uniswap/v4-periphery` | `3245c3cb99c48fa1dc2459c3b60abc37d4294aba` |
| `Uniswap/v4-core` | `59d3ecf53afa9264a16bba0e38f4c5d2231f80bc` |
| `Uniswap/permit2` | `cc56ad0f3439c502c246fc5cfcc3db92bb8b7219` |
| `transmissions11/solmate` | `4b47a19038b798b4a33d9749d25e570443520647` |
| `foundry-rs/forge-std` | `5cf980eefbf8a54050628334163127ed35453558` |

Build settings are pinned in `foundry.toml`: solc **0.8.26**, evm **cancun**, optimizer on
at **800 runs**.

## Security model

The hook is fixed-behavior and has no custody. `FriarPositionManager` is **permissionless
in its pools**: anyone may call it directly with any `PoolKey`, so the app's screening is
not a contract-level guarantee. Concretely:

- **Friar pools** — known hook, fixed fee mechanism, no liquidity-side callbacks.
- **Bring-your-own pool** — the caller assumes the hook and token risk. The manager
  guarantees *ownership and accounting*: only the owner can move a position, payouts go
  only to the owner, principal is never charged a fee, and every verb is bounded by
  caller-supplied `maxPay0/1` (entry **and** exit) and `minReceive0/1`. It does **not**
  guarantee the safety or behavior of an externally supplied pool, hook, or currency.

The pay caps on the exit verbs are load-bearing, not decorative: a zap venue whose hook
returns an unbounded swap delta can otherwise make an exit settle a debt from the owner's
wallet. See `test/FriarPositionManagerHostile.t.sol`.

## Deployments — Robinhood Chain (4663)

| Instance | Address | Parameters |
|---|---|---|
| Friar (standard) | `0xFeDa24F0d3805170E7566cE617CfBa01cE05D080` | baseFactor 5000, filter 10, decay 600, reduction 5000, vfc 40000, maxVolAcc 350000 |
| Friar (calm) | `0x5E6b0bbc811705b8d8234e9914c0507243fB1080` | same, vfc 20000 |
| FriarPositionManager | `0x49a1e3A9Ff7b11c007914dB386518e78DE60c5DC` | perfFee 10% shaped / 1% simple (both immutable), in-kind at collection; ids from 11 |

Deployed 2026-07-27 at block 20714167 (tx
`0xd1f345234b70468b6d3b08f85fd4b69bd8188e7e7a4c07f525251935d23eeb80`).

Retired managers stay live and exitable — they simply stop accepting new opens. Position
ids are one global namespace across deployments (`startingPositionId` continues above the
previous high-water mark), so an id identifies exactly one manager:

| Retired | ids | why |
|---|---|---|
| `0xD3EE78a76C4C660EC3d25244855A8423a37Db110` | 1–15 (all closed) | pre-tiered-fee |
| `0x0e9064622c6AD90d9ADfFcd1E203df52cC870cb3` | 1–10 | no `maxPay` on exits; multi-bin positions bricked once a bin emptied |

## License

MIT — fee mechanism ported from [Liquidity Book](https://github.com/lfj-gg/joe-v2) (MIT).
