// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";

import {FriarPositionManager} from "../src/FriarPositionManager.sol";
import {IFeeExemptionRegistry} from "../src/interfaces/IFeeExemptionRegistry.sol";

/// @notice Deploys the FriarPositionManager. No address mining needed (not a hook).
/// Verify the source on the explorer immediately after deploy.
///
/// Usage ("robinhood" is a named endpoint in foundry.toml):
///   TREASURY=0x1fe8E51635636628415f5dee7bc71A3d7A6cF9BE \
///   forge script script/DeployFriarPositionManager.s.sol --rpc-url robinhood \
///     --broadcast --account tuck-deployer
///
/// Overrides:
///   PERF_FEE_BPS     shaped (multi-bin) fee share in bps (default 500 = 5%, hard cap 2000)
///   SIMPLE_FEE_BPS   simple (single-bin) fee share in bps (default 500 = 5%, hard cap 2000)
///
///   Both default to 500 because the tiering is being retired. Measured over 21 real
///   positions the blended take was 6.0% (44% of the fee base ran through the 1% simple
///   tier), and the tiers showed no yield difference once controlled for time — so
///   charging 10x more for one of them was not defensible, and the split mostly taught
///   users to optimise `bins.length` against us. Flat 5% is roughly revenue-neutral
///   against the measured blend, sits under SectorOne's measured ~8%, and matches the 5%
///   Ramses advertises.
///   TREASURY     fee recipient        (default: the broadcasting sender)
///   FEE_EXEMPTION_REGISTRY  REQUIRED. The shared FeeExemptionRegistry every manager
///     generation reads. Deploy it once (script/DeployFeeExemptionRegistry.s.sol) and
///     reuse the address forever: the whole point is that the exemption list stops dying
///     with each manager. There is no default, because silently deploying a manager
///     pointed at the wrong list is exactly the drift this replaced.
///   STARTING_POSITION_ID  first id this deployment mints (default 1). On a REDEPLOY set
///     this above the previous manager's highest id — off-chain history is keyed by id,
///     so restarting at 1 would collide with and clobber the old records. The live
///     manager's `nextPositionId()` was 23 on 2026-07-30; use 101 so the generation is
///     obvious at a glance AND so a straggler open against the retired manager cannot
///     collide with an id this one has already minted.
contract DeployFriarPositionManager is Script {
    // Uniswap v4 PoolManager on Robinhood Chain (4663):
    // https://developers.uniswap.org/contracts/v4/deployments
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;

    function run() external {
        uint16 perfFeeBps = uint16(vm.envOr("PERF_FEE_BPS", uint256(500)));
        uint16 simpleFeeBps = uint16(vm.envOr("SIMPLE_FEE_BPS", uint256(500)));
        uint256 startingPositionId = vm.envOr("STARTING_POSITION_ID", uint256(1));

        vm.startBroadcast();
        address sender = msg.sender;
        address treasury = vm.envOr("TREASURY", sender);
        address registry = vm.envAddress("FEE_EXEMPTION_REGISTRY");

        FriarPositionManager fpm = new FriarPositionManager(
            IPoolManager(POOL_MANAGER),
            perfFeeBps,
            simpleFeeBps,
            treasury,
            IFeeExemptionRegistry(registry),
            startingPositionId
        );
        vm.stopBroadcast();

        console2.log("FriarPositionManager deployed:", address(fpm));
        console2.log("  perfFeeBps:", perfFeeBps);
        console2.log("  simpleFeeBps:", simpleFeeBps);
        console2.log("  treasury:", treasury);
        console2.log("  feeExemptionRegistry:", registry);
        console2.log("  startingPositionId:", startingPositionId);
    }
}
