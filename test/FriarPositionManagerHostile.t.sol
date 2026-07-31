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
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";

import {Friar} from "../src/Friar.sol";
import {FriarPositionManager} from "../src/FriarPositionManager.sol";
import {FeeExemptionRegistry} from "../src/FeeExemptionRegistry.sol";
import {UnboundedFeeHook} from "./mocks/HostileHooks.sol";

/// Adversarial-venue suite. The manager is permissionless in its venues: `_requireSameCurrencies`
/// checks only that a zap venue shares both currencies, never its hook. These tests pin what a
/// hostile venue can and cannot do to a position owner.
contract FriarPositionManagerHostileTest is Test, Deployers {
    Friar friar;
    FriarPositionManager fpm;
    FeeExemptionRegistry registry;
    UnboundedFeeHook hostile;
    PoolKey hostileKey;

    address treasury = makeAddr("treasury");
    address bot = makeAddr("bot");
    address alice = makeAddr("alice");

    MockERC20 t0;
    MockERC20 t1;

    function setUp() public {
        deployFreshManagerAndRouters();
        deployMintAndApprove2Currencies();

        address flags = address(uint160(Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG));
        deployCodeTo(
            "Friar.sol:Friar",
            abi.encode(manager, uint16(5000), uint16(10), uint16(600), uint16(5000), uint24(40_000), uint24(350_000)),
            flags
        );
        friar = Friar(flags);
        (key,) =
            initPool(currency0, currency1, IHooks(address(friar)), LPFeeLibrary.DYNAMIC_FEE_FLAG, 100, SQRT_PRICE_1_1);
        modifyLiquidityRouter.modifyLiquidity(
            key,
            ModifyLiquidityParams({tickLower: -30_000, tickUpper: 30_000, liquidityDelta: 500e18, salt: 0}),
            ZERO_BYTES
        );

        address[] memory exempt_ = new address[](1);

        exempt_[0] = bot;

        registry = new FeeExemptionRegistry(address(this), exempt_);

        fpm = new FriarPositionManager(manager, 1000, 100, treasury, registry, 1);

        // The attacker's venue: same pair, its own hook, seeded so it looks like the
        // deepest price-sane pool a zap-out would route through.
        address hostileFlags =
            address(uint160(0xB0000 | uint160(Hooks.AFTER_SWAP_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG)));
        deployCodeTo("HostileHooks.sol:UnboundedFeeHook", abi.encode(manager), hostileFlags);
        hostile = UnboundedFeeHook(hostileFlags);
        hostileKey = PoolKey(currency0, currency1, 3000, 60, IHooks(hostileFlags));
        manager.initialize(hostileKey, SQRT_PRICE_1_1);
        modifyLiquidityRouter.modifyLiquidity(
            hostileKey,
            ModifyLiquidityParams({tickLower: -30_000, tickUpper: 30_000, liquidityDelta: 500e18, salt: 0}),
            ZERO_BYTES
        );

        t0 = MockERC20(Currency.unwrap(currency0));
        t1 = MockERC20(Currency.unwrap(currency1));
        t0.mint(alice, 1_000e18);
        t1.mint(alice, 1_000e18);
    }

    function _approveFpm(uint256 amount) internal {
        vm.startPrank(alice);
        t0.approve(address(fpm), amount);
        t1.approve(address(fpm), amount);
        vm.stopPrank();
    }

    function _bids() internal pure returns (FriarPositionManager.Bin[] memory bins) {
        bins = new FriarPositionManager.Bin[](3);
        bins[0] = FriarPositionManager.Bin(-100, 0, 10e18);
        bins[1] = FriarPositionManager.Bin(-200, -100, 20e18);
        bins[2] = FriarPositionManager.Bin(-300, -200, 30e18);
    }

    function _noSwapIn() internal pure returns (FriarPositionManager.SwapIn memory s) {}

    /// Open a position and trade through it so it holds token0 inventory to zap out of.
    function _openAndFill() internal returns (uint256 id) {
        vm.prank(alice);
        id = fpm.open(key, _bids(), _noSwapIn(), type(uint256).max, type(uint256).max);
        swap(key, true, -50e18, ZERO_BYTES);
    }

    /// A hostile zap venue must not be able to reach into the owner's wallet.
    ///
    /// The exit verbs take only `minReceive0/1`, and `_checkReceive` floors a NEGATIVE delta
    /// to zero — so a side where the owner *paid* passes any floor. `_resolve` then settles
    /// that debt with `transferFrom(owner, ...)`. A venue hook that returns an unbounded swap
    /// delta turns "close my position" into "drain my approved balance".
    /// Regression: before `maxPay0/1` existed on the exit verbs this drained ~99.7e18 of
    /// token1 out of alice's wallet. With default (zero) pay caps the exit refuses instead.
    function test_hostileVenue_cannotDrainOwnerWallet() public {
        _approveFpm(type(uint256).max); // the pre-fix app granted ~100x the position
        uint256 id = _openAndFill();

        uint256 before0 = t0.balanceOf(alice);
        uint256 before1 = t1.balanceOf(alice);
        hostile.setGrab(100e18); // "fee" far larger than the position is worth

        vm.prank(alice);
        vm.expectRevert(FriarPositionManager.PaidTooMuch.selector);
        fpm.close(id, FriarPositionManager.Zap({enabled: true, venue: hostileKey, zeroForOne: true}), 0, 0, 0, 0);

        // Closing a position must never leave the owner poorer than before they closed it.
        assertEq(t0.balanceOf(alice), before0, "close drained token0 from the owner's wallet");
        assertEq(t1.balanceOf(alice), before1, "close drained token1 from the owner's wallet");
    }

    /// Same attack through `collect`, the verb a user runs most often.
    function test_hostileVenue_cannotDrainOnCollect() public {
        _approveFpm(type(uint256).max);
        uint256 id = _openAndFill();

        uint256 before0 = t0.balanceOf(alice);
        uint256 before1 = t1.balanceOf(alice);
        hostile.setGrab(50e18);

        vm.prank(alice);
        vm.expectRevert(FriarPositionManager.PaidTooMuch.selector);
        fpm.collect(id, FriarPositionManager.Zap({enabled: true, venue: hostileKey, zeroForOne: true}), 0, 0, 0, 0);

        assertEq(t0.balanceOf(alice), before0, "collect drained token0 from the owner's wallet");
        assertEq(t1.balanceOf(alice), before1, "collect drained token1 from the owner's wallet");
    }

    /// The cap bounds the loss, it does not forbid paying. An owner exiting a venue that
    /// legitimately charges (a launchpad fee hook, an exit-fee pool) can still get out by
    /// raising the cap deliberately — money-out must never be brickable.
    function test_payingVenue_ownerCanOptIntoABoundedCharge() public {
        _approveFpm(type(uint256).max);
        uint256 id = _openAndFill();

        uint256 before1 = t1.balanceOf(alice);
        hostile.setGrab(1e18); // a "1 token" venue fee

        vm.prank(alice);
        fpm.close(id, FriarPositionManager.Zap({enabled: true, venue: hostileKey, zeroForOne: true}), 0, 0, 0, 2e18);

        // it went through, and the owner paid no more than the cap she set
        assertGe(t1.balanceOf(alice) + 2e18, before1, "charged more than the owner's cap");
        vm.expectRevert(FriarPositionManager.UnknownPosition.selector);
        fpm.getPosition(id);
    }

    /// A no-zap exit is unaffected by any venue: nothing routes through a hook at all, so
    /// the default zero pay caps never bind. This is the "money-out always works" path.
    function test_noZapExit_unaffectedByHostileVenues() public {
        _approveFpm(type(uint256).max);
        uint256 id = _openAndFill();
        hostile.setGrab(100e18);

        uint256 before0 = t0.balanceOf(alice);
        uint256 before1 = t1.balanceOf(alice);

        vm.prank(alice);
        fpm.close(id, FriarPositionManager.Zap({enabled: false, venue: hostileKey, zeroForOne: false}), 0, 0, 0, 0);

        assertGt(t0.balanceOf(alice) + t1.balanceOf(alice), before0 + before1, "plain close must still pay out");
    }

    /// Documents the standing mitigation shipped in the app: whatever the contract allows,
    /// the loss is bounded by the residual ERC-20 allowance. Exact-cap approvals mean an
    /// exit can reach almost nothing even against a hostile venue.
    function test_hostileVenue_lossBoundedByAllowance() public {
        _approveFpm(0); // nothing left approved after an exact-cap open
        uint256 id;
        {
            _approveFpm(type(uint256).max);
            id = _openAndFill();
            _approveFpm(0); // the open consumed its allowance
        }

        uint256 before1 = t1.balanceOf(alice);
        hostile.setGrab(100e18);

        vm.prank(alice);
        vm.expectRevert(); // ERC-20 transferFrom cannot exceed a zero allowance
        fpm.close(id, FriarPositionManager.Zap({enabled: true, venue: hostileKey, zeroForOne: true}), 0, 0, 0, 0);

        assertEq(t1.balanceOf(alice), before1, "no allowance, no drain");
    }
}
