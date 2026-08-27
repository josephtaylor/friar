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
///   FILTER_PERIOD 10, i.e. LB's own value, and the app should not vary it. The failure
///     directions are asymmetric: too short only means the surge never fires, too long
///     means references stop refreshing, the accumulator ratchets, and the fee pins high
///     enough to starve routing. Regime drift runs thin -> routed, INTO the severe
///     direction, and a frozen config cannot be corrected without a new pool — which for
///     a venue competing on depth means splitting the depth, so it is not a real option.
///     Lengthen only for a pool with positive reason to stay sparse.
///
///   MAX_VOLATILITY_TICKS 7000. The surge saturates at 7000 ticks of price displacement
///     regardless of bin width. Ticks are logarithmic, so that is roughly +101% up and
///     -50% down, NOT a symmetric 70%. LB expresses this ceiling in bin units, which
///     silently makes it fire 20x sooner on 10-tick bins than on 200-tick ones. Meteora
///     migrants run bin step 100-150, so spacing-invariance is load-bearing here. Below
///     about 5-tick spacing the uint24 accumulator clamps and invariance stops holding.
contract DeployFriarV2 is Script {
    address constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    // Uniswap v4 PoolManager on Robinhood Chain (4663):
    // https://developers.uniswap.org/contracts/v4/deployments
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;

    function run() external {
        FriarV2.PoolConfig memory cfg = FriarV2.PoolConfig({
            baseFeePips: uint24(vm.envOr("BASE_FEE_PIPS", uint256(9000))),
            filterPeriod: uint16(vm.envOr("FILTER_PERIOD", uint256(10))),
            decayPeriod: uint16(vm.envOr("DECAY_PERIOD", uint256(600))),
            reductionFactor: uint16(vm.envOr("REDUCTION_FACTOR", uint256(5000))),
            variableFeeControl: uint24(vm.envOr("VARIABLE_FEE_CONTROL", uint256(40_000))),
            maxVolatilityTicks: uint24(vm.envOr("MAX_VOLATILITY_TICKS", uint256(7000))),
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
        console2.log("  filterPeriod:", cfg.filterPeriod);
        console2.log("  decayPeriod:", cfg.decayPeriod);
        console2.log("  reductionFactor:", cfg.reductionFactor);
        console2.log("  variableFeeControl:", cfg.variableFeeControl);
        console2.log("  maxVolatilityTicks:", cfg.maxVolatilityTicks);
    }
}
