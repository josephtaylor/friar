// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {HookMiner} from "v4-periphery/test/shared/HookMiner.sol";

import {FriarV2} from "../src/FriarV2.sol";

/// @notice Mines a hook address (AFTER_INITIALIZE | BEFORE_SWAP — same two bits as v1, so
/// mining difficulty is unchanged) and deploys FriarV2 via the canonical CREATE2 deployer.
/// Verify the source on the explorer immediately after: the hooklist analyzer reads
/// verified source, and the whole trust claim rests on the permission bits being visible.
///
/// Usage — note `--sender` is REQUIRED. Without it Foundry substitutes its default sender
/// and any msg.sender-derived value is silently wrong, while the script still prints a
/// plausible address. Verify with `cast codesize` afterwards, never the printed address.
///
///   forge script script/DeployFriarV2.s.sol --rpc-url robinhood --broadcast \
///     --account tuck-deployer --sender 0xEA41b6d65d74742CbF52c29e200e5aE9fAe73058
///
/// DEFAULTS, and why they are what they are (measured 2026-07-30, see
/// notes/harness/gauntlet.mjs — every number here is replayable against real 4663 flow):
///
///   BASE_FEE_PIPS 9000 (0.90%). The bar a pool must clear is "more LP fee revenue than a
///     static 1% pool, or nobody uses it". The surge adds a base-independent ~12bps on
///     routed flow, so break-even against static 1% is a 0.878% base; 0.90% clears it with
///     a little room, and clears it comfortably on thin pools where the surge contributes
///     ~37bps instead. A lower base wins more routing but fails the revenue bar, which is
///     the wrong trade for a pool nobody has joined yet.
///
///   FILTER_FLOOR 10 == MIN_FILTER_FLOOR. This is a safety property, not a preference:
///     with a lower floor, whole-second timestamps on dense (3.7s-gap) flow let the EWMA
///     collapse, every swap re-anchors, and revenue HALVES versus LB's constant. At the
///     floor the hook degenerates to exactly v1 behaviour on dense flow.
///
///   FILTER_CEIL 300 / WINDOW_K 3. Window = clamp(3 x EWMA(gap), 10s, 300s). Grinding the
///     fee back to base takes 27x longer than against the constant on thin pools, and
///     pinning the fee HIGH costs an attacker more per hour than the pool's entire
///     turnover, so neither direction is economic.
///
///   MAX_VOLATILITY_BPS 7000. The surge saturates at a 70% price move REGARDLESS of bin
///     width. LB expresses this ceiling in bin units, which silently makes it 70% on
///     200-tick bins but 3.5% on 10-tick bins. Meteora migrants run bin step 100-150, so
///     spacing-invariance here is load-bearing, not cosmetic.
contract DeployFriarV2 is Script {
    address constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    // Uniswap v4 PoolManager on Robinhood Chain (4663):
    // https://developers.uniswap.org/contracts/v4/deployments
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;

    function run() external {
        FriarV2.PoolConfig memory cfg = FriarV2.PoolConfig({
            baseFeePips: uint24(vm.envOr("BASE_FEE_PIPS", uint256(9000))),
            filterFloor: uint16(vm.envOr("FILTER_FLOOR", uint256(10))),
            filterCeil: uint16(vm.envOr("FILTER_CEIL", uint256(300))),
            windowK: uint8(vm.envOr("WINDOW_K", uint256(3))),
            decayPeriod: uint16(vm.envOr("DECAY_PERIOD", uint256(600))),
            reductionFactor: uint16(vm.envOr("REDUCTION_FACTOR", uint256(5000))),
            variableFeeControl: uint24(vm.envOr("VARIABLE_FEE_CONTROL", uint256(40_000))),
            maxVolatilityBps: uint24(vm.envOr("MAX_VOLATILITY_BPS", uint256(7000))),
            locked: false
        });

        bytes memory constructorArgs = abi.encode(IPoolManager(POOL_MANAGER), cfg);

        uint160 flags = uint160(Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG);
        (address hookAddress, bytes32 salt) =
            HookMiner.find(CREATE2_DEPLOYER, flags, type(FriarV2).creationCode, constructorArgs);

        console2.log("Mined FriarV2 address:", hookAddress);
        console2.log("Salt:");
        console2.logBytes32(salt);

        vm.startBroadcast();
        FriarV2 friar = new FriarV2{salt: salt}(IPoolManager(POOL_MANAGER), cfg);
        vm.stopBroadcast();

        require(address(friar) == hookAddress, "address mismatch: CREATE2 deployer differs from miner assumption");

        console2.log("FriarV2 deployed:", address(friar));
        console2.log("  baseFeePips:", cfg.baseFeePips);
        console2.log("  filterFloor / ceil:", cfg.filterFloor, cfg.filterCeil);
        console2.log("  windowK:", cfg.windowK);
        console2.log("  decayPeriod:", cfg.decayPeriod);
        console2.log("  reductionFactor:", cfg.reductionFactor);
        console2.log("  variableFeeControl:", cfg.variableFeeControl);
        console2.log("  maxVolatilityBps:", cfg.maxVolatilityBps);
    }
}
