// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {Deployers} from "v4-core/test/utils/Deployers.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {LPFeeLibrary} from "v4-core/src/libraries/LPFeeLibrary.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";
import {ModifyLiquidityParams} from "v4-core/src/types/PoolOperation.sol";

import {FriarV2} from "../src/FriarV2.sol";

/// Tests concentrate on the two things that make V2 different from V1, plus the bounds
/// that keep a hostile pool creator harmless. The LB core itself is unchanged and is
/// already covered by FriarMath.t.sol.
contract FriarV2Test is Test, Deployers {
    bytes32 constant SWAP_TOPIC = keccak256("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)");

    int24 constant TICK_SPACING = 150; // Meteora migrants run bin step 100-150
    // 0.90%, independent of tick spacing. This is the shipping default: the surge adds a
    // base-independent ~12bps on routed flow, so break-even against a static 1% pool is a
    // 0.878% base. Below that the pool earns less than the static competitor it replaces.
    uint24 constant BASE_FEE_PIPS = 9000;

    FriarV2 friar;

    function _cfg() internal pure returns (FriarV2.PoolConfig memory) {
        return FriarV2.PoolConfig({
            baseFeePips: BASE_FEE_PIPS,
            filterFloor: 10, // == MIN_FILTER_FLOOR: degenerates to LB on dense flow
            filterCeil: 300,
            windowK: 3,
            decayPeriod: 600,
            reductionFactor: 5000,
            variableFeeControl: 40_000,
            // saturate the surge at a 70% price move, whatever the bin width
            maxVolatilityTicks: 7000,
            locked: false
        });
    }

    function setUp() public {
        deployFreshManagerAndRouters();
        deployMintAndApprove2Currencies();

        address flags = address(uint160(Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG));
        deployCodeTo("FriarV2.sol:FriarV2", abi.encode(manager, _cfg()), flags);
        friar = FriarV2(flags);

        (key,) = initPool(
            currency0, currency1, IHooks(address(friar)), LPFeeLibrary.DYNAMIC_FEE_FLAG, TICK_SPACING, SQRT_PRICE_1_1
        );
        modifyLiquidityRouter.modifyLiquidity(
            key, ModifyLiquidityParams({tickLower: -6000, tickUpper: 6000, liquidityDelta: 100e18, salt: 0}), ZERO_BYTES
        );
    }

    /// A PoolKey that has not been initialized, so config is still writable. Bounds tests
    /// must use this: `key` is live from setUp, so it would revert AlreadyLocked before
    /// validation ever runs.
    function _unlockedKey(int24 spacing) internal view returns (PoolKey memory) {
        return PoolKey({
            currency0: currency0,
            currency1: currency1,
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: spacing,
            hooks: IHooks(address(friar))
        });
    }

    function _swapAndGetFee(bool zeroForOne, int256 amountSpecified) internal returns (uint24 fee) {
        vm.recordLogs();
        swap(key, zeroForOne, amountSpecified, ZERO_BYTES);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = logs.length; i > 0; i--) {
            if (logs[i - 1].topics[0] == SWAP_TOPIC) {
                (,,,,, uint24 f) = abi.decode(logs[i - 1].data, (int128, int128, uint160, uint128, int24, uint24));
                return f;
            }
        }
        revert("no Swap event");
    }

    // ── the safety property ──────────────────────────────────────────────────
    // Measured on dense (3.7s-gap) flow: with no floor, whole-second timestamps let the
    // EWMA collapse, every swap re-anchors, and fee revenue halves versus LB's constant.
    // The floor is what makes adaptivity one-way. It must be unrepresentable to go below.

    function test_filterFloorBelowLBConstantIsRejected() public {
        FriarV2.PoolConfig memory c = _cfg();
        c.filterFloor = friar.MIN_FILTER_FLOOR() - 1;
        vm.expectRevert(FriarV2.InvalidParameters.selector);
        friar.setPoolConfig(_unlockedKey(80), c);
    }

    function testFuzz_windowNeverBelowFloor(uint32 gapSeconds) public {
        gapSeconds = uint32(bound(gapSeconds, 0, 100_000));
        PoolId id = key.toId();
        for (uint256 i = 0; i < 5; i++) {
            vm.warp(block.timestamp + gapSeconds);
            _swapAndGetFee(i % 2 == 0, -1e15);
            assertGe(friar.filterWindow(id), _cfg().filterFloor, "window dipped below floor");
            assertLe(friar.filterWindow(id), _cfg().filterCeil, "window exceeded ceiling");
        }
    }

    // ── adaptivity actually adapts ───────────────────────────────────────────

    function test_windowWidensOnSparseFlowAndFloorsOnDenseFlow() public {
        PoolId id = key.toId();
        assertEq(friar.filterWindow(id), 10, "cold start should sit at the floor");

        // sparse flow: 120s between swaps -> EWMA climbs -> window opens past the floor
        for (uint256 i = 0; i < 60; i++) {
            vm.warp(block.timestamp + 120);
            _swapAndGetFee(i % 2 == 0, -1e15);
        }
        uint16 sparseWindow = friar.filterWindow(id);
        assertGt(sparseWindow, 10, "sparse flow should widen the window past the floor");

        // dense flow: same-second swaps -> EWMA decays -> window returns to the floor
        for (uint256 i = 0; i < 200; i++) {
            _swapAndGetFee(i % 2 == 0, -1e15);
        }
        assertEq(friar.filterWindow(id), 10, "dense flow should collapse back to the floor, not below");
    }

    // ── base fee is decoupled from tick spacing ──────────────────────────────

    function test_sameBaseFeeAcrossDifferentTickSpacings() public {
        // V1's base fee was baseFactor x tickSpacing, so changing spacing changed the fee.
        // Here the same baseFeePips must survive a 10x change in bin width.
        (PoolKey memory wide,) = initPool(
            currency0, currency1, IHooks(address(friar)), LPFeeLibrary.DYNAMIC_FEE_FLAG, 600, SQRT_PRICE_1_1
        );
        modifyLiquidityRouter.modifyLiquidity(
            wide, ModifyLiquidityParams({tickLower: -6000, tickUpper: 6000, liquidityDelta: 100e18, salt: 0}), ZERO_BYTES
        );

        uint24 narrowFee = _swapAndGetFee(true, -1e15);

        vm.recordLogs();
        swap(wide, true, -1e15, ZERO_BYTES);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint24 wideFee;
        for (uint256 i = logs.length; i > 0; i--) {
            if (logs[i - 1].topics[0] == SWAP_TOPIC) {
                (,,,,, wideFee) = abi.decode(logs[i - 1].data, (int128, int128, uint160, uint128, int24, uint24));
                break;
            }
        }
        assertEq(narrowFee, BASE_FEE_PIPS, "narrow pool should charge exactly the configured base");
        assertEq(wideFee, BASE_FEE_PIPS, "wide pool should charge the same base despite 10x bin width");
    }

    /// The surge saturation point must be a PRICE move, not a bin count. LB's stock
    /// maxVolatilityAccumulator of 350_000 saturates at a 70% move on 200-tick bins but a
    /// 3.5% move on 10-tick bins — same config, 20x different behaviour, worst exactly
    /// where you want fine bins for concentration.
    function test_surgeSaturationIsSpacingInvariant() public view {
        uint24 coarse = friar.effectiveMaxVolatilityAccumulator(_unlockedKey(200));
        uint24 fine = friar.effectiveMaxVolatilityAccumulator(_unlockedKey(10));

        // 7000bps / 200 = 35 bins, x BASIS_POINT_MAX -> the historical LB value
        assertEq(coarse, 350_000, "200-tick pool should reproduce LB's stock ceiling");
        // 7000bps / 10 = 700 bins -> 20x the accumulator for the same 70% price move
        assertEq(fine, 7_000_000, "10-tick pool needs 20x the accumulator for the same move");
        assertEq(uint256(fine) * 10, uint256(coarse) * 200, "same price move, both spacings");
    }

    // ── config lifecycle ─────────────────────────────────────────────────────

    function test_configFreezesAtInitialize() public {
        FriarV2.PoolConfig memory c = _cfg();
        c.baseFeePips = 5000;
        vm.expectRevert(FriarV2.AlreadyLocked.selector);
        friar.setPoolConfig(key, c);
    }

    function test_uninitializedPoolTakesRegisteredConfigThenLocksIt() public {
        PoolKey memory fresh = PoolKey({
            currency0: currency0,
            currency1: currency1,
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: 120,
            hooks: IHooks(address(friar))
        });
        FriarV2.PoolConfig memory c = _cfg();
        c.baseFeePips = 8000; // 0.80%
        friar.setPoolConfig(fresh, c);

        manager.initialize(fresh, SQRT_PRICE_1_1);

        FriarV2.PoolConfig memory stored = friar.configOf(fresh.toId());
        assertEq(stored.baseFeePips, 8000, "registered config should survive initialize");
        assertTrue(stored.locked, "config should be frozen once the pool exists");
    }

    function test_poolWithNoRegisteredConfigUsesDefaults() public {
        PoolKey memory fresh = PoolKey({
            currency0: currency0,
            currency1: currency1,
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: 200,
            hooks: IHooks(address(friar))
        });
        manager.initialize(fresh, SQRT_PRICE_1_1);
        FriarV2.PoolConfig memory stored = friar.configOf(fresh.toId());
        assertEq(stored.baseFeePips, BASE_FEE_PIPS, "should fall back to the hook's defaults");
        assertTrue(stored.locked);
    }

    // ── review findings (2026-07-30 external review) ──────────────────────────

    /// HIGH, from review: an earlier design keyed config proposals by pool alone, so a
    /// searcher could run setPoolConfig + initialize ahead of the real creator and freeze
    /// THEIR parameters onto the pool permanently. Atomicity does not fix that — the
    /// attacker just executes the whole sequence first. Proposals are now keyed by
    /// registrant, so an attacker's proposal cannot attach to someone else's initialize.
    function test_attackerProposalCannotAttachToAnotherPartysPool() public {
        PoolKey memory fresh = _unlockedKey(120);
        address attacker = address(0xBAD);

        FriarV2.PoolConfig memory hostile = _cfg();
        hostile.baseFeePips = 100_000; // 10%, valid but ruinous for routing
        vm.prank(attacker);
        friar.setPoolConfig(fresh, hostile);

        // the honest creator initializes without registering anything
        manager.initialize(fresh, SQRT_PRICE_1_1);

        FriarV2.PoolConfig memory live = friar.configOf(fresh.toId());
        assertEq(live.baseFeePips, BASE_FEE_PIPS, "attacker's config must not attach");
        assertTrue(live.locked);
        // the attacker's proposal still exists, it just never applied
        assertEq(friar.pendingConfigOf(fresh.toId(), attacker).baseFeePips, 100_000);
    }

    function test_registrantsOwnProposalIsTheOneAdopted() public {
        PoolKey memory fresh = _unlockedKey(120);
        FriarV2.PoolConfig memory mine = _cfg();
        mine.baseFeePips = 5000;

        vm.prank(address(0xBAD));
        friar.setPoolConfig(fresh, _cfg()); // someone else's proposal, ignored

        friar.setPoolConfig(fresh, mine);
        manager.initialize(fresh, SQRT_PRICE_1_1); // this test contract is the initializer

        assertEq(friar.configOf(fresh.toId()).baseFeePips, 5000, "initializer's own proposal wins");
    }

    /// MEDIUM, from review: the first observation is initialize-to-first-swap, not an
    /// inter-swap gap. Seeding the EWMA with it let a pool created long before launch start
    /// pinned at the ceiling for hundreds of swaps (~117 for a 1h first gap, ~217 for 1d).
    function test_longIdleBeforeFirstSwapDoesNotPinTheWindowHigh() public {
        PoolKey memory fresh = _unlockedKey(120);
        friar.setPoolConfig(fresh, _cfg());
        manager.initialize(fresh, SQRT_PRICE_1_1);
        modifyLiquidityRouter.modifyLiquidity(
            fresh, ModifyLiquidityParams({tickLower: -6000, tickUpper: 6000, liquidityDelta: 100e18, salt: 0}), ZERO_BYTES
        );

        vm.warp(block.timestamp + 1 days); // pool sat idle between creation and launch
        swap(fresh, true, -1e15, ZERO_BYTES);

        assertEq(friar.filterWindow(fresh.toId()), _cfg().filterFloor, "first gap must not seed the window");
    }

    /// MEDIUM, from review: spacing-invariance holds only while the derived accumulator
    /// fits in uint24. At very fine spacings it clamps. Documented rather than fixed —
    /// raising it further would need a wider VolatilityState field.
    function test_smallSpacingsClampAndLoseInvariance() public view {
        uint24 cap = friar.MAX_VOLATILITY_ACCUMULATOR();
        assertEq(friar.effectiveMaxVolatilityAccumulator(_unlockedKey(10)), 7_000_000, "10-tick still exact");
        assertEq(friar.effectiveMaxVolatilityAccumulator(_unlockedKey(5)), 14_000_000, "5-tick still exact");
        // 7000 * 10_000 / 4 = 17.5M > uint24 max, so it clamps and saturates early
        assertEq(friar.effectiveMaxVolatilityAccumulator(_unlockedKey(4)), cap, "4-tick clamps");
        assertEq(friar.effectiveMaxVolatilityAccumulator(_unlockedKey(1)), cap, "1-tick clamps hard");
    }

    /// The floor invariant must survive arbitrary registration, ordering and gap sequences,
    /// not just the paths the other tests happen to walk.
    function testFuzz_windowFloorHoldsAcrossArbitraryConfigsAndGaps(
        uint16 floor_,
        uint16 ceil_,
        uint8 k,
        uint16 gap,
        uint8 nSwaps
    ) public {
        FriarV2.PoolConfig memory c = _cfg();
        c.filterFloor = uint16(bound(floor_, friar.MIN_FILTER_FLOOR(), 600));
        c.filterCeil = uint16(bound(ceil_, c.filterFloor, 600));
        c.windowK = uint8(bound(k, friar.MIN_WINDOW_K(), friar.MAX_WINDOW_K()));

        PoolKey memory fresh = _unlockedKey(120);
        friar.setPoolConfig(fresh, c);
        manager.initialize(fresh, SQRT_PRICE_1_1);
        modifyLiquidityRouter.modifyLiquidity(
            fresh, ModifyLiquidityParams({tickLower: -6000, tickUpper: 6000, liquidityDelta: 100e18, salt: 0}), ZERO_BYTES
        );

        for (uint256 i = 0; i < bound(nSwaps, 1, 12); i++) {
            vm.warp(block.timestamp + bound(gap, 0, 20_000));
            swap(fresh, i % 2 == 0, -1e15, ZERO_BYTES);
            uint16 w = friar.filterWindow(fresh.toId());
            assertGe(w, friar.MIN_FILTER_FLOOR(), "floor invariant broken");
            assertGe(w, c.filterFloor, "configured floor broken");
            assertLe(w, c.filterCeil, "ceiling broken");
            assertLe(w, c.decayPeriod, "window must never exceed decayPeriod");
        }
    }

    // ── EWMA state machine under explicit gap sequences (2nd review) ─────────

    function _freshPool(int24 spacing) internal returns (PoolKey memory p) {
        p = _unlockedKey(spacing);
        friar.setPoolConfig(p, _cfg());
        manager.initialize(p, SQRT_PRICE_1_1);
        modifyLiquidityRouter.modifyLiquidity(
            p, ModifyLiquidityParams({tickLower: -6000, tickUpper: 6000, liquidityDelta: 100e18, salt: 0}), ZERO_BYTES
        );
    }

    /// Walk the gap ladder the review asked for and record the window at each step. The
    /// window must track flow density monotonically-ish and never leave [floor, ceil].
    function test_windowTrajectoryAcrossGapLadder() public {
        PoolKey memory p = _freshPool(120);
        uint16[7] memory gaps = [uint16(0), 1, 3, 10, 57, 300, 1000];

        for (uint256 g = 0; g < gaps.length; g++) {
            for (uint256 i = 0; i < 40; i++) {
                vm.warp(block.timestamp + gaps[g]);
                swap(p, i % 2 == 0, -1e14, ZERO_BYTES);
            }
            uint16 w = friar.filterWindow(p.toId());
            assertGe(w, _cfg().filterFloor, "below floor");
            assertLe(w, _cfg().filterCeil, "above ceiling");
            // window should be ~3x the sustained gap, clamped
            uint256 want = uint256(gaps[g]) * _cfg().windowK;
            if (want < _cfg().filterFloor) want = _cfg().filterFloor;
            if (want > _cfg().filterCeil) want = _cfg().filterCeil;
            assertApproxEqAbs(w, want, want / 4 + 2, "window did not converge on 3x the sustained gap");
        }
    }

    /// Several swaps inside one block: gap is 0 every time, so the EWMA is dragged down and
    /// the window must sit exactly on the floor rather than underflowing it.
    ///
    /// The window must be genuinely ELEVATED first or this proves nothing. The very first
    /// observation is discarded by design (it is initialize-to-first-swap, not an
    /// inter-swap gap), so one long-gap swap seeds the EWMA at the floor and a burst from
    /// there would trivially "stay" on the floor.
    function test_sameBlockBurstPinsWindowToFloorNotBelow() public {
        PoolKey memory p = _freshPool(120);

        vm.warp(block.timestamp + 600);
        swap(p, true, -1e14, ZERO_BYTES); // discarded seed: does NOT elevate anything

        for (uint256 i = 0; i < 40; i++) {
            vm.warp(block.timestamp + 300); // sustained sparse flow actually raises the EWMA
            swap(p, i % 2 == 0, -1e14, ZERO_BYTES);
        }
        assertGt(friar.filterWindow(p.toId()), _cfg().filterFloor, "setup failed to elevate the window");

        // Each zero-gap fold multiplies the EWMA by 31/32, so collapsing from a 300s EWMA
        // to the floor takes ~142 swaps, not 100. Assert the floor holds at EVERY step, so
        // this catches an underflow mid-collapse rather than only at the end.
        uint16 prev = friar.filterWindow(p.toId());
        for (uint256 i = 0; i < 250; i++) {
            swap(p, i % 2 == 0, -1e14, ZERO_BYTES); // no warp: gap == 0
            uint16 w = friar.filterWindow(p.toId());
            assertGe(w, _cfg().filterFloor, "window underflowed the floor mid-collapse");
            assertLe(w, prev, "zero-gap flow must never widen the window");
            prev = w;
        }
        assertEq(prev, _cfg().filterFloor, "same-block burst must land on the floor");
    }

    /// The elevated tail both reviews flagged: longer windows mean the surge decays more
    /// slowly, so bound it. After a move, calm flow must return the fee to base within a
    /// stated wall-clock budget rather than "eventually".
    function test_timeToBaseIsBoundedAfterASurge() public {
        PoolKey memory p = _freshPool(120);
        vm.warp(block.timestamp + 30);
        swap(p, true, -1e14, ZERO_BYTES);

        // Move price hard enough to light the surge. The fee lags one swap, so the mover
        // itself is priced off the pre-move tick and the displacement only shows up on the
        // NEXT swap — which is why the surge has to be observed before timing its decay.
        //
        // Size deliberately: 5e17 moves only ~100 ticks against 1e20 of liquidity, under one
        // 120-tick bucket, so it crosses a boundary only when the pool happens to sit near
        // one. That makes the setup depend on price drift rather than on behaviour.
        swap(p, true, -5e18, ZERO_BYTES);

        vm.warp(block.timestamp + 30);
        uint24 surged = _swapFeeOn(p, true);
        assertGt(surged, BASE_FEE_PIPS, "setup failed to activate the surge; decay timing would be vacuous");
        assertGt(friar.volatilityState(p.toId()).volatilityAccumulator, 0, "accumulator not armed");

        uint256 start = block.timestamp;
        uint256 elapsed;
        for (uint256 i = 0; i < 400; i++) {
            vm.warp(block.timestamp + 30); // calm, regular flow
            uint24 fee = _swapFeeOn(p, i % 2 == 0);
            if (fee == BASE_FEE_PIPS) {
                elapsed = block.timestamp - start;
                break;
            }
        }
        assertGt(elapsed, 0, "fee never returned to base under calm flow");
        // measured at 150s with these defaults; 10 minutes leaves 4x headroom while still
        // being tight enough that a real regression in the decay path trips it
        assertLe(elapsed, 10 minutes, "elevated tail longer than the stated budget");
        emit log_named_uint("seconds of calm flow to return to base", elapsed);
    }

    function _swapFeeOn(PoolKey memory p, bool zeroForOne) internal returns (uint24) {
        return _swapFeeOnSized(p, zeroForOne, -1e14);
    }

    function _swapFeeOnSized(PoolKey memory p, bool zeroForOne, int256 amount) internal returns (uint24) {
        vm.recordLogs();
        swap(p, zeroForOne, amount, ZERO_BYTES);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = logs.length; i > 0; i--) {
            if (logs[i - 1].topics[0] == SWAP_TOPIC) {
                (,,,,, uint24 f) = abi.decode(logs[i - 1].data, (int128, int128, uint160, uint128, int24, uint24));
                return f;
            }
        }
        revert("no Swap event");
    }

    /// "Thin then suddenly active": a long silence arms a long window, and the review asked
    /// whether the first swap after silence re-anchors. It must, and the burst that follows
    /// then sits inside the long window (which is the intended behaviour: a pool that just
    /// woke up prices the wake-up move rather than sleeping through it).
    function test_silenceThenBurstReanchorsThenHoldsTheLongWindow() public {
        PoolKey memory p = _freshPool(120);
        vm.warp(block.timestamp + 30);
        swap(p, true, -1e14, ZERO_BYTES);
        for (uint256 i = 0; i < 40; i++) {
            vm.warp(block.timestamp + 300);
            swap(p, i % 2 == 0, -1e14, ZERO_BYTES);
        }
        assertEq(friar.filterWindow(p.toId()), _cfg().filterCeil, "sustained silence should arm the ceiling");

        // Fees lag one swap: beforeSwap reads the tick as it stood BEFORE the swap, so a
        // re-anchor always lands on the bucket price is already in. To observe the
        // reference actually moving, price has to move in one swap and the re-anchor
        // happen on the next.
        // ~5e18 against 1e20 of liquidity moves roughly 1000 ticks, i.e. 8+ buckets at
        // spacing 120. Sizing matters: 5e17 moves only ~100 ticks, which crosses a bucket
        // boundary only if the pool happens to sit near one, so it would make this test
        // pass or fail on where price drifted rather than on the behaviour under test.
        int24 refBefore = friar.volatilityState(p.toId()).bucketReference;
        swap(p, true, -5e18, ZERO_BYTES); // moves price several buckets; ref not yet updated
        assertEq(friar.volatilityState(p.toId()).bucketReference, refBefore, "ref moves on the NEXT swap, not this one");

        vm.warp(block.timestamp + 400); // > filterCeil, so the next swap re-anchors
        swap(p, true, -1e14, ZERO_BYTES);
        int24 refAfter = friar.volatilityState(p.toId()).bucketReference;
        assertTrue(refAfter != refBefore, "long silence must re-anchor onto the moved bucket");

        // Now burst in ONE direction at 1s gaps: far inside the long window, so no further
        // re-anchor happens, delta grows every swap, and the surge must actually build.
        uint24 first = _swapFeeOn(p, true);
        uint24 last = first;
        for (uint256 i = 0; i < 10; i++) {
            vm.warp(block.timestamp + 1);
            last = _swapFeeOnSized(p, true, -1e18); // large enough to keep crossing buckets
        }
        assertGt(last, BASE_FEE_PIPS, "burst inside a long window must build a surge, not sit at base");
        assertGt(last, first, "surge must grow across the burst");
        assertLe(last, 100_000, "cap");
    }

    // ── bounds: a hostile pool creator must stay harmless ────────────────────

    /// Fees are capped only by LB's own 10% ceiling, on purpose. Anything at or under it
    /// is a legitimate market choice (Meteora launch pools run double-digit base fees).
    function test_rejectsBaseFeeAboveTheLBCeiling() public {
        FriarV2.PoolConfig memory c = _cfg();
        c.baseFeePips = friar.MAX_BASE_FEE_PIPS() + 1;
        vm.expectRevert(FriarV2.InvalidParameters.selector);
        friar.setPoolConfig(_unlockedKey(80), c);
    }

    /// Regression: routing the base through LB's uint16 `baseFactor` silently capped the
    /// achievable fee at ~0.66% for 10-tick bins, which defeated the whole decoupling.
    /// A 10% base must work at the finest spacing.
    function test_maxBaseFeeWorksAtFineTickSpacing() public {
        PoolKey memory fine = _unlockedKey(10);
        FriarV2.PoolConfig memory c = _cfg();
        c.baseFeePips = friar.MAX_BASE_FEE_PIPS(); // 10%
        friar.setPoolConfig(fine, c);
        manager.initialize(fine, SQRT_PRICE_1_1);
        modifyLiquidityRouter.modifyLiquidity(
            fine, ModifyLiquidityParams({tickLower: -6000, tickUpper: 6000, liquidityDelta: 100e18, salt: 0}), ZERO_BYTES
        );

        vm.recordLogs();
        swap(fine, true, -1e15, ZERO_BYTES);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint24 fee;
        for (uint256 i = logs.length; i > 0; i--) {
            if (logs[i - 1].topics[0] == SWAP_TOPIC) {
                (,,,,, fee) = abi.decode(logs[i - 1].data, (int128, int128, uint160, uint128, int24, uint24));
                break;
            }
        }
        assertEq(fee, 100_000, "10% base must be expressible on 10-tick bins");
    }

    function test_rejectsWindowKOutOfRange() public {
        FriarV2.PoolConfig memory c = _cfg();
        c.windowK = friar.MIN_WINDOW_K() - 1;
        vm.expectRevert(FriarV2.InvalidParameters.selector);
        friar.setPoolConfig(_unlockedKey(80), c);

        c.windowK = friar.MAX_WINDOW_K() + 1;
        vm.expectRevert(FriarV2.InvalidParameters.selector);
        friar.setPoolConfig(_unlockedKey(80), c);
    }

    function test_rejectsCeilingAboveDecayPeriod() public {
        FriarV2.PoolConfig memory c = _cfg();
        c.filterCeil = c.decayPeriod + 1;
        vm.expectRevert(FriarV2.InvalidParameters.selector);
        friar.setPoolConfig(_unlockedKey(80), c);
    }

    function testFuzz_feeNeverExceedsLBCap(uint8 swaps, uint16 gap) public {
        swaps = uint8(bound(swaps, 1, 40));
        for (uint256 i = 0; i < swaps; i++) {
            vm.warp(block.timestamp + bound(gap, 0, 1000));
            uint24 fee = _swapAndGetFee(i % 2 == 0, -1e15);
            assertLe(fee, 100_000, "fee exceeded the LB 10% cap");
            assertGe(fee, BASE_FEE_PIPS, "fee fell below the configured base");
        }
    }
}
