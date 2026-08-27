#!/usr/bin/env bash
# Reproducible dependency install.
#
# Dependencies are gitignored rather than vendored or submoduled, so the exact commits
# live here. Cloning HEAD instead would mean the source in this repo no longer maps to a
# single, checkable bytecode — pinning is what lets anyone rebuild the deployed artifact
# and compare it against the verified source on the explorer.
#
# Usage: ./scripts/install-deps.sh   (from the repo root)
set -euo pipefail

V4_PERIPHERY=3245c3cb99c48fa1dc2459c3b60abc37d4294aba
V4_CORE=59d3ecf53afa9264a16bba0e38f4c5d2231f80bc
PERMIT2=cc56ad0f3439c502c246fc5cfcc3db92bb8b7219
SOLMATE=4b47a19038b798b4a33d9749d25e570443520647
FORGE_STD=5cf980eefbf8a54050628334163127ed35453558

pin() { # <dir> <url> <commit>
  local dir=$1 url=$2 commit=$3
  if [ ! -d "$dir/.git" ]; then
    rm -rf "$dir"
    git init -q "$dir"
    git -C "$dir" remote add origin "$url"
  fi
  git -C "$dir" fetch -q --depth 1 origin "$commit"
  git -C "$dir" checkout -q "$commit"
  echo "  $dir @ $commit"
}

echo "pinning dependencies:"
pin lib/forge-std            https://github.com/foundry-rs/forge-std "$FORGE_STD"
pin lib/v4-periphery         https://github.com/Uniswap/v4-periphery "$V4_PERIPHERY"
pin lib/v4-periphery/lib/v4-core   https://github.com/Uniswap/v4-core "$V4_CORE"
pin lib/v4-periphery/lib/permit2   https://github.com/Uniswap/permit2 "$PERMIT2"
pin lib/v4-periphery/lib/v4-core/lib/solmate https://github.com/transmissions11/solmate "$SOLMATE"

echo
echo "done. build settings are pinned in foundry.toml (solc 0.8.26, cancun, optimizer 800 runs)."
echo "verify a deployment with:  forge build && forge verify-bytecode <address> <Contract>"
