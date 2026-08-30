// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {Deployers} from "v4-core/test/utils/Deployers.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {LPFeeLibrary} from "v4-core/src/libraries/LPFeeLibrary.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {ModifyLiquidityParams} from "v4-core/src/types/PoolOperation.sol";

import {FriarTier} from "../src/FriarTier.sol";
import {FriarV2} from "../src/FriarV2.sol";

/// FriarTier is FriarV2's surge with the base fee moved to an immutable. These tests pin the
/// two things that matters for that move: the base fee is exactly the tier, and the surge is
/// byte-for-byte the same as FriarV2 fed the identical parameters. The LB core is covered by
/// FriarMath.t.sol; per-pool config bounds are FriarV2's problem, not this hook's.
contract FriarTierTest is Test, Deployers {
    bytes32 constant SWAP_TOPIC = keccak256("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)");
    int24 constant TICK_SPACING = 150;

    // shared surge parameters — identical across every shipped tier, so base fee is the only
    // thing that differs between the deployed hooks
    uint16 constant FILTER = 10;
    uint16 constant DECAY = 600;
    uint16 constant REDUCTION = 5000;
    uint24 constant VFC = 40_000;
    uint24 constant MAX_VOL_TICKS = 7000;

    function _params(uint24 baseFeePips) internal pure returns (FriarTier.FeeParams memory) {
        return FriarTier.FeeParams({
            baseFeePips: baseFeePips,
            filterPeriod: FILTER,
            decayPeriod: DECAY,
            reductionFactor: REDUCTION,
            variableFeeControl: VFC,
            maxVolatilityTicks: MAX_VOL_TICKS
        });
    }

    function _v2cfg(uint24 baseFeePips) internal pure returns (FriarV2.PoolConfig memory) {
        return FriarV2.PoolConfig({
            baseFeePips: baseFeePips,
            filterPeriod: FILTER,
            decayPeriod: DECAY,
            reductionFactor: REDUCTION,
            variableFeeControl: VFC,
            maxVolatilityTicks: MAX_VOL_TICKS,
            locked: false
        });
    }

    function _deployTier(uint24 baseFeePips, uint256 addrSalt) internal returns (FriarTier) {
        address a = address(uint160(Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG) | (uint160(addrSalt) << 20));
        deployCodeTo("FriarTier.sol:FriarTier", abi.encode(manager, _params(baseFeePips)), a);
        return FriarTier(a);
    }

    function _initAndSeed(IHooks hook, int24 spacing) internal returns (PoolKey memory k) {
        (k,) = initPool(currency0, currency1, hook, LPFeeLibrary.DYNAMIC_FEE_FLAG, spacing, SQRT_PRICE_1_1);
        modifyLiquidityRouter.modifyLiquidity(
            k, ModifyLiquidityParams({tickLower: -6000, tickUpper: 6000, liquidityDelta: 100e18, salt: 0}), ZERO_BYTES
        );
    }

    function _swapFee(PoolKey memory k, bool zeroForOne, int256 amount) internal returns (uint24) {
        vm.recordLogs();
        swap(k, zeroForOne, amount, ZERO_BYTES);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = logs.length; i > 0; i--) {
            if (logs[i - 1].topics[0] == SWAP_TOPIC) {
                (,,,,, uint24 f) = abi.decode(logs[i - 1].data, (int128, int128, uint160, uint128, int24, uint24));
                return f;
            }
        }
        revert("no Swap event");
    }

    function setUp() public {
        deployFreshManagerAndRouters();
        deployMintAndApprove2Currencies();
    }

    /// A fresh pool with no price history pays exactly the tier's base fee — the immutable IS
    /// the floor, and it's whatever the hook was deployed with.
    function test_baseFeeIsTheTier() public {
        FriarTier t5 = _deployTier(50_000, 1); // 5%
        PoolKey memory k = _initAndSeed(IHooks(address(t5)), TICK_SPACING);
        assertEq(_swapFee(k, true, -0.0001e18), 50_000, "first swap pays the 5% base");
        assertEq(t5.baseFeePips(), 50_000);
    }

    /// Two tier hooks differ in one thing: the base fee they add under the same surge. A calm
    /// first swap on each pays its own tier.
    function test_tiersDifferByBaseFeeOnly() public {
        FriarTier t03 = _deployTier(3_000, 2); // 0.30%
        FriarTier t80 = _deployTier(8_000, 3); // 0.80%
        PoolKey memory k03 = _initAndSeed(IHooks(address(t03)), TICK_SPACING);
        PoolKey memory k80 = _initAndSeed(IHooks(address(t80)), TICK_SPACING);
        assertEq(_swapFee(k03, true, -0.0001e18), 3_000);
        assertEq(_swapFee(k80, true, -0.0001e18), 8_000);
    }

    /// The whole point of porting FriarV2's surge rather than V1's: a FriarTier and a FriarV2
    /// fed identical parameters must return identical fees over an identical swap sequence,
    /// including the surge, so the tier hooks inherit V2's spacing-invariant behaviour exactly.
    function test_surgeParityWithFriarV2() public {
        uint24 base = 9_000;
        FriarTier tier = _deployTier(base, 4);

        address v2a = address(uint160(Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG) | (5 << 20));
        deployCodeTo("FriarV2.sol:FriarV2", abi.encode(manager, _v2cfg(base)), v2a);
        FriarV2 v2 = FriarV2(v2a);

        PoolKey memory kt = _initAndSeed(IHooks(address(tier)), TICK_SPACING);
        PoolKey memory kv = _initAndSeed(IHooks(address(v2)), TICK_SPACING);

        // a sequence that builds and then decays the accumulator: rapid same-direction swaps
        // (surge climbs), then a long gap (references refresh), then another swap
        int256[5] memory amounts = [int256(-0.02e18), -0.02e18, -0.02e18, int256(0.015e18), -0.03e18];
        uint256[5] memory waits = [uint256(2), 3, 1, 900, 4];
        for (uint256 i = 0; i < amounts.length; i++) {
            vm.warp(block.timestamp + waits[i]);
            uint24 ft = _swapFee(kt, amounts[i] < 0, amounts[i]);
            uint24 fv = _swapFee(kv, amounts[i] < 0, amounts[i]);
            assertEq(ft, fv, "tier and v2 fees diverged");
            assertGe(ft, base, "fee never dips below base");
        }
    }

    /// Deploy-time validation: a zero or over-cap base fee reverts rather than shipping a
    /// broken tier.
    function test_constructorRejectsBadBaseFee() public {
        address a = address(uint160(Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG) | (6 << 20));
        vm.expectRevert(FriarTier.InvalidParameters.selector);
        deployCodeTo("FriarTier.sol:FriarTier", abi.encode(manager, _params(0)), a);

        address b = address(uint160(Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG) | (7 << 20));
        vm.expectRevert(FriarTier.InvalidParameters.selector);
        deployCodeTo("FriarTier.sol:FriarTier", abi.encode(manager, _params(100_001)), b); // > 10% cap
    }

    /// Permission bits: exactly AFTER_INITIALIZE + BEFORE_SWAP, the trust claim the address
    /// itself encodes. No delta bits, no liquidity callbacks.
    function test_permissionsAreMinimal() public {
        FriarTier t = _deployTier(10_000, 8);
        Hooks.Permissions memory p = t.getHookPermissions();
        assertTrue(p.afterInitialize && p.beforeSwap);
        assertFalse(p.beforeSwapReturnDelta || p.afterSwapReturnDelta);
        assertFalse(p.beforeAddLiquidity || p.afterAddLiquidity || p.beforeRemoveLiquidity || p.afterRemoveLiquidity);
    }
}
