// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {LPFeeLibrary} from "v4-core/src/libraries/LPFeeLibrary.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "v4-core/src/types/BeforeSwapDelta.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/src/types/PoolOperation.sol";

import {FriarMath} from "./FriarMath.sol";

/// @title FriarV2 — per-pool configurable, flow-adaptive dynamic LP fee hook
/// @notice Same Liquidity Book volatility-accumulator mechanism as `Friar` (LFJ
/// `lfj-gg/joe-v2`, MIT), with two changes, both driven by measurement on chain 4663
/// (see `notes/harness/gauntlet.mjs`, 2026-07-30):
///
/// 1. BASE FEE IS DECOUPLED FROM TICK SPACING. In v1 `base% = baseFactor × tickSpacing`,
///    so a 1% base forced 200-tick (2.02%-wide) bins. That is backwards: bin width should
///    be chosen for how finely LPs want to concentrate, and concentration near spot is the
///    whole advantage over a frozen full-range launchpad pool. Here `baseFeePips` is its
///    own per-pool parameter, so you can run 0.30% fees with 0.1%-wide bins.
///
/// 2. THE FILTER WINDOW ADAPTS TO OBSERVED FLOW. LB uses a constant `filterPeriod`. A
///    constant cannot fit both a routed pool (swaps ~10s apart, bursting to ~1s) and a
///    thin one (~57s apart): on the thin pool the reference re-anchors on nearly every
///    swap, the accumulator never builds, and the surge never fires. The window here is
///    `clamp(k × EWMA(gap), filterFloor, filterCeil)`.
///
/// CRITICAL SAFETY PROPERTY: `filterFloor >= MIN_FILTER_FLOOR`, so the window can only
/// ever be LONGER than LB's constant, never shorter. Adaptivity is one-way. Measured on
/// a dense pool (3.7s gaps) with the floor removed, whole-second timestamps let the EWMA
/// collapse to zero, every swap re-anchored, and fee revenue HALVED versus the constant.
/// With the floor in place the design degenerates to exactly v1 behaviour on dense flow
/// and beats it by 8% (routed) to 36% (thin) elsewhere, while taking 1.75x to 31x longer
/// to grind the fee back down to base.
///
/// Trust profile is unchanged from v1 and is the point of the whole design:
/// - Permission bits: AFTER_INITIALIZE + BEFORE_SWAP only. The address proves this hook
///   can never take swap deltas, own liquidity, or touch LP principal.
/// - No owner, no admin, no upgradeability. Per-pool config is write-once and is frozen
///   the moment the pool initializes.
/// - No protocol fee. Everything charged is the LP fee, paid to the pool's LPs.
/// - Fee level is deliberately NOT capped below LB's own 10% ceiling. A high fee is a
///   market choice: traders see it (the v4 quoter simulates hooks) and can route around
///   it, and Meteora pools routinely run double-digit base fees on volatile launches.
///   What this hook guarantees is categorically different and is proven by its address:
///   it can never take a swap delta, own liquidity, or block an exit. Contrast CashCatHook
///   on this chain, whose `beforeRemoveLiquidity` reverts unconditionally — that traps
///   principal, which no fee level can do.
///
/// KNOWN LIMITATION, accepted: the EWMA counts SWAPS, not economic volume, so dust flow
/// can steer the window. Sustained dust drags it toward the floor and erases much of the
/// adaptive uplift; an idle period arms a long one. Gas is ~$0.0003 a swap on this chain,
/// so that steering is cheap. It cannot make the hook less safe than LB's constant, since
/// the floor is a hard clamp and the constant IS the floor, but everything gained above
/// the floor is manipulable by a determined party. Volume-weighting the EWMA would fix it
/// and costs another storage word; revisit if a pool is observed being farmed this way.
///
/// Known deviation from Liquidity Book, inherited from v1 and unfixable inside v4: LB
/// escalates the fee per bin crossed *within* a swap, whereas a v4 hook returns exactly
/// one fee per swap, decided in `beforeSwap` from state as it stood before it. So a swap's
/// fee is independent of its own size, and a trade can be split (small leg to walk price
/// onto the reference, then a large leg at base fee) to shed the surge. Measured cost of
/// that on a routed pool: the reversion leg costs ~$7.3k, only 0.1% of swaps are large
/// enough to profit, and total surge revenue falls 0.1%. Documented, accepted, watched.
contract FriarV2 is IHooks {
    using LPFeeLibrary for uint24;
    using StateLibrary for IPoolManager;
    using FriarMath for FriarMath.VolatilityState;

    error NotPoolManager();
    error HookNotImplemented();
    error NotDynamicFeePool();
    error InvalidParameters();
    error AlreadyLocked();

    /// @dev The LB constant this hook is allowed to lengthen but never undercut. This is
    /// the safety property; do not lower it without re-running the dense-flow gauntlet.
    uint16 public constant MIN_FILTER_FLOOR = 10;
    /// @dev The only ceiling on the base fee is LB's own total-fee cap, 10%. There is no
    /// policy cap on top of it, deliberately: a high fee is a market choice that hurts
    /// traders (who can see it, since the v4 quoter simulates hooks) and helps LPs, and
    /// Meteora pools routinely run double-digit base fees on volatile launches. It is a
    /// different kind of thing from a hook that can seize principal, which this one
    /// structurally cannot. Capping fees would restrict honest pools without preventing
    /// the one real attack (a front-run config registration), which atomic
    /// setPoolConfig+initialize is what actually defends against.
    uint24 public constant MAX_BASE_FEE_PIPS = uint24(FriarMath.MAX_FEE_1E18 / 1e12);
    /// @dev Bound copied from LB's `setStaticFeeParameters` encoding.
    uint16 public constant MAX_DECAY_PERIOD = 4095;
    /// @dev LB stores the accumulator in a uint20 (1_048_575). `VolatilityState` here holds
    /// a uint24, and the cap is now specified in PRICE terms and converted per pool, so the
    /// ceiling is widened to the full uint24 — otherwise fine-binned pools would hit the
    /// storage bound long before the volatility they actually configured.
    uint24 public constant MAX_VOLATILITY_ACCUMULATOR = type(uint24).max;
    /// @dev Largest saturation point expressible, in TICKS of price displacement.
    /// Ticks are logarithmic and asymmetric: 16_700 ticks is 1.0001^16700, about +431%
    /// up or -81% down. Do not read these as linear percentages.
    uint24 public constant MAX_VOLATILITY_TICKS = 16_700;
    /// @dev Window multiplier bounds. k must exceed 1 or a swap arriving at the typical
    /// gap would re-anchor every time, which is the degenerate case the floor guards.
    uint8 public constant MIN_WINDOW_K = 2;
    uint8 public constant MAX_WINDOW_K = 8;
    /// @dev EWMA smoothing is a shift: alpha = 1/32, i.e. halfLife ~= 21.8 swaps. Gaps are
    /// held at 1/256-second precision so the shift does not truncate short gaps to nothing.
    uint8 internal constant EWMA_SHIFT = 5;
    uint8 internal constant GAP_SCALE_SHIFT = 8;

    /// @notice Per-pool fee configuration. Packs into a single storage slot (145 bits).
    struct PoolConfig {
        uint24 baseFeePips; // base fee in v4 pips (1e6 = 100%), independent of tickSpacing
        uint16 filterFloor; // shortest the adaptive window may ever be, >= MIN_FILTER_FLOOR
        uint16 filterCeil; // longest it may be; <= decayPeriod
        uint8 windowK; // window = k × EWMA(gap)
        uint16 decayPeriod; // LB decayPeriod
        uint16 reductionFactor; // LB reductionFactor, bps
        uint24 variableFeeControl; // LB variableFeeControl
        // Price displacement, in TICKS, at which the surge saturates. LB expresses this
        // ceiling in BIN units, which silently makes surge behaviour depend on tick
        // spacing: the stock 350_000 saturates 20x sooner on 10-tick bins than on
        // 200-tick bins. Expressing it in ticks and converting per pool makes it
        // spacing-invariant, which is the point of decoupling fees from bin width.
        //
        // Ticks are logarithmic, so this is NOT a symmetric percentage: 7_000 ticks is
        // about +101% upward and -50% downward, not "70%".
        //
        // CAVEAT: the derived accumulator is uint24, so below roughly 5-tick spacing the
        // conversion clamps and spacing-invariance stops holding. See
        // test_smallSpacingsClampAndLoseInvariance.
        uint24 maxVolatilityTicks;
        bool locked; // set true by afterInitialize; config is immutable thereafter
    }

    IPoolManager public immutable poolManager;

    /// @notice Defaults applied when a pool initializes with no registered config.
    PoolConfig public defaultConfig;

    mapping(PoolId => FriarMath.VolatilityState) internal _volatility;
    /// @dev The frozen config, written once by `afterInitialize`.
    mapping(PoolId => PoolConfig) internal _config;
    /// @dev Proposals, keyed by REGISTRANT as well as pool. A pool adopts the proposal made
    /// by whoever actually initializes it, so nobody can impose a config on anybody else.
    mapping(PoolId => mapping(address => PoolConfig)) internal _pending;
    /// @dev EWMA of inter-swap gaps, in seconds << GAP_SCALE_SHIFT.
    mapping(PoolId => uint32) internal _ewmaGap;

    event PoolConfigured(PoolId indexed poolId, address indexed registrant, PoolConfig config);
    event PoolConfigLocked(PoolId indexed poolId, PoolConfig config);

    constructor(IPoolManager _poolManager, PoolConfig memory _defaultConfig) {
        poolManager = _poolManager;
        _validate(_defaultConfig);
        _defaultConfig.locked = false;
        defaultConfig = _defaultConfig;
        Hooks.validateHookPermissions(this, getHookPermissions());
    }

    modifier onlyPoolManager() {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        _;
    }

    function getHookPermissions() public pure returns (Hooks.Permissions memory) {
        return Hooks.Permissions({
            beforeInitialize: false,
            afterInitialize: true,
            beforeAddLiquidity: false,
            afterAddLiquidity: false,
            beforeRemoveLiquidity: false,
            afterRemoveLiquidity: false,
            beforeSwap: true,
            afterSwap: false,
            beforeDonate: false,
            afterDonate: false,
            beforeSwapReturnDelta: false,
            afterSwapReturnDelta: false,
            afterAddLiquidityReturnDelta: false,
            afterRemoveLiquidityReturnDelta: false
        });
    }

    // ─────────────────────────────────────────────────────────── configuration

    /// @notice Propose fee parameters for a pool that has not initialized yet. The pool
    /// adopts the proposal registered by WHOEVER INITIALIZES IT, so this is a proposal
    /// under your own address, not a claim on the pool.
    ///
    /// v4 removed `hookData` from `initialize`, and `LPFeeLibrary.isDynamicFee` is a strict
    /// `fee == DYNAMIC_FEE_FLAG`, so there is no room in the PoolKey to carry parameters
    /// and pre-registration is the only route left.
    ///
    /// Keying by registrant is what makes that safe. An earlier design keyed proposals by
    /// pool alone, which meant a searcher could run `setPoolConfig` + `initialize` ahead of
    /// you and permanently freeze THEIR parameters onto the pool you were creating —
    /// atomicity does not help, because the attacker simply executes the whole sequence
    /// first. Now the worst a front-runner achieves is creating the pool at a price of
    /// their choosing under their own config, which is a property of permissionless
    /// `PoolManager.initialize` that every v4 pool already has, hook or no hook.
    ///
    /// Callers must still verify the frozen config and the initial price before depositing
    /// into a pool they did not create.
    function setPoolConfig(PoolKey calldata key, PoolConfig calldata cfg) external {
        PoolId poolId = key.toId();
        if (_config[poolId].locked) revert AlreadyLocked();
        _validate(cfg);

        PoolConfig memory stored = cfg;
        stored.locked = false;
        _pending[poolId][msg.sender] = stored;
        emit PoolConfigured(poolId, msg.sender, stored);
    }

    /// @notice The configuration a pool is using. Before initialization this is the
    /// default, since which proposal wins is not known until someone initializes.
    function configOf(PoolId poolId) public view returns (PoolConfig memory cfg) {
        cfg = _config[poolId];
        if (!cfg.locked) cfg = defaultConfig;
    }

    /// @notice A specific registrant's pending proposal for a pool, if any.
    function pendingConfigOf(PoolId poolId, address registrant) external view returns (PoolConfig memory) {
        return _pending[poolId][registrant];
    }

    function _validate(PoolConfig memory c) internal pure {
        if (
            c.baseFeePips == 0 || c.baseFeePips > MAX_BASE_FEE_PIPS || c.filterFloor < MIN_FILTER_FLOOR
                || c.filterCeil < c.filterFloor || c.decayPeriod > MAX_DECAY_PERIOD || c.filterCeil > c.decayPeriod
                || c.reductionFactor > FriarMath.BASIS_POINT_MAX || c.maxVolatilityTicks == 0
                || c.maxVolatilityTicks > MAX_VOLATILITY_TICKS || c.windowK < MIN_WINDOW_K || c.windowK > MAX_WINDOW_K
        ) revert InvalidParameters();
    }

    // ─────────────────────────────────────────────────────────────── fee logic

    /// @notice The adaptive filter window for a pool right now, in seconds.
    /// @dev `clamp(k × EWMA(gap), floor, ceil)`. Because floor >= MIN_FILTER_FLOOR this can
    /// only ever be longer than LB's constant.
    function filterWindow(PoolId poolId) public view returns (uint16) {
        return _window(configOf(poolId), _ewmaGap[poolId]);
    }

    /// @dev Pure form, so the swap path can reuse the config and EWMA it has already read
    /// instead of paying for the same two slots twice.
    function _window(PoolConfig memory c, uint32 ewma) internal pure returns (uint16) {
        // Clamp locally rather than trusting the writer. Every path that can set a config
        // today runs _validate, but this turns "all current writers preserve the floor"
        // into "no writer can break it", which is the property the design actually rests on.
        uint16 floor_ = c.filterFloor < MIN_FILTER_FLOOR ? MIN_FILTER_FLOOR : c.filterFloor;
        uint16 ceil_ = c.filterCeil < floor_ ? floor_ : c.filterCeil;
        if (ewma == 0) return floor_;
        uint256 w = (uint256(c.windowK) * ewma) >> GAP_SCALE_SHIFT;
        if (w < floor_) return floor_;
        if (w > ceil_) return ceil_;
        return uint16(w);
    }

    /// @dev LB params for a pool, with `filterPeriod` replaced by the adaptive window.
    /// Injecting it here is what lets the audited FriarMath core stay byte-for-byte
    /// unchanged: the library never learns that the window moves.
    ///
    /// `baseFactor` is deliberately ZERO. LB derives its base fee as
    /// `baseFactor × binStep`, which is exactly the coupling this contract exists to
    /// break, and routing a decoupled fee back through it would reintroduce a hidden
    /// ceiling (baseFactor is uint16, so at binStep 10 the largest expressible base fee
    /// would be 0.66%). The base is applied directly in `_feeFor` instead, and only the
    /// variable component comes from the library.
    function _lbParams(PoolConfig memory c, uint16 window, uint16 binStep)
        internal
        pure
        returns (FriarMath.Params memory)
    {
        // bins = ticks / binStep, and the accumulator counts bins x BASIS_POINT_MAX
        uint256 maxVa = (uint256(c.maxVolatilityTicks) * FriarMath.BASIS_POINT_MAX) / binStep;
        if (maxVa > MAX_VOLATILITY_ACCUMULATOR) maxVa = MAX_VOLATILITY_ACCUMULATOR;
        return FriarMath.Params({
            baseFactor: 0,
            filterPeriod: window,
            decayPeriod: c.decayPeriod,
            reductionFactor: c.reductionFactor,
            variableFeeControl: c.variableFeeControl,
            maxVolatilityAccumulator: uint24(maxVa)
        });
    }

    /// @dev base (per-pool, spacing-independent) + LB variable, capped at LB's MAX_FEE.
    function _feeFor(PoolConfig memory c, FriarMath.Params memory p, uint24 va, uint16 binStep)
        internal
        pure
        returns (uint24)
    {
        uint256 fee1e18 = uint256(c.baseFeePips) * 1e12 + FriarMath.variableFee1e18(p, va, binStep);
        if (fee1e18 > FriarMath.MAX_FEE_1E18) fee1e18 = FriarMath.MAX_FEE_1E18;
        return uint24(fee1e18 / 1e12);
    }

    /// @dev EWMA update: `ewma += (gap - ewma) >> 5`, gaps scaled by 256. Integer-only.
    /// Takes `prev` rather than re-reading it, so the swap path pays for one read.
    ///
    /// The first observation is deliberately DISCARDED. It is not an inter-swap gap, it is
    /// initialize-to-first-swap, and a pool created long before its launch would otherwise
    /// seed the EWMA at the ceiling. Because descending from a huge seed takes far longer
    /// than the ~22-swap half-life suggests (a 1-hour first gap needs ~117 swaps to fall
    /// below the ceiling, a 1-day gap ~217), the seed is set so the window starts at
    /// exactly `filterFloor` and the SECOND swap supplies the first real gap.
    function _foldGap(PoolConfig memory c, uint32 prev, uint256 gapSeconds) internal pure returns (uint32) {
        if (prev == 0) return uint32((uint256(c.filterFloor) << GAP_SCALE_SHIFT) / c.windowK);
        uint256 scaled = gapSeconds << GAP_SCALE_SHIFT;
        if (scaled > type(uint32).max) scaled = type(uint32).max;
        if (scaled >= prev) return uint32(prev + ((scaled - prev) >> EWMA_SHIFT));
        return uint32(prev - ((prev - scaled) >> EWMA_SHIFT));
    }

    /// @notice The fee (in pips) a swap would pay right now, for off-chain quoting.
    function previewFee(PoolKey calldata key) external view returns (uint24) {
        PoolId poolId = key.toId();
        (, int24 tick,,) = poolManager.getSlot0(poolId);

        PoolConfig memory c = configOf(poolId);
        FriarMath.Params memory p = _lbParams(c, _window(c, _ewmaGap[poolId]), _binStep(key.tickSpacing));
        FriarMath.VolatilityState memory vol = _volatility[poolId];
        vol.update(p, FriarMath.bucketOf(tick, key.tickSpacing), block.timestamp);

        return _feeFor(c, p, vol.volatilityAccumulator, _binStep(key.tickSpacing));
    }

    // ───────────────────────────────────────────────────────────────── hooks

    function afterInitialize(address sender, PoolKey calldata key, uint160, int24 tick)
        external
        onlyPoolManager
        returns (bytes4)
    {
        if (!key.fee.isDynamicFee()) revert NotDynamicFeePool();
        PoolId poolId = key.toId();

        // Adopt the initializer's own proposal, or the defaults. Re-validated here as
        // defence in depth: this is the single place a config becomes permanent, and the
        // floor invariant is load-bearing enough to be worth paying for once per pool.
        PoolConfig memory c = _pending[poolId][sender];
        if (c.baseFeePips == 0) c = defaultConfig;
        _validate(c);
        c.locked = true;
        _config[poolId] = c;

        _volatility[poolId] = FriarMath.VolatilityState({
            volatilityAccumulator: 0,
            volatilityReference: 0,
            bucketReference: FriarMath.bucketOf(tick, key.tickSpacing),
            lastUpdate: uint40(block.timestamp)
        });

        emit PoolConfigLocked(poolId, c);
        return IHooks.afterInitialize.selector;
    }

    function beforeSwap(address, PoolKey calldata key, SwapParams calldata, bytes calldata)
        external
        onlyPoolManager
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        uint24 fee = _accrueAndQuote(key);
        return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, fee | LPFeeLibrary.OVERRIDE_FEE_FLAG);
    }

    /// @dev Split out of `beforeSwap` purely to keep the stack shallow enough for the
    /// non-viaIR pipeline the rest of this repo builds with.
    function _accrueAndQuote(PoolKey calldata key) internal returns (uint24) {
        PoolId poolId = key.toId();
        uint16 binStep = _binStep(key.tickSpacing);

        // The window is read from gap history as it stood BEFORE this swap. Folding this
        // swap's own gap in first would let a trader's timing steer the window that prices
        // its own trade, which is the manipulation the floor exists to bound.
        PoolConfig memory c = configOf(poolId);
        uint32 ewma = _ewmaGap[poolId];
        FriarMath.Params memory p = _lbParams(c, _window(c, ewma), binStep);

        FriarMath.VolatilityState memory vol = _volatility[poolId];
        uint256 gap = block.timestamp - vol.lastUpdate;
        {
            (, int24 tick,,) = poolManager.getSlot0(poolId);
            vol.update(p, FriarMath.bucketOf(tick, key.tickSpacing), block.timestamp);
        }
        _volatility[poolId] = vol;
        _ewmaGap[poolId] = _foldGap(c, ewma, gap);

        return _feeFor(c, p, vol.volatilityAccumulator, binStep);
    }

    function _binStep(int24 tickSpacing) internal pure returns (uint16) {
        // MAX_TICK_SPACING is 32767, so the cast is always safe.
        return uint16(uint24(tickSpacing));
    }

    /// @notice Current stored volatility state for a pool (as of its last swap).
    function volatilityState(PoolId poolId) external view returns (FriarMath.VolatilityState memory) {
        return _volatility[poolId];
    }

    /// @notice The accumulator ceiling this pool actually uses, derived from its
    /// configured `maxVolatilityTicks` at its own bin width. Exposed because off-chain
    /// quoting and the fee harness need the same number the hook uses, and because it is
    /// the value that shows the saturation point is now spacing-invariant.
    function effectiveMaxVolatilityAccumulator(PoolKey calldata key) external view returns (uint24) {
        return _lbParams(configOf(key.toId()), 0, _binStep(key.tickSpacing)).maxVolatilityAccumulator;
    }

    /// @notice Current EWMA of inter-swap gaps, in seconds (truncated).
    function ewmaGapSeconds(PoolId poolId) external view returns (uint256) {
        return _ewmaGap[poolId] >> GAP_SCALE_SHIFT;
    }

    // ───────────────────────────────────────────────── unimplemented callbacks

    function beforeInitialize(address, PoolKey calldata, uint160) external pure returns (bytes4) {
        revert HookNotImplemented();
    }

    function beforeAddLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        revert HookNotImplemented();
    }

    function afterAddLiquidity(
        address,
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure returns (bytes4, BalanceDelta) {
        revert HookNotImplemented();
    }

    function beforeRemoveLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        revert HookNotImplemented();
    }

    function afterRemoveLiquidity(
        address,
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure returns (bytes4, BalanceDelta) {
        revert HookNotImplemented();
    }

    function afterSwap(address, PoolKey calldata, SwapParams calldata, BalanceDelta, bytes calldata)
        external
        pure
        returns (bytes4, int128)
    {
        revert HookNotImplemented();
    }

    function beforeDonate(address, PoolKey calldata, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        revert HookNotImplemented();
    }

    function afterDonate(address, PoolKey calldata, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        revert HookNotImplemented();
    }
}
