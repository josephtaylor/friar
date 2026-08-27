// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {FeeExemptionRegistry} from "../src/FeeExemptionRegistry.sol";

/// @notice Deploys the shared fee-exemption registry. DEPLOY THIS ONCE. Every subsequent
/// FriarPositionManager takes the resulting address as an immutable constructor argument,
/// which is the entire point: the exemption list stops dying with each manager.
///
/// Usage (--sender is required; without it msg.sender inside the script is Foundry's
/// default and the admin would be silently wrong):
///
///   forge script script/DeployFeeExemptionRegistry.s.sol --rpc-url robinhood --broadcast \
///     --account tuck-deployer --sender 0xEA41b6d65d74742CbF52c29e200e5aE9fAe73058
///
/// ADMIN defaults to the broadcasting sender. The deployer is deliberately NOT the
/// treasury: those are different roles, and transferring a manager's treasury should not
/// hand anyone authority over discounts across every manager generation. Harm from a
/// compromised admin is bounded to revenue — it can waive a fee or restore it to the
/// manager's own immutable rate, never charge more, touch principal, or block an exit.
/// `transferAdmin`/`acceptAdmin` is the two-step escape hatch if the key should move.
///
/// INITIAL_EXEMPT defaults to the reconstructed union of every prior manager's
/// `PerfFeeExemptSet` logs (0xD3EE…b110, 0x0e90…0cb3, 0x49a1…c5DC), read on 2026-07-30.
/// Nothing was ever deliberately un-exempted, so the union IS the intended set:
///   0xEA41…3058  house bot / operator
///   0x65d9…d2d7  beta tester — exempt on the first two managers, silently dropped in the
///                07-27 redeploy. Seeding it here restores what was promised.
contract DeployFeeExemptionRegistry is Script {
    function run() external {
        vm.startBroadcast();
        address admin = vm.envOr("ADMIN", msg.sender);

        address[] memory seed = new address[](2);
        seed[0] = 0xEA41b6d65d74742CbF52c29e200e5aE9fAe73058;
        seed[1] = 0x65d9120FaDB26dC31AD0200Ab0Ad38dAaE5Dd2d7;

        FeeExemptionRegistry registry = new FeeExemptionRegistry(admin, seed);
        vm.stopBroadcast();

        console2.log("FeeExemptionRegistry deployed:", address(registry));
        console2.log("  admin:", admin);
        for (uint256 i; i < seed.length; ++i) {
            console2.log("  exempt:", seed[i]);
        }
    }
}
