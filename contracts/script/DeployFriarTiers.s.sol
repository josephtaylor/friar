// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";

import {FriarTier} from "../src/FriarTier.sol";

/// @notice Mines and deploys the full FriarTier fee-tier set in one broadcast: five hooks
/// that differ ONLY in base fee (0.30 / 0.80 / 1 / 2 / 5%), each sharing FriarV2's surge
/// parameters. Base fee is a hook immutable, so each tier is a distinct on-chain venue and a
/// pool's fee is part of its identity. Bin width is chosen per pool at initialize and is
/// independent of the tier.
///
/// Two invariants the miner enforces, both about staying auto-allowlisted for Uniswap
/// routing so no HubSpot form is ever needed:
///   1. permission bits AFTER_INITIALIZE | BEFORE_SWAP (no delta flags), and
///   2. the address must NOT begin with 0x91 — the routing allowlist singles those out for
///      manual review. HookMiner.find can't express (2), so the loop is inline.
///
/// Usage — `--sender` is REQUIRED (without it Foundry substitutes its default sender and the
/// printed address is plausible but wrong; verify with `cast codesize`, never the log):
///
///   forge script script/DeployFriarTiers.s.sol --rpc-url robinhood --broadcast \
///     --account tuck-deployer --sender 0xEA41b6d65d74742CbF52c29e200e5aE9fAe73058
///
/// Verify every deployed address on Blockscout immediately (via the v2 endpoint — see
/// reference-blockscout-verify-v2): the hooklist analyzer and the trust claim both rest on
/// the permission bits being readable from verified source. Surge defaults match DeployFriarV2
/// and are documented there.
contract DeployFriarTiers is Script {
    address constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    uint160 constant FLAG_MASK = uint160((1 << 14) - 1);

    function run() external {
        // The tier set — base fee in v4 pips (10_000 = 1%). Locked: 0.30 / 0.80 / 1 / 2 / 5%.
        uint24[5] memory baseFees = [uint24(3_000), 8_000, 10_000, 20_000, 50_000];

        uint160 flags = uint160(Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG) & FLAG_MASK;

        for (uint256 i = 0; i < baseFees.length; i++) {
            FriarTier.FeeParams memory p = FriarTier.FeeParams({
                baseFeePips: baseFees[i],
                filterPeriod: uint16(vm.envOr("FILTER_PERIOD", uint256(10))),
                decayPeriod: uint16(vm.envOr("DECAY_PERIOD", uint256(600))),
                reductionFactor: uint16(vm.envOr("REDUCTION_FACTOR", uint256(5000))),
                variableFeeControl: uint24(vm.envOr("VARIABLE_FEE_CONTROL", uint256(40_000))),
                maxVolatilityTicks: uint24(vm.envOr("MAX_VOLATILITY_TICKS", uint256(7000)))
            });

            bytes memory args = abi.encode(IPoolManager(POOL_MANAGER), p);
            (address mined, bytes32 salt) = _mine(flags, abi.encodePacked(type(FriarTier).creationCode, args));

            console2.log("Tier base fee (pips):", baseFees[i]);
            console2.log("  mined address:", mined);
            console2.log("  salt:");
            console2.logBytes32(salt);

            vm.startBroadcast();
            FriarTier hook = new FriarTier{salt: salt}(IPoolManager(POOL_MANAGER), p);
            vm.stopBroadcast();

            require(address(hook) == mined, "address mismatch: CREATE2 deployer differs from miner assumption");
            console2.log("  deployed:", address(hook));
        }
    }

    /// @dev CREATE2 salt search: flag bits must match AND the address must not start with
    /// 0x91. The init-code hash is computed ONCE; each iteration only rehashes the fixed
    /// 85-byte CREATE2 preimage in a reused scratch buffer, so memory does not grow across
    /// the ~16k expected iterations (a naive computeAddress-per-salt loop OOMs). Standard flag
    /// match probability is 1/2^14; the 0x91 skip drops 1/256 of hits, negligible.
    function _mine(uint160 flags, bytes memory initCode) internal view returns (address, bytes32) {
        bytes32 initCodeHash = keccak256(initCode);
        address deployer = CREATE2_DEPLOYER;
        for (uint256 salt; salt < 2_000_000; salt++) {
            address a;
            assembly {
                let ptr := mload(0x40) // scratch; free pointer is never advanced, so no growth
                mstore8(ptr, 0xff)
                mstore(add(ptr, 0x01), shl(96, deployer)) // 20-byte address in the high bytes
                mstore(add(ptr, 0x15), salt)
                mstore(add(ptr, 0x35), initCodeHash)
                a := and(keccak256(ptr, 0x55), 0xffffffffffffffffffffffffffffffffffffffff)
            }
            if (uint160(a) & FLAG_MASK == flags && a.code.length == 0 && uint8(uint160(a) >> 152) != 0x91) {
                return (a, bytes32(salt));
            }
        }
        revert("no salt found");
    }
}
