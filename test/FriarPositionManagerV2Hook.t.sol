// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Deployers} from "v4-core/test/utils/Deployers.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {LPFeeLibrary} from "v4-core/src/libraries/LPFeeLibrary.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {ModifyLiquidityParams} from "v4-core/src/types/PoolOperation.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";

import {FriarV2} from "../src/FriarV2.sol";
import {FriarPositionManager} from "../src/FriarPositionManager.sol";
import {IConfigurableFeeHook} from "../src/interfaces/IConfigurableFeeHook.sol";

/// The manager <-> FriarV2 seam. The interesting property is not that a pool can be made,
/// it is WHOSE config a manager-created pool ends up with, because FriarV2 keys config
/// proposals by registrant and the registrant of a manager-created pool is the manager.
contract FriarPositionManagerV2HookTest is Test, Deployers {
    FriarV2 friar;
    FriarPositionManager fpm;

    address alice = address(0xA11CE);
    address treasury = address(0x7EA);
    address bot = address(0xB07);
    address bob = address(0xB0B);

    int24 constant SPACING = 120;
    uint24 constant DEFAULT_BASE = 9000; // 0.90%, the shipping default
    uint24 constant CUSTOM_BASE = 3000; // 0.30%, what a creator might want instead

    function _cfg(uint24 basePips) internal pure returns (IConfigurableFeeHook.PoolConfig memory) {
        return IConfigurableFeeHook.PoolConfig({
            baseFeePips: basePips,
            filterFloor: 10,
            filterCeil: 300,
            windowK: 3,
            decayPeriod: 600,
            reductionFactor: 5000,
            variableFeeControl: 40_000,
            maxVolatilityTicks: 7000,
            locked: false
        });
    }

    function _hookCfg(uint24 basePips) internal pure returns (FriarV2.PoolConfig memory) {
        return FriarV2.PoolConfig({
            baseFeePips: basePips,
            filterFloor: 10,
            filterCeil: 300,
            windowK: 3,
            decayPeriod: 600,
            reductionFactor: 5000,
            variableFeeControl: 40_000,
            maxVolatilityTicks: 7000,
            locked: false
        });
    }

    function setUp() public {
        deployFreshManagerAndRouters();
        deployMintAndApprove2Currencies();

        address flags = address(uint160(Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG));
        deployCodeTo("FriarV2.sol:FriarV2", abi.encode(manager, _hookCfg(DEFAULT_BASE)), flags);
        friar = FriarV2(flags);

        // flat 5% both tiers, the shipping pricing
        fpm = new FriarPositionManager(manager, 500, 500, treasury, bot, 101);

        MockERC20(Currency.unwrap(currency0)).mint(alice, 1_000e18);
        MockERC20(Currency.unwrap(currency1)).mint(alice, 1_000e18);
        vm.startPrank(alice);
        MockERC20(Currency.unwrap(currency0)).approve(address(fpm), type(uint256).max);
        MockERC20(Currency.unwrap(currency1)).approve(address(fpm), type(uint256).max);
        vm.stopPrank();
    }

    function _freshKey(int24 spacing) internal view returns (PoolKey memory) {
        return PoolKey({
            currency0: currency0,
            currency1: currency1,
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: spacing,
            hooks: IHooks(address(friar))
        });
    }

    function _bins() internal pure returns (FriarPositionManager.Bin[] memory b) {
        b = new FriarPositionManager.Bin[](1);
        b[0] = FriarPositionManager.Bin({tickLower: -SPACING, tickUpper: SPACING, liquidity: 1e18});
    }

    function _noSwap() internal pure returns (FriarPositionManager.SwapIn memory s) {
        s.venue = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(address(0)),
            fee: 0,
            tickSpacing: 0,
            hooks: IHooks(address(0))
        });
    }

    /// The struct shape is part of the selector, so drift between the manager's interface
    /// and the hook's real signature would change it. A mismatch fails safe (the call
    /// reverts rather than misencoding) but it should be caught here, not on-chain.
    function test_interfaceSelectorMatchesTheHook() public pure {
        assertEq(
            IConfigurableFeeHook.setPoolConfig.selector,
            FriarV2.setPoolConfig.selector,
            "IConfigurableFeeHook has drifted from FriarV2.setPoolConfig"
        );
    }

    /// The whole reason openNewConfigured exists.
    function test_openNewConfiguredAppliesTheCallersConfig() public {
        PoolKey memory k = _freshKey(SPACING);
        vm.prank(alice);
        fpm.openNewConfigured(
            k, SQRT_PRICE_1_1, _cfg(CUSTOM_BASE), _bins(), _noSwap(), type(uint256).max, type(uint256).max
        );

        FriarV2.PoolConfig memory live = friar.configOf(k.toId());
        assertEq(live.baseFeePips, CUSTOM_BASE, "manager must register the caller's config as itself");
        assertTrue(live.locked, "config frozen at initialize");
    }

    /// The surprise this seam exists to prevent: a user registering from their own wallet
    /// and then calling plain openNew gets DEFAULTS, because the pool adopts the
    /// initializer's proposal and the initializer is the manager.
    function test_userRegisteredConfigIsIgnoredByPlainOpenNew() public {
        PoolKey memory k = _freshKey(SPACING);

        vm.prank(alice);
        friar.setPoolConfig(k, _hookCfg(CUSTOM_BASE)); // filed under alice, not the manager

        vm.prank(alice);
        fpm.openNew(k, SQRT_PRICE_1_1, _bins(), _noSwap(), type(uint256).max, type(uint256).max);

        assertEq(
            friar.configOf(k.toId()).baseFeePips,
            DEFAULT_BASE,
            "pool must take defaults: alice's proposal was not the initializer's"
        );
        // alice's proposal is dead and reports empty now the pool is locked, which is the
        // point of openNewConfigured: pre-registering from your own wallet does nothing
        assertEq(friar.pendingConfigOf(k.toId(), alice).baseFeePips, 0, "dead proposals must report empty");
    }

    /// Permissionless initialize means someone can always get there first. The manager must
    /// fail cleanly and move no funds, rather than opening into a pool it did not configure.
    ///
    /// The revert comes from setPoolConfig, NOT initialize: the winner's afterInitialize
    /// already froze the config, so the write is rejected before initialize is reached.
    /// Asserted specifically, because a bare expectRevert would pass on any failure and
    /// tell us nothing about where the guard actually lives.
    function test_openNewConfiguredRevertsIfSomeoneInitializedFirst() public {
        PoolKey memory k = _freshKey(SPACING);
        manager.initialize(k, SQRT_PRICE_1_1); // a searcher gets there first

        uint256 balBefore = MockERC20(Currency.unwrap(currency0)).balanceOf(alice);
        vm.prank(alice);
        vm.expectRevert(FriarV2.AlreadyLocked.selector);
        fpm.openNewConfigured(
            k, SQRT_PRICE_1_1, _cfg(CUSTOM_BASE), _bins(), _noSwap(), type(uint256).max, type(uint256).max
        );
        assertEq(MockERC20(Currency.unwrap(currency0)).balanceOf(alice), balBefore, "no funds may move on a lost race");
    }

    /// THE load-bearing property of the shared manager registrant. All users share
    /// _pending[poolId][manager], which is only safe because register + initialize + open
    /// are one atomic transaction. If a later step fails, the whole lifecycle must roll
    /// back — otherwise a failed open would leave a manager proposal, or worse an
    /// initialized pool, that a subsequent caller inherits.
    function test_failedOpenRollsBackTheEntireLifecycle() public {
        PoolKey memory k = _freshKey(SPACING);

        // maxPay 0 makes _open revert AFTER setPoolConfig and initialize have both succeeded
        vm.prank(alice);
        vm.expectRevert();
        fpm.openNewConfigured(k, SQRT_PRICE_1_1, _cfg(CUSTOM_BASE), _bins(), _noSwap(), 0, 0);

        (uint160 sqrtPrice,,,) = StateLibrary.getSlot0(manager, k.toId());
        assertEq(sqrtPrice, 0, "pool must remain uninitialized");
        assertEq(friar.pendingConfigOf(k.toId(), address(fpm)).baseFeePips, 0, "manager proposal must not survive");
        assertFalse(friar.configOf(k.toId()).locked, "nothing may be frozen");

        // and the PoolKey is genuinely still free: bob can take it with his own config
        vm.prank(bob);
        friar.setPoolConfig(k, _hookCfg(5000));
        vm.prank(bob);
        manager.initialize(k, SQRT_PRICE_1_1);
        assertEq(friar.configOf(k.toId()).baseFeePips, 5000, "bob must be able to claim the freed key");
    }

    /// The manager's proposal must not attach when somebody else does the initializing.
    function test_managerProposalCannotAttachToAnEOAInitialize() public {
        PoolKey memory k = _freshKey(SPACING);

        // strand a manager proposal by failing the open
        vm.prank(alice);
        vm.expectRevert();
        fpm.openNewConfigured(k, SQRT_PRICE_1_1, _cfg(CUSTOM_BASE), _bins(), _noSwap(), 0, 0);

        // even if one had survived, an EOA initializing takes its own/defaults
        vm.prank(bob);
        manager.initialize(k, SQRT_PRICE_1_1);
        assertEq(friar.configOf(k.toId()).baseFeePips, DEFAULT_BASE, "bob must get defaults, not a manager proposal");
    }

    /// Flat 5% both tiers: a single-bin and a multi-bin position must be charged the same
    /// rate, which is the pricing change riding along with this deploy.
    function test_flatFeeAcrossTiers() public view {
        assertEq(fpm.perfFeeBps(), 500, "shaped tier");
        assertEq(fpm.simpleFeeBps(), 500, "simple tier");
    }
}
