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
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {Position as V4Position} from "v4-core/src/libraries/Position.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";

import {FriarPositionManager} from "../src/FriarPositionManager.sol";
import {UnboundedLiquidityFeeHook} from "./mocks/HostileHooks.sol";

/// The position's OWN pool is hostile — not the zap venue.
///
/// This reaches every verb, including no-zap exits, because it attacks `modifyLiquidity`
/// rather than a swap. The app refuses to LP into remove-liquidity hooks (`classifyHook`
/// blocks them), but the manager is permissionless: anyone can call it directly with any
/// PoolKey, so the bound has to hold on-chain.
contract FriarPositionManagerHostilePoolTest is Test, Deployers {
    using StateLibrary for IPoolManager;

    FriarPositionManager fpm;
    UnboundedLiquidityFeeHook hostile;
    PoolKey hostileKey;

    address treasury = makeAddr("treasury");
    address bot = makeAddr("bot");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    MockERC20 t0;
    MockERC20 t1;

    function setUp() public {
        deployFreshManagerAndRouters();
        deployMintAndApprove2Currencies();

        address flags = address(
            uint160(
                0xD0000
                    | uint160(
                        Hooks.AFTER_ADD_LIQUIDITY_FLAG | Hooks.AFTER_ADD_LIQUIDITY_RETURNS_DELTA_FLAG
                            | Hooks.AFTER_REMOVE_LIQUIDITY_FLAG | Hooks.AFTER_REMOVE_LIQUIDITY_RETURNS_DELTA_FLAG
                    )
            )
        );
        deployCodeTo("HostileHooks.sol:UnboundedLiquidityFeeHook", abi.encode(manager), flags);
        hostile = UnboundedLiquidityFeeHook(flags);

        hostileKey = PoolKey(currency0, currency1, 3000, 60, IHooks(flags));
        manager.initialize(hostileKey, SQRT_PRICE_1_1);
        // background book so the pool holds tokens for the hook to `take`
        modifyLiquidityRouter.modifyLiquidity(
            hostileKey,
            ModifyLiquidityParams({tickLower: -30_000, tickUpper: 30_000, liquidityDelta: 500e18, salt: 0}),
            ZERO_BYTES
        );

        fpm = new FriarPositionManager(manager, 1000, 100, treasury, bot, 1);

        t0 = MockERC20(Currency.unwrap(currency0));
        t1 = MockERC20(Currency.unwrap(currency1));
        for (uint256 i = 0; i < 2; i++) {
            address who = i == 0 ? alice : bob;
            t0.mint(who, 1_000e18);
            t1.mint(who, 1_000e18);
            vm.startPrank(who);
            t0.approve(address(fpm), type(uint256).max);
            t1.approve(address(fpm), type(uint256).max);
            vm.stopPrank();
        }
    }

    function _bins() internal pure returns (FriarPositionManager.Bin[] memory bins) {
        bins = new FriarPositionManager.Bin[](2);
        bins[0] = FriarPositionManager.Bin(-120, -60, 10e18);
        bins[1] = FriarPositionManager.Bin(-240, -120, 20e18);
    }

    function _noSwapIn() internal pure returns (FriarPositionManager.SwapIn memory s) {}

    function _noZap() internal pure returns (FriarPositionManager.Zap memory z) {}

    function _open(address who) internal returns (uint256 id) {
        vm.prank(who);
        id = fpm.open(hostileKey, _bins(), _noSwapIn(), type(uint256).max, type(uint256).max);
    }

    /// Entry through a hostile pool is bounded by the OPEN's pay caps.
    ///
    /// Differential, so the hook is provably the cause: the SAME open under the SAME cap
    /// succeeds with the hook idle and reverts once it starts taking. A one-sided
    /// assertion here would also pass if the bins simply cost more than the cap.
    function test_hostilePool_openBoundedByMaxPay() public {
        uint256 cap = 1e18;

        hostile.setGrabs(0, 0);
        uint256 snap = vm.snapshotState();
        vm.prank(alice);
        fpm.open(hostileKey, _bins(), _noSwapIn(), type(uint256).max, cap); // fits under the cap
        vm.revertToState(snap);

        hostile.setGrabs(50e18, 0); // now the hook takes on add
        vm.prank(alice);
        vm.expectRevert(FriarPositionManager.PaidTooMuch.selector);
        fpm.open(hostileKey, _bins(), _noSwapIn(), type(uint256).max, cap);
    }

    /// The important one: a NO-ZAP close, where nothing routes through a swap venue at
    /// all, still cannot be made to charge the owner. The hostile hook fires inside
    /// `modifyLiquidity` on the position's own pool.
    function test_hostilePool_noZapCloseCannotChargeOwner() public {
        uint256 id = _open(alice);
        hostile.setGrabs(0, 100e18); // exit "fee" larger than the position

        uint256 before0 = t0.balanceOf(alice);
        uint256 before1 = t1.balanceOf(alice);

        vm.prank(alice);
        vm.expectRevert(FriarPositionManager.PaidTooMuch.selector);
        fpm.close(id, _noZap(), 0, 0, 0, 0);

        assertEq(t0.balanceOf(alice), before0, "no-zap close drained token0");
        assertEq(t1.balanceOf(alice), before1, "no-zap close drained token1");
    }

    /// `collect` pokes every bin with a zero delta, which still invokes the hook — so the
    /// cheapest, most frequent verb is an attack surface too.
    function test_hostilePool_collectCannotChargeOwner() public {
        uint256 id = _open(alice);
        hostile.setGrabs(0, 25e18);

        uint256 before1 = t1.balanceOf(alice);
        vm.prank(alice);
        vm.expectRevert(FriarPositionManager.PaidTooMuch.selector);
        fpm.collect(id, _noZap(), 0, 0, 0, 0);
        assertEq(t1.balanceOf(alice), before1, "collect drained the owner");
    }

    function test_hostilePool_decreaseCannotChargeOwner() public {
        uint256 id = _open(alice);
        hostile.setGrabs(0, 40e18);

        uint128[] memory ds = new uint128[](2);
        ds[0] = 5e18;
        uint256 before1 = t1.balanceOf(alice);
        vm.prank(alice);
        vm.expectRevert(FriarPositionManager.PaidTooMuch.selector);
        fpm.decrease(id, ds, _noZap(), 0, 0, 0, 0);
        assertEq(t1.balanceOf(alice), before1, "decrease drained the owner");
    }

    /// The cap is a bound, not a prohibition: a pool that charges a small, disclosed exit
    /// fee stays exitable when the owner opts in. Money-out must never be brickable.
    function test_hostilePool_ownerCanOptIntoABoundedExitFee() public {
        uint256 id = _open(alice);
        hostile.setGrabs(0, 1e15);

        vm.prank(alice);
        fpm.close(id, _noZap(), 0, 0, 0, 1e16); // cap above the fee
        vm.expectRevert(FriarPositionManager.UnknownPosition.selector);
        fpm.getPosition(id);
    }

    // ----------------------------------------------------- cross-tenant isolation

    /// Two owners in the SAME hostile pool. One owner's operations — including ones the
    /// hook forces to revert — must not touch the other's liquidity, bins, or record.
    function test_hostilePool_ownersRemainIsolated() public {
        uint256 aliceId = _open(alice);
        uint256 bobId = _open(bob);

        // snapshot bob's on-chain liquidity under his own salts
        uint128 bobBin0Before = manager.getPositionLiquidity(
            hostileKey.toId(), V4Position.calculatePositionKey(address(fpm), -120, -60, fpm.binSalt(bobId, 0))
        );
        uint256 bobT0Before = t0.balanceOf(bob);
        uint256 bobT1Before = t1.balanceOf(bob);

        // alice thrashes: a failing hostile exit, then a successful one
        hostile.setGrabs(0, 100e18);
        vm.prank(alice);
        vm.expectRevert(FriarPositionManager.PaidTooMuch.selector);
        fpm.close(aliceId, _noZap(), 0, 0, 0, 0);

        hostile.setGrabs(0, 0);
        vm.prank(alice);
        fpm.close(aliceId, _noZap(), 0, 0, 0, 0);

        // bob is untouched in every observable way
        uint128 bobBin0After = manager.getPositionLiquidity(
            hostileKey.toId(), V4Position.calculatePositionKey(address(fpm), -120, -60, fpm.binSalt(bobId, 0))
        );
        assertEq(bobBin0After, bobBin0Before, "bob's pool liquidity moved");
        assertEq(t0.balanceOf(bob), bobT0Before, "bob's wallet was touched");
        assertEq(t1.balanceOf(bob), bobT1Before, "bob's wallet was touched");

        (address owner,, FriarPositionManager.Bin[] memory bins) = fpm.getPosition(bobId);
        assertEq(owner, bob, "bob lost ownership");
        assertEq(bins[0].liquidity, 10e18, "bob's recorded bin changed");
        assertEq(bins[1].liquidity, 20e18, "bob's recorded bin changed");

        // and bob can still exit normally afterwards
        vm.prank(bob);
        fpm.close(bobId, _noZap(), 0, 0, 0, 0);
        assertEq(fpm.positionsOf(bob).length, 0, "bob could not exit");
    }

    /// Salts are derived from (positionId, binIndex), so two owners holding the same tick
    /// range in the same pool must occupy distinct v4 positions.
    function test_sameRangeDifferentOwners_distinctSalts() public {
        uint256 aliceId = _open(alice);
        uint256 bobId = _open(bob);

        assertTrue(fpm.binSalt(aliceId, 0) != fpm.binSalt(bobId, 0), "salt collision across owners");
        uint128 a = manager.getPositionLiquidity(
            hostileKey.toId(), V4Position.calculatePositionKey(address(fpm), -120, -60, fpm.binSalt(aliceId, 0))
        );
        uint128 b = manager.getPositionLiquidity(
            hostileKey.toId(), V4Position.calculatePositionKey(address(fpm), -120, -60, fpm.binSalt(bobId, 0))
        );
        assertEq(a, 10e18);
        assertEq(b, 10e18);
    }
}
