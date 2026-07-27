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
import {ReentrantHook} from "./mocks/HostileHooks.sol";
import {FeeOnTransferToken, ReturnsFalseToken, CallbackToken, ExitRevertingToken} from "./mocks/HostileTokens.sol";

/// Adversarial currencies and reentrancy. The manager accepts any ERC-20 the caller names
/// in a PoolKey, so these pin what v4's settlement model already guarantees — and make the
/// guarantees regression-tested rather than assumed.
contract FriarPositionManagerAdversarialTest is Test, Deployers {
    Friar friar;
    FriarPositionManager fpm;

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

        fpm = new FriarPositionManager(manager, 1000, 100, treasury, bot, 1);

        t0 = MockERC20(Currency.unwrap(currency0));
        t1 = MockERC20(Currency.unwrap(currency1));
        t0.mint(alice, 1_000e18);
        t1.mint(alice, 1_000e18);
        vm.startPrank(alice);
        t0.approve(address(fpm), type(uint256).max);
        t1.approve(address(fpm), type(uint256).max);
        vm.stopPrank();
    }

    function _bins() internal pure returns (FriarPositionManager.Bin[] memory bins) {
        bins = new FriarPositionManager.Bin[](3);
        bins[0] = FriarPositionManager.Bin(-100, 0, 10e18);
        bins[1] = FriarPositionManager.Bin(-200, -100, 20e18);
        bins[2] = FriarPositionManager.Bin(-300, -200, 30e18);
    }

    /// same shape, aligned to tickSpacing 60
    function _bins60() internal pure returns (FriarPositionManager.Bin[] memory bins) {
        bins = new FriarPositionManager.Bin[](3);
        bins[0] = FriarPositionManager.Bin(-60, 0, 10e18);
        bins[1] = FriarPositionManager.Bin(-120, -60, 20e18);
        bins[2] = FriarPositionManager.Bin(-180, -120, 30e18);
    }

    function _noSwapIn() internal pure returns (FriarPositionManager.SwapIn memory s) {}

    function _noZap() internal pure returns (FriarPositionManager.Zap memory z) {}

    // ------------------------------------------------------- adversarial currencies

    /// A pool built on two hostile tokens. Helper that wires an arbitrary pair through the
    /// same setup the manager would see in the wild.
    function _poolFor(address a, address b) internal returns (PoolKey memory k) {
        (address c0, address c1) = a < b ? (a, b) : (b, a);
        k = PoolKey(Currency.wrap(c0), Currency.wrap(c1), LPFeeLibrary.DYNAMIC_FEE_FLAG, 100, IHooks(address(friar)));
        manager.initialize(k, SQRT_PRICE_1_1);
    }

    /// Fee-on-transfer under-delivers to the PoolManager, so the measured balance delta
    /// falls short of what was owed. v4 must reject the whole unlock — a silent shortfall
    /// would mean the pool credits liquidity nobody paid for.
    function test_feeOnTransferToken_cannotUnderpay() public {
        FeeOnTransferToken fot = new FeeOnTransferToken(500); // 5%
        MockERC20 plain = new MockERC20("Plain", "PLN", 18);
        PoolKey memory k = _poolFor(address(fot), address(plain));

        fot.mint(alice, 1_000e18);
        plain.mint(alice, 1_000e18);
        vm.startPrank(alice);
        fot.approve(address(fpm), type(uint256).max);
        plain.approve(address(fpm), type(uint256).max);

        FriarPositionManager.Bin[] memory bins = new FriarPositionManager.Bin[](1);
        bins[0] = FriarPositionManager.Bin(-200, 200, 10e18); // straddles spot: needs BOTH sides
        vm.expectRevert(); // CurrencyNotSettled — the fee means the transfer under-delivers
        fpm.open(k, bins, _noSwapIn(), type(uint256).max, type(uint256).max);
        vm.stopPrank();
    }

    /// A token that returns false rather than reverting must not be able to mint liquidity
    /// for free: settlement measures the balance, it does not trust the return value.
    function test_returnsFalseToken_cannotMintFree() public {
        ReturnsFalseToken rf = new ReturnsFalseToken();
        MockERC20 plain = new MockERC20("Plain", "PLN", 18);
        PoolKey memory k = _poolFor(address(rf), address(plain));

        rf.mint(alice, 1_000e18);
        plain.mint(alice, 1_000e18);
        vm.startPrank(alice);
        rf.approve(address(fpm), type(uint256).max);
        plain.approve(address(fpm), type(uint256).max);
        rf.setFailing(true);

        FriarPositionManager.Bin[] memory bins = new FriarPositionManager.Bin[](1);
        bins[0] = FriarPositionManager.Bin(-200, 200, 10e18);
        vm.expectRevert(); // no tokens actually moved -> CurrencyNotSettled
        fpm.open(k, bins, _noSwapIn(), type(uint256).max, type(uint256).max);
        vm.stopPrank();
    }

    /// An ERC-777-style callback fires during `settle`, i.e. deep inside the unlock. Every
    /// manager verb routes through `manager.unlock`, and v4 rejects a nested unlock, so the
    /// reentrant call must fail while the outer operation still completes correctly.
    function test_callbackToken_reentrancyDuringSettleIsBlocked() public {
        CallbackToken cb = new CallbackToken();
        MockERC20 plain = new MockERC20("Plain", "PLN", 18);
        PoolKey memory k = _poolFor(address(cb), address(plain));

        cb.mint(alice, 1_000e18);
        plain.mint(alice, 1_000e18);
        vm.startPrank(alice);
        cb.approve(address(fpm), type(uint256).max);
        plain.approve(address(fpm), type(uint256).max);
        vm.stopPrank();

        // during settlement, try to open a second position from inside the callback
        FriarPositionManager.Bin[] memory reentrantBins = new FriarPositionManager.Bin[](1);
        reentrantBins[0] = FriarPositionManager.Bin(-200, 200, 1e18);
        cb.arm(
            address(fpm),
            abi.encodeCall(
                FriarPositionManager.open, (k, reentrantBins, _noSwapIn(), type(uint256).max, type(uint256).max)
            )
        );

        FriarPositionManager.Bin[] memory bins = new FriarPositionManager.Bin[](1);
        bins[0] = FriarPositionManager.Bin(-200, 200, 10e18);
        vm.prank(alice);
        uint256 id = fpm.open(k, bins, _noSwapIn(), type(uint256).max, type(uint256).max);

        assertTrue(cb.fired(), "callback did not fire -- test would be vacuous");
        assertFalse(cb.callSucceeded(), "a manager verb was reachable mid-unlock");
        assertEq(fpm.nextPositionId(), id + 1, "a reentrant open must not have minted an id");
    }

    // ------------------------------------------------------------------ reentrancy

    /// `openNew` calls `manager.initialize` BEFORE entering the unlock, so a hook's
    /// `afterInitialize` runs with the PoolManager unlocked and can call back in. That is
    /// benign only because no outer state has been written yet — the position id is not
    /// allocated until `initialize` returns. This pins that ordering.
    function test_openNew_hookReentrancyDuringInitializeIsBenign() public {
        address hookAddr = address(uint160(0xC0000 | uint160(Hooks.AFTER_INITIALIZE_FLAG)));
        deployCodeTo("HostileHooks.sol:ReentrantHook", abi.encode(manager), hookAddr);
        ReentrantHook rh = ReentrantHook(hookAddr);

        PoolKey memory hookedKey = PoolKey(currency0, currency1, LPFeeLibrary.DYNAMIC_FEE_FLAG, 60, IHooks(hookAddr));

        // fund the hook so its reentrant open can genuinely succeed -- otherwise it would
        // fail merely for lack of tokens and prove nothing about reentrancy
        t0.mint(hookAddr, 100e18);
        t1.mint(hookAddr, 100e18);
        vm.startPrank(hookAddr);
        t0.approve(address(fpm), type(uint256).max);
        t1.approve(address(fpm), type(uint256).max);
        vm.stopPrank();

        // from inside afterInitialize, try to open a position on the ALREADY-LIVE Friar pool
        FriarPositionManager.Bin[] memory reentrantBins = new FriarPositionManager.Bin[](1);
        reentrantBins[0] = FriarPositionManager.Bin(-200, -100, 1e18);
        rh.arm(
            address(fpm),
            abi.encodeCall(
                FriarPositionManager.open, (key, reentrantBins, _noSwapIn(), type(uint256).max, type(uint256).max)
            )
        );

        uint256 idBefore = fpm.nextPositionId();
        vm.prank(alice);
        uint256 id =
            fpm.openNew(hookedKey, SQRT_PRICE_1_1, _bins60(), _noSwapIn(), type(uint256).max, type(uint256).max);

        assertTrue(rh.attempted(), "hook never re-entered -- test would be vacuous");
        assertTrue(rh.succeeded(), "reentrancy was not actually reachable -- test proves nothing");

        // It IS reachable, and it is harmless: the reentrant open ran to completion and took
        // the FIRST id, because the outer call had not allocated its own id yet. The two
        // positions are distinct, separately owned, and both intact.
        uint256 innerId = fpm.positionsOf(hookAddr)[0];
        assertEq(innerId, idBefore, "reentrant open should take the id that was next at entry");
        assertEq(id, idBefore + 1, "outer open must take the following id, never reuse one");
        assertTrue(innerId != id, "id collision across reentrancy");

        (address owner,, FriarPositionManager.Bin[] memory bins) = fpm.getPosition(id);
        assertEq(owner, alice, "outer position corrupted by reentrancy");
        assertEq(bins.length, 3, "outer position lost bins");
        (address innerOwner,,) = fpm.getPosition(innerId);
        assertEq(innerOwner, hookAddr, "inner position ownership leaked");
    }

    /// The unlock callback is the manager's only privileged entry point. Anyone calling it
    /// directly must be rejected regardless of payload.
    function test_unlockCallback_onlyPoolManager() public {
        vm.prank(alice);
        vm.expectRevert(FriarPositionManager.NotPoolManager.selector);
        fpm.unlockCallback("");
    }

    /// Stray tokens sent directly to the manager are not stealable: every settle names the
    /// position owner as payer, never `address(this)`, so the manager's own balance is
    /// never spendable by another user's operation.
    function test_straySurplus_isNotSpendableByOthers() public {
        t0.mint(address(fpm), 100e18); // someone fat-fingers a transfer to the manager

        vm.prank(alice);
        uint256 id = fpm.open(key, _bins(), _noSwapIn(), type(uint256).max, type(uint256).max);
        assertEq(t0.balanceOf(address(fpm)), 100e18, "an open consumed the manager's own balance");

        vm.prank(alice);
        fpm.close(id, _noZap(), 0, 0, 0, 0);
        assertEq(t0.balanceOf(address(fpm)), 100e18, "a close drained the manager's own balance");
    }

    // ------------------------------------------- reentrancy from every hook callback

    /// Every manager verb routes through `manager.unlock`, and v4 reverts `AlreadyUnlocked`
    /// on a nested unlock — so no hook callback, whichever one fires, can re-enter a verb
    /// mid-operation. This drives ALL of them rather than assuming the guard generalises.
    ///
    /// `openNew` is excluded: its `initialize` runs BEFORE the unlock, so reentrancy there
    /// is genuinely reachable — see test_openNew_hookReentrancyDuringInitializeIsBenign.
    function _reentrancyIsBlockedFrom(uint160 permissionBits, bool exerciseSwap, bool exerciseExit) internal {
        address hookAddr = address(uint160(0xE0000 | permissionBits));
        deployCodeTo("HostileHooks.sol:ReentrantHook", abi.encode(manager), hookAddr);
        ReentrantHook rh = ReentrantHook(hookAddr);

        PoolKey memory k = PoolKey(currency0, currency1, 3000, 60, IHooks(hookAddr));
        manager.initialize(k, SQRT_PRICE_1_1);
        modifyLiquidityRouter.modifyLiquidity(
            k,
            ModifyLiquidityParams({tickLower: -30_000, tickUpper: 30_000, liquidityDelta: 500e18, salt: 0}),
            ZERO_BYTES
        );

        FriarPositionManager.Bin[] memory bins = new FriarPositionManager.Bin[](1);
        bins[0] = FriarPositionManager.Bin(-120, -60, 5e18);

        // arm the reentrant call BEFORE the op that triggers the callback
        FriarPositionManager.Bin[] memory reentrantBins = new FriarPositionManager.Bin[](1);
        reentrantBins[0] = FriarPositionManager.Bin(-120, -60, 1e18);
        rh.arm(
            address(fpm),
            abi.encodeCall(
                FriarPositionManager.open, (k, reentrantBins, _noSwapIn(), type(uint256).max, type(uint256).max)
            )
        );

        vm.prank(alice);
        uint256 id = fpm.open(k, bins, _noSwapIn(), type(uint256).max, type(uint256).max);

        if (exerciseSwap) {
            swap(k, true, -1e18, ZERO_BYTES);
        }
        if (exerciseExit) {
            vm.prank(alice);
            fpm.close(id, _noZap(), 0, 0, 0, 0);
        }

        assertTrue(rh.attempted(), "hook never re-entered -- test would be vacuous");
        assertFalse(rh.succeeded(), string.concat("a verb was reachable from ", rh.firedFrom()));
    }

    function test_reentrancy_blockedFromAddLiquidityCallbacks() public {
        _reentrancyIsBlockedFrom(
            uint160(Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.AFTER_ADD_LIQUIDITY_FLAG), false, false
        );
    }

    function test_reentrancy_blockedFromRemoveLiquidityCallbacks() public {
        _reentrancyIsBlockedFrom(
            uint160(Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG | Hooks.AFTER_REMOVE_LIQUIDITY_FLAG), false, true
        );
    }

    function test_reentrancy_blockedFromSwapCallbacks() public {
        _reentrancyIsBlockedFrom(uint160(Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG), true, false);
    }

    // ------------------------------------------------------------ honeypot token

    /// The honeypot shape: entry works, exit reverts. It must fail LOUDLY and atomically —
    /// a partial exit that burned liquidity without paying out would lose the position.
    function test_exitRevertingToken_failsAtomicallyWithoutLosingThePosition() public {
        ExitRevertingToken xr = new ExitRevertingToken();
        MockERC20 plain = new MockERC20("Plain", "PLN", 18);
        PoolKey memory k = _poolFor(address(xr), address(plain));

        xr.mint(alice, 1_000e18);
        plain.mint(alice, 1_000e18);
        vm.startPrank(alice);
        xr.approve(address(fpm), type(uint256).max);
        plain.approve(address(fpm), type(uint256).max);
        vm.stopPrank();

        FriarPositionManager.Bin[] memory bins = new FriarPositionManager.Bin[](1);
        bins[0] = FriarPositionManager.Bin(-200, 200, 5e18);
        vm.prank(alice);
        uint256 id = fpm.open(k, bins, _noSwapIn(), type(uint256).max, type(uint256).max);

        // the trap springs only on the way out: block transfers to alice
        xr.setTrapped(alice);

        vm.prank(alice);
        vm.expectRevert();
        fpm.close(id, _noZap(), 0, 0, 0, 0);

        // the whole tx reverted, so the position survives intact and is still recorded
        (address owner,, FriarPositionManager.Bin[] memory after_) = fpm.getPosition(id);
        assertEq(owner, alice, "position lost to a failed exit");
        assertEq(after_[0].liquidity, 5e18, "liquidity burned despite the revert");

        // and once the trap is lifted the exit works, so nothing is permanently stuck
        xr.setTrapped(address(0));
        vm.prank(alice);
        fpm.close(id, _noZap(), 0, 0, 0, 0);
        assertEq(fpm.positionsOf(alice).length, 0, "position not exitable after the trap lifted");
    }
}
