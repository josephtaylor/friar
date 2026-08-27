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
            filterPeriod: 10, // LB's own value; the app never varies it
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

    // ── adaptivity actually adapts ───────────────────────────────────────────

    // ── base fee is decoupled from tick spacing ──────────────────────────────

    function test_sameBaseFeeAcrossDifferentTickSpacings() public {
        // V1's base fee was baseFactor x tickSpacing, so changing spacing changed the fee.
        // Here the same baseFeePips must survive a 10x change in bin width.
        (PoolKey memory wide,) =
            initPool(currency0, currency1, IHooks(address(friar)), LPFeeLibrary.DYNAMIC_FEE_FLAG, 600, SQRT_PRICE_1_1);
        modifyLiquidityRouter.modifyLiquidity(
            wide,
            ModifyLiquidityParams({tickLower: -6000, tickUpper: 6000, liquidityDelta: 100e18, salt: 0}),
            ZERO_BYTES
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
        // the attacker's proposal never applied, and once the pool is locked it reports
        // empty too, since no proposal can ever be adopted after the freeze
        assertEq(friar.pendingConfigOf(fresh.toId(), attacker).baseFeePips, 0, "dead proposal must report empty");
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

    // ── EWMA state machine under explicit gap sequences (2nd review) ─────────

    function _freshPool(int24 spacing) internal returns (PoolKey memory p) {
        p = _unlockedKey(spacing);
        friar.setPoolConfig(p, _cfg());
        manager.initialize(p, SQRT_PRICE_1_1);
        modifyLiquidityRouter.modifyLiquidity(
            p, ModifyLiquidityParams({tickLower: -6000, tickUpper: 6000, liquidityDelta: 100e18, salt: 0}), ZERO_BYTES
        );
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

    // ── config lifecycle, per the external lifecycle review ──────────────────

    function test_sameRegistrantOverwritesItsOwnProposal() public {
        PoolKey memory k = _unlockedKey(120);
        FriarV2.PoolConfig memory a = _cfg();
        a.baseFeePips = 4000;
        friar.setPoolConfig(k, a);
        a.baseFeePips = 6000;
        friar.setPoolConfig(k, a);
        assertEq(friar.pendingConfigOf(k.toId(), address(this)).baseFeePips, 6000, "latest valid write wins");

        manager.initialize(k, SQRT_PRICE_1_1);
        assertEq(friar.configOf(k.toId()).baseFeePips, 6000, "and it is the one adopted");
    }

    function test_invalidOverwriteRevertsAndPreservesThePreviousProposal() public {
        PoolKey memory k = _unlockedKey(120);
        FriarV2.PoolConfig memory good = _cfg();
        good.baseFeePips = 4000;
        friar.setPoolConfig(k, good);

        FriarV2.PoolConfig memory bad = good;
        bad.filterPeriod = 0; // a zero filter period is rejected
        vm.expectRevert(FriarV2.InvalidParameters.selector);
        friar.setPoolConfig(k, bad);

        assertEq(friar.pendingConfigOf(k.toId(), address(this)).baseFeePips, 4000, "rejected write must not clobber");
    }

    function test_initializationBlocksEveryRegistrantNotJustTheWinner() public {
        PoolKey memory k = _unlockedKey(120);
        manager.initialize(k, SQRT_PRICE_1_1);

        vm.expectRevert(FriarV2.AlreadyLocked.selector);
        friar.setPoolConfig(k, _cfg());

        vm.prank(address(0xBAD)); // a registrant who never proposed anything before
        vm.expectRevert(FriarV2.AlreadyLocked.selector);
        friar.setPoolConfig(k, _cfg());
    }

    /// `locked` is caller-supplied in the struct, so a proposal claiming to be already
    /// frozen must be normalised rather than trusted.
    function test_callerSuppliedLockedIsNormalised() public {
        PoolKey memory k = _unlockedKey(120);
        FriarV2.PoolConfig memory c = _cfg();
        c.locked = true; // a lie
        friar.setPoolConfig(k, c);
        assertFalse(friar.pendingConfigOf(k.toId(), address(this)).locked, "proposal must be stored unlocked");

        manager.initialize(k, SQRT_PRICE_1_1);
        assertTrue(friar.configOf(k.toId()).locked, "and locked only by adoption");
    }

    /// Once frozen, the encoded config must never change again, whatever anyone does.
    function testFuzz_frozenConfigIsImmutable(uint24 base, uint16 filter_) public {
        PoolKey memory key_ = _unlockedKey(120);
        manager.initialize(key_, SQRT_PRICE_1_1);
        bytes32 frozen = keccak256(abi.encode(friar.configOf(key_.toId())));

        FriarV2.PoolConfig memory c = _cfg();
        c.baseFeePips = uint24(bound(base, 1, friar.MAX_BASE_FEE_PIPS()));
        c.filterPeriod = uint16(bound(filter_, 1, 600));

        vm.expectRevert(FriarV2.AlreadyLocked.selector);
        friar.setPoolConfig(key_, c);
        assertEq(keccak256(abi.encode(friar.configOf(key_.toId()))), frozen, "frozen config mutated");
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
            fine,
            ModifyLiquidityParams({tickLower: -6000, tickUpper: 6000, liquidityDelta: 100e18, salt: 0}),
            ZERO_BYTES
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
