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

/// @title FriarTier — a fixed-base-fee dynamic LP fee hook, one deployment per fee tier
/// @notice The same Liquidity Book volatility-accumulator mechanism and spacing-invariant
/// surge as `FriarV2`, but with the base fee moved from per-pool config to a single
/// IMMUTABLE set at deployment. That one change makes base fee part of a pool's on-chain
/// identity.
///
/// WHY A HOOK PER TIER. A v4 pool's identity is its PoolKey — `(currency0, currency1, fee,
/// tickSpacing, hooks)` — and for a dynamic-fee pool the `fee` field is pinned to the
/// dynamic flag, so the only fields free to distinguish two pools are `tickSpacing` and
/// `hooks`. `tickSpacing` is bin width. So a fee that is to be part of pool identity — a
/// pool that IS "the 5% pool", not "a pool that happens to have registered 5%" — has
/// nowhere to live but the hook address. FriarV2 put base fee in off-key config, which is
/// deliberately flexible but means (pair, spacing) is a single pool whose fee is whatever
/// its creator froze. Deploying this contract once per tier (0.30 / 0.80 / 1 / 2 / 5%)
/// makes each tier a distinct, immutable, individually-verifiable venue, and lets base fee
/// and bin width vary INDEPENDENTLY: the 5% hook at spacing 100 and the 0.30% hook at
/// spacing 100 are different pools, as are the 5% hook at spacing 100 and 160.
///
/// Everything else is FriarV2, kept because it is what makes one hook behave the same at
/// every spacing:
/// - The surge saturation point is specified in TICKS of price displacement and converted
///   per pool at swap time, so it is spacing-invariant. Without this, one hook used across
///   many spacings would surge inconsistently — the exact reason we do NOT reuse the v1
///   hooks, whose ceiling is in bin units.
/// - `filterPeriod` and the other LB parameters are hook-wide immutables here (not per
///   pool): every pool on a given tier hook shares them, and they default to LB's own
///   values. Per-pool tuning was FriarV2's feature and is exactly the config surface we are
///   dropping to buy identity.
///
/// Trust profile, unchanged and the whole point:
/// - Permission bits AFTER_INITIALIZE + BEFORE_SWAP only. The address proves this hook can
///   never take a swap delta, own liquidity, or block an exit.
/// - No owner, no admin, no upgradeability, no config. Nothing about a pool can be changed
///   after it initializes, by anyone, including us.
/// - No protocol fee. Everything charged is the LP fee, paid to the pool's LPs.
/// - A high base fee is a market choice a trader can see (the v4 quoter simulates hooks)
///   and route around; it is categorically different from a hook that can seize principal,
///   which this one structurally cannot.
///
/// Known LB deviation, inherited: a v4 hook returns one fee per swap decided in
/// `beforeSwap` from pre-swap state, so a swap's fee is independent of its own size and the
/// surge can be shed by splitting a trade. Measured cost on a routed pool is ~0.1% of surge
/// revenue. Documented, accepted, watched. See FriarV2 for the full reasoning.
contract FriarTier is IHooks {
    using LPFeeLibrary for uint24;
    using StateLibrary for IPoolManager;
    using FriarMath for FriarMath.VolatilityState;

    error NotPoolManager();
    error HookNotImplemented();
    error NotDynamicFeePool();
    error InvalidParameters();

    /// @dev The only ceiling on the base fee is LB's own total-fee cap, 10%. Our shipped
    /// tiers stop at 5%; the bound is here so a misconfigured deployment reverts rather than
    /// silently clamping.
    uint24 public constant MAX_BASE_FEE_PIPS = uint24(FriarMath.MAX_FEE_1E18 / 1e12);
    /// @dev Bound copied from LB's `setStaticFeeParameters` encoding.
    uint16 public constant MAX_DECAY_PERIOD = 4095;
    /// @dev `VolatilityState` holds the accumulator in a uint24 and the ceiling is specified
    /// in PRICE terms and converted per pool, so it is widened to the full uint24 —
    /// otherwise fine-binned pools would hit the storage bound long before the volatility
    /// they configured. Mirrors FriarV2.
    uint24 public constant MAX_VOLATILITY_ACCUMULATOR = type(uint24).max;
    /// @dev Largest saturation point expressible, in TICKS of price displacement. Ticks are
    /// logarithmic and asymmetric: 16_700 ticks is about +431% up / -81% down.
    uint24 public constant MAX_VOLATILITY_TICKS = 16_700;

    IPoolManager public immutable poolManager;

    /// @notice This hook's fee parameters, shared by every pool on it and frozen at deploy.
    /// `baseFeePips` is the tier; the rest are LB surge parameters. Base fee in v4 pips
    /// (1e6 = 100%), independent of tickSpacing.
    uint24 public immutable baseFeePips;
    uint16 public immutable filterPeriod;
    uint16 public immutable decayPeriod;
    uint16 public immutable reductionFactor;
    uint24 public immutable variableFeeControl;
    /// @dev Price displacement, in TICKS, at which the surge saturates. Converted to an
    /// accumulator ceiling per pool (`_lbParams`) using that pool's bin width, which is what
    /// makes the surge spacing-invariant.
    uint24 public immutable maxVolatilityTicks;

    mapping(PoolId => FriarMath.VolatilityState) internal _volatility;

    /// @notice The parameters a FriarTier is deployed with. `locked` is intentionally absent
    /// — there is no per-pool config to lock; the whole struct is immutable at the hook level.
    struct FeeParams {
        uint24 baseFeePips;
        uint16 filterPeriod;
        uint16 decayPeriod;
        uint16 reductionFactor;
        uint24 variableFeeControl;
        uint24 maxVolatilityTicks;
    }

    constructor(IPoolManager _poolManager, FeeParams memory p) {
        poolManager = _poolManager;
        _validate(p);
        baseFeePips = p.baseFeePips;
        filterPeriod = p.filterPeriod;
        decayPeriod = p.decayPeriod;
        reductionFactor = p.reductionFactor;
        variableFeeControl = p.variableFeeControl;
        maxVolatilityTicks = p.maxVolatilityTicks;
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

    function _validate(FeeParams memory p) internal pure {
        if (
            p.baseFeePips == 0 || p.baseFeePips > MAX_BASE_FEE_PIPS || p.filterPeriod == 0
                || p.decayPeriod > MAX_DECAY_PERIOD || p.filterPeriod > p.decayPeriod
                || p.reductionFactor > FriarMath.BASIS_POINT_MAX || p.maxVolatilityTicks == 0
                || p.maxVolatilityTicks > MAX_VOLATILITY_TICKS
        ) revert InvalidParameters();
    }

    // ─────────────────────────────────────────────────────────────── fee logic

    /// @dev LB params for a swap on this hook, at a given bin width. `baseFactor` is
    /// deliberately ZERO: LB derives base as `baseFactor × binStep`, the exact coupling this
    /// hook exists to avoid, so the base is applied directly in `_feeFor` and only the
    /// variable component comes from the library. `maxVolatilityTicks` is converted to a
    /// bin-unit accumulator ceiling here, per pool, which is the spacing-invariance.
    function _lbParams(uint16 binStep) internal view returns (FriarMath.Params memory) {
        uint256 maxVa = (uint256(maxVolatilityTicks) * FriarMath.BASIS_POINT_MAX) / binStep;
        if (maxVa > MAX_VOLATILITY_ACCUMULATOR) maxVa = MAX_VOLATILITY_ACCUMULATOR;
        return FriarMath.Params({
            baseFactor: 0,
            filterPeriod: filterPeriod,
            decayPeriod: decayPeriod,
            reductionFactor: reductionFactor,
            variableFeeControl: variableFeeControl,
            maxVolatilityAccumulator: uint24(maxVa)
        });
    }

    /// @dev base (immutable, spacing-independent) + LB variable, capped at LB's MAX_FEE.
    function _feeFor(FriarMath.Params memory p, uint24 va, uint16 binStep) internal view returns (uint24) {
        uint256 fee1e18 = uint256(baseFeePips) * 1e12 + FriarMath.variableFee1e18(p, va, binStep);
        if (fee1e18 > FriarMath.MAX_FEE_1E18) fee1e18 = FriarMath.MAX_FEE_1E18;
        return uint24(fee1e18 / 1e12);
    }

    /// @notice The fee (in pips) a swap would pay right now, for off-chain quoting.
    function previewFee(PoolKey calldata key) external view returns (uint24) {
        PoolId poolId = key.toId();
        (, int24 tick,,) = poolManager.getSlot0(poolId);

        uint16 binStep = _binStep(key.tickSpacing);
        FriarMath.Params memory p = _lbParams(binStep);
        FriarMath.VolatilityState memory vol = _volatility[poolId];
        vol.update(p, FriarMath.bucketOf(tick, key.tickSpacing), block.timestamp);

        return _feeFor(p, vol.volatilityAccumulator, binStep);
    }

    // ───────────────────────────────────────────────────────────────── hooks

    function afterInitialize(address, PoolKey calldata key, uint160, int24 tick)
        external
        onlyPoolManager
        returns (bytes4)
    {
        if (!key.fee.isDynamicFee()) revert NotDynamicFeePool();
        PoolId poolId = key.toId();

        _volatility[poolId] = FriarMath.VolatilityState({
            volatilityAccumulator: 0,
            volatilityReference: 0,
            bucketReference: FriarMath.bucketOf(tick, key.tickSpacing),
            lastUpdate: uint40(block.timestamp)
        });

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

    /// @dev Split out of `beforeSwap` to keep the stack shallow for the non-viaIR pipeline.
    function _accrueAndQuote(PoolKey calldata key) internal returns (uint24) {
        PoolId poolId = key.toId();
        uint16 binStep = _binStep(key.tickSpacing);
        FriarMath.Params memory p = _lbParams(binStep);

        FriarMath.VolatilityState memory vol = _volatility[poolId];
        {
            (, int24 tick,,) = poolManager.getSlot0(poolId);
            vol.update(p, FriarMath.bucketOf(tick, key.tickSpacing), block.timestamp);
        }
        _volatility[poolId] = vol;

        return _feeFor(p, vol.volatilityAccumulator, binStep);
    }

    function _binStep(int24 tickSpacing) internal pure returns (uint16) {
        // MAX_TICK_SPACING is 32767, so the cast is always safe.
        return uint16(uint24(tickSpacing));
    }

    /// @notice Current stored volatility state for a pool (as of its last swap).
    function volatilityState(PoolId poolId) external view returns (FriarMath.VolatilityState memory) {
        return _volatility[poolId];
    }

    /// @notice The accumulator ceiling this hook uses at a given bin width — the number that
    /// shows the saturation point is spacing-invariant. Needed by off-chain quoting/harness.
    function effectiveMaxVolatilityAccumulator(PoolKey calldata key) external view returns (uint24) {
        return _lbParams(_binStep(key.tickSpacing)).maxVolatilityAccumulator;
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
