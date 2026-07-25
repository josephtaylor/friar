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
src/FriarPositionManager.sol  multi-bin position manager (atomic open/close/zap, 10% perf fee)
test/                         unit vectors + PoolManager integration tests
script/DeployFriar.s.sol      CREATE2/HookMiner deployment
```

## Setup

Dependencies are gitignored; clone them into `lib/`:

```bash
git clone --depth 1 --recursive --shallow-submodules \
  https://github.com/Uniswap/v4-periphery lib/v4-periphery
git clone --depth 1 https://github.com/foundry-rs/forge-std lib/forge-std
forge test
```

## Deployments — Robinhood Chain (4663)

| Instance | Address | Parameters |
|---|---|---|
| Friar (standard) | `0xFeDa24F0d3805170E7566cE617CfBa01cE05D080` | baseFactor 5000, filter 10, decay 600, reduction 5000, vfc 40000, maxVolAcc 350000 |
| Friar (calm) | `0x5E6b0bbc811705b8d8234e9914c0507243fB1080` | same, vfc 20000 |
| FriarPositionManager | `0xD3EE78a76C4C660EC3d25244855A8423a37Db110` | perfFee 10% (immutable), in-kind at collection |

## License

MIT — fee mechanism ported from [Liquidity Book](https://github.com/lfj-gg/joe-v2) (MIT).
