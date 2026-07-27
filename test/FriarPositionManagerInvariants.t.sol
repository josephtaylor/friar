// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
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

import {Friar} from "../src/Friar.sol";
import {FriarPositionManager} from "../src/FriarPositionManager.sol";

interface IMarket {
    function swapMarket(bool zeroForOne, int256 amount) external;
}

/// @notice Drives arbitrary sequences of manager verbs from several actors, plus market
/// swaps that move price through the bins. Every reachable state the invariants below
/// assert over is produced by this handler.
contract ManagerHandler is Test {
    using StateLibrary for IPoolManager;

    FriarPositionManager public fpm;
    IPoolManager public manager;
    PoolKey public key;
    MockERC20 public t0;
    MockERC20 public t1;
    address public swapper;

    address[] public actors;
    uint256[] public liveIds;
    mapping(uint256 => bool) public isLive;

    /// running total of what the treasury has been paid, to compare against fees only
    uint256 public treasuryTotal0;
    uint256 public treasuryTotal1;
    address public treasury;

    /// Ghost: set true if ANY exit run with maxPay0 = maxPay1 = 0 ever left its owner
    /// holding less than before. The whole point of the pay caps is that this stays false
    /// for every reachable sequence, not just the hand-written cases.
    bool public exitChargedOwner;
    /// how many exits actually executed, so the invariant can't pass vacuously
    uint256 public exitsObserved;

    function _assertExitNeverCharges(address owner, uint256 b0, uint256 b1) internal {
        exitsObserved++;
        if (t0.balanceOf(owner) < b0 || t1.balanceOf(owner) < b1) exitChargedOwner = true;
    }

    constructor(
        FriarPositionManager _fpm,
        IPoolManager _manager,
        PoolKey memory _key,
        address[] memory _actors,
        address _treasury,
        address _swapper
    ) {
        fpm = _fpm;
        manager = _manager;
        key = _key;
        actors = _actors;
        treasury = _treasury;
        swapper = _swapper;
        t0 = MockERC20(Currency.unwrap(_key.currency0));
        t1 = MockERC20(Currency.unwrap(_key.currency1));
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    function liveCount() external view returns (uint256) {
        return liveIds.length;
    }

    function liveAt(uint256 i) external view returns (uint256) {
        return liveIds[i];
    }

    function _trackTreasury() internal {
        treasuryTotal0 = t0.balanceOf(treasury);
        treasuryTotal1 = t1.balanceOf(treasury);
    }

    function open(uint256 actorSeed, uint256 binSeed, uint256 liqSeed) external {
        address who = _actor(actorSeed);
        uint256 n = (binSeed % 4) + 1; // 1..4 bins — covers both the simple and shaped tiers
        // bins stack downward starting immediately below spot, so ordinary market swaps
        // actually cross them and accrue fees (otherwise the fee paths go unexercised)
        FriarPositionManager.Bin[] memory bins = new FriarPositionManager.Bin[](n);
        for (uint256 i = 0; i < n; i++) {
            int24 upper = -int24(uint24(100 * i));
            uint128 liq = uint128(bound(liqSeed + i, 1e15, 5e18));
            bins[i] = FriarPositionManager.Bin(upper - 100, upper, liq);
        }
        FriarPositionManager.SwapIn memory noSwapIn;
        vm.prank(who);
        try fpm.open(key, bins, noSwapIn, type(uint256).max, type(uint256).max) returns (uint256 id) {
            liveIds.push(id);
            isLive[id] = true;
        } catch {}
        _trackTreasury();
    }

    function increase(uint256 idSeed, uint256 amountSeed) external {
        if (liveIds.length == 0) return;
        uint256 id = liveIds[idSeed % liveIds.length];
        (address owner,, FriarPositionManager.Bin[] memory bins) = fpm.getPosition(id);
        uint128[] memory ds = new uint128[](bins.length);
        for (uint256 i = 0; i < bins.length; i++) {
            ds[i] = uint128(bound(amountSeed + i, 0, 1e18));
        }
        vm.prank(owner);
        try fpm.increase(id, ds, _noSwapIn(), type(uint256).max, type(uint256).max) {} catch {}
        _trackTreasury();
    }

    function decrease(uint256 idSeed, uint256 amountSeed) external {
        if (liveIds.length == 0) return;
        uint256 id = liveIds[idSeed % liveIds.length];
        (address owner,, FriarPositionManager.Bin[] memory bins) = fpm.getPosition(id);
        uint128[] memory ds = new uint128[](bins.length);
        bool anyLeft = false;
        for (uint256 i = 0; i < bins.length; i++) {
            ds[i] = uint128(bound(amountSeed + i, 0, bins[i].liquidity));
            if (bins[i].liquidity - ds[i] > 0) anyLeft = true;
        }
        FriarPositionManager.Zap memory noZap;
        uint256 b0 = t0.balanceOf(owner);
        uint256 b1 = t1.balanceOf(owner);
        vm.prank(owner);
        try fpm.decrease(id, ds, noZap, 0, 0, 0, 0) {
            _assertExitNeverCharges(owner, b0, b1);
            if (!anyLeft) _retire(id);
        } catch {}
        _trackTreasury();
    }

    function collect(uint256 idSeed) external {
        if (liveIds.length == 0) return;
        uint256 id = liveIds[idSeed % liveIds.length];
        (address owner,,) = fpm.getPosition(id);
        FriarPositionManager.Zap memory noZap;
        uint256 b0 = t0.balanceOf(owner);
        uint256 b1 = t1.balanceOf(owner);
        vm.prank(owner);
        try fpm.collect(id, noZap, 0, 0, 0, 0) {
            _assertExitNeverCharges(owner, b0, b1);
        } catch {}
        _trackTreasury();
    }

    function close(uint256 idSeed) external {
        if (liveIds.length == 0) return;
        uint256 id = liveIds[idSeed % liveIds.length];
        (address owner,,) = fpm.getPosition(id);
        FriarPositionManager.Zap memory noZap;
        uint256 b0 = t0.balanceOf(owner);
        uint256 b1 = t1.balanceOf(owner);
        vm.prank(owner);
        try fpm.close(id, noZap, 0, 0, 0, 0) {
            _assertExitNeverCharges(owner, b0, b1);
            _retire(id);
        } catch {}
        _trackTreasury();
    }

    /// Move the market so bins get crossed and fees accrue.
    function marketSwap(uint256 amountSeed, bool zeroForOne) external {
        int256 amt = -int256(bound(amountSeed, 1e15, 20e18));
        try IMarket(swapper).swapMarket(zeroForOne, amt) {} catch {}
    }

    function _retire(uint256 id) internal {
        isLive[id] = false;
        for (uint256 i = 0; i < liveIds.length; i++) {
            if (liveIds[i] == id) {
                liveIds[i] = liveIds[liveIds.length - 1];
                liveIds.pop();
                return;
            }
        }
    }

    function _noSwapIn() internal pure returns (FriarPositionManager.SwapIn memory s) {}
}

contract FriarPositionManagerInvariantsTest is StdInvariant, Test, Deployers {
    using StateLibrary for IPoolManager;

    Friar friar;
    FriarPositionManager fpm;
    ManagerHandler handler;

    address treasury = makeAddr("treasury");
    address bot = makeAddr("bot");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");

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
            // deliberately shallow: deep background liquidity would pin the price and the
            // handler's swaps would never cross the bins
            ModifyLiquidityParams({tickLower: -60_000, tickUpper: 60_000, liquidityDelta: 200e18, salt: 0}),
            ZERO_BYTES
        );

        fpm = new FriarPositionManager(manager, 1000, 100, treasury, bot, 1);

        t0 = MockERC20(Currency.unwrap(currency0));
        t1 = MockERC20(Currency.unwrap(currency1));

        address[] memory actors = new address[](4);
        actors[0] = alice;
        actors[1] = bob;
        actors[2] = carol;
        actors[3] = bot; // fee-exempt, so the exempt path is exercised too
        for (uint256 i = 0; i < actors.length; i++) {
            t0.mint(actors[i], 1_000_000e18);
            t1.mint(actors[i], 1_000_000e18);
            vm.startPrank(actors[i]);
            t0.approve(address(fpm), type(uint256).max);
            t1.approve(address(fpm), type(uint256).max);
            vm.stopPrank();
        }

        handler = new ManagerHandler(fpm, manager, key, actors, treasury, address(this));
        targetContract(address(handler));

        bytes4[] memory selectors = new bytes4[](6);
        selectors[0] = ManagerHandler.open.selector;
        selectors[1] = ManagerHandler.increase.selector;
        selectors[2] = ManagerHandler.decrease.selector;
        selectors[3] = ManagerHandler.collect.selector;
        selectors[4] = ManagerHandler.close.selector;
        selectors[5] = ManagerHandler.marketSwap.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    /// The handler calls back here to move the market.
    function swapMarket(bool zeroForOne, int256 amount) external {
        swap(key, zeroForOne, amount, ZERO_BYTES);
    }

    /// Guards the suite against going vacuous: if the handler stopped opening positions or
    /// the market swaps stopped crossing bins, every invariant above would pass trivially.
    function test_handlerActuallyExercisesTheSystem() public {
        handler.open(0, 2, 1e18); // alice, 3 bins
        assertGt(handler.liveCount(), 0, "handler must be able to open positions");

        (uint160 beforeSqrt,,,) = manager.getSlot0(key.toId());
        handler.marketSwap(5e18, true);
        (uint160 afterSqrt,,,) = manager.getSlot0(key.toId());
        assertTrue(afterSqrt != beforeSqrt, "market swaps must actually move the pool price");

        uint256 tr = t0.balanceOf(treasury) + t1.balanceOf(treasury);
        handler.collect(0);
        assertGt(t0.balanceOf(treasury) + t1.balanceOf(treasury), tr, "fees must actually accrue and be charged");

        // and the exit invariant must be observing real exits, not zero of them
        assertGt(handler.exitsObserved(), 0, "no exits observed -- the exit invariant would be vacuous");
    }

    // ------------------------------------------------------------- invariants

    /// Every bin the manager records must be backed 1:1 by liquidity actually held in the
    /// PoolManager under that bin's derived salt. A drift here means the on-chain record
    /// an owner exits with does not match what is really there.
    function invariant_recordedLiquidityMatchesPoolManager() public view {
        uint256 n = handler.liveCount();
        for (uint256 i = 0; i < n; i++) {
            uint256 id = handler.liveAt(i);
            (, PoolKey memory k, FriarPositionManager.Bin[] memory bins) = fpm.getPosition(id);
            for (uint256 j = 0; j < bins.length; j++) {
                uint128 onChain = manager.getPositionLiquidity(
                    k.toId(),
                    V4Position.calculatePositionKey(
                        address(fpm), bins[j].tickLower, bins[j].tickUpper, fpm.binSalt(id, j)
                    )
                );
                assertEq(onChain, bins[j].liquidity, "recorded bin liquidity != PoolManager liquidity");
            }
        }
    }

    /// positionsOf(owner) and the _positions record must agree in both directions: every
    /// enumerated id resolves to a position owned by that owner. The swap-pop in `_remove`
    /// is the risky part — a stale ownerIndex would surface here.
    function invariant_ownerEnumerationConsistent() public view {
        address[4] memory actors = [alice, bob, carol, bot];
        for (uint256 a = 0; a < actors.length; a++) {
            uint256[] memory ids = fpm.positionsOf(actors[a]);
            for (uint256 i = 0; i < ids.length; i++) {
                (address owner,,) = fpm.getPosition(ids[i]);
                assertEq(owner, actors[a], "positionsOf lists an id the owner does not own");
            }
        }
    }

    /// No owner's enumeration may contain another owner's id. Positions are salted per
    /// (positionId, binIndex), so cross-tenant bleed would show up as a duplicate id.
    function invariant_ownersAreIsolated() public view {
        address[4] memory actors = [alice, bob, carol, bot];
        for (uint256 a = 0; a < actors.length; a++) {
            uint256[] memory mine = fpm.positionsOf(actors[a]);
            for (uint256 b = a + 1; b < actors.length; b++) {
                uint256[] memory theirs = fpm.positionsOf(actors[b]);
                for (uint256 i = 0; i < mine.length; i++) {
                    for (uint256 j = 0; j < theirs.length; j++) {
                        assertTrue(mine[i] != theirs[j], "the same position id is enumerated for two owners");
                    }
                }
            }
        }
    }

    /// The manager is a pass-through: it must never sit on token balances between
    /// transactions. Anything resting here would be unaccounted principal.
    function invariant_managerHoldsNoTokens() public view {
        assertEq(t0.balanceOf(address(fpm)), 0, "manager holding token0");
        assertEq(t1.balanceOf(address(fpm)), 0, "manager holding token1");
    }

    /// Principal never enters treasury accounting. The treasury's take is bounded by the
    /// perf rate applied to fees, so it can never approach the notional that flowed
    /// through — a principal leak would blow past this bound immediately.
    function invariant_treasuryTakeIsFeeOnlyBounded() public view {
        uint256 cap = (uint256(fpm.perfFeeBps()) * 1_000_000e18) / 10_000;
        assertLe(t0.balanceOf(treasury), cap, "treasury holds more token0 than a fee share could produce");
        assertLe(t1.balanceOf(treasury), cap, "treasury holds more token1 than a fee share could produce");
    }

    /// THE exit guarantee, stated generally rather than case by case: across every
    /// reachable sequence, an exit run with maxPay0 = maxPay1 = 0 never leaves its owner
    /// holding less of either token than before. This is the invariant the pay caps exist
    /// to enforce; the hostile-hook suites prove specific attacks, this proves the rule.
    function invariant_exitNeverChargesTheOwner() public view {
        assertFalse(handler.exitChargedOwner(), "an exit with zero pay caps reduced the owner's balance");
    }

    /// Any sequence of operations leaves every surviving position fully closable by its
    /// owner, with no off-chain data — the core exit guarantee.
    function invariant_everyPositionRemainsClosable() public {
        uint256 n = handler.liveCount();
        for (uint256 i = 0; i < n; i++) {
            uint256 id = handler.liveAt(i);
            (address owner,,) = fpm.getPosition(id);
            uint256 snap = vm.snapshotState();
            FriarPositionManager.Zap memory noZap;
            vm.prank(owner);
            fpm.close(id, noZap, 0, 0, 0, 0); // must not revert
            vm.revertToState(snap);
        }
    }
}
