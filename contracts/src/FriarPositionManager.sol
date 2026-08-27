// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {CurrencySettler} from "./CurrencySettler.sol";
import {TransientStateLibrary} from "v4-core/src/libraries/TransientStateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {IConfigurableFeeHook} from "./interfaces/IConfigurableFeeHook.sol";
import {IFeeExemptionRegistry} from "./interfaces/IFeeExemptionRegistry.sol";

/// @notice Multi-tenant position manager: opens/closes a whole Position (N bins) as one
/// atomic unit inside a single PoolManager unlock. Anyone may open; only the position
/// owner may increase/decrease/collect/close. Every verb supports a no-swap path and a
/// swap path (swap-in on open/increase: quote -> inventory funds the ask bins; zap-out
/// on decrease/collect/close: inventory -> quote in the same unlock).
///
/// The full position definition (owner + pool key + bins) lives on-chain: an owner can
/// exit knowing only the positionId, with no dependency on any off-chain service.
///
/// Fee share: a slice of fees earned (v4's `feesAccrued`, reported separately from
/// principal by modifyLiquidity) is taken in-kind to the treasury whenever fees are
/// collected — `simpleFeeBps` for single-bin ("simple") positions, `perfFeeBps` for
/// shaped (multi-bin) ones. A position's bin count is fixed at open, so its rate is
/// fixed for life. Principal is never touched. Both rates are immutable; the treasury
/// address (two-step transferable) is the only privileged state. `perfFeeExempt` (the
/// house bot) pays no fee. Payouts always go to the position owner — never a third address.
contract FriarPositionManager is IUnlockCallback {
    using CurrencySettler for Currency;
    using TransientStateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;

    error NotPoolManager();
    error NotPositionOwner();
    error UnknownPosition();
    error NativeCurrencyUnsupported();
    error HookConfigNotApplied();
    error VenueMismatch();
    error InvalidBins();
    error LengthMismatch();
    error DecreaseExceedsLiquidity();
    error SwapInsufficientOutput();
    error PaidTooMuch();
    error ReceivedTooLittle();
    error NotTreasury();
    error NotPendingTreasury();
    error PerfFeeTooHigh();
    error InvalidStartingPositionId();
    error ZeroTreasury();
    error ZeroFeeExemptionRegistry();

    uint256 public constant MAX_BINS = 100;
    uint256 public constant MAX_PERF_FEE_BPS = 2_000; // hard sanity cap: 20%
    uint256 internal constant BPS = 10_000;

    IPoolManager public immutable manager;
    /// @notice fee share (bps of fees earned) for shaped — multi-bin — positions.
    uint16 public immutable perfFeeBps;
    /// @notice fee share (bps of fees earned) for simple — single-bin — positions.
    uint16 public immutable simpleFeeBps;
    /// @notice fee-exempt accounts (house bot, partners). Treasury-controlled: a
    /// discount-only power — it can never raise fees or touch principal. Checked at
    /// operation time, so changes apply to existing positions' future collections.
    /// @notice Shared, cross-generation exemption list. Immutable by design: redeploying
    /// the manager is already the upgrade path, so a mutable pointer would add far more
    /// authority than a discount list warrants.
    IFeeExemptionRegistry public immutable feeExemptionRegistry;
    address public treasury;
    address public pendingTreasury;

    struct Bin {
        int24 tickLower;
        int24 tickUpper;
        uint128 liquidity;
    }

    struct Position {
        address owner;
        uint96 ownerIndex; // index into _ownerIds[owner]
        PoolKey key;
        Bin[] bins;
    }

    /// @dev Entry swap: spend `amountIn` of one side to fund the other before minting.
    struct SwapIn {
        bool enabled;
        PoolKey venue; // must share both currencies with the position's pool
        bool zeroForOne;
        uint256 amountIn;
        uint256 minAmountOut;
        // 0 = swap the whole `amountIn` (limit at MIN/MAX, legacy behavior). Non-zero =
        // stop the swap at this sqrt price. Lets an open first slide a stale/empty pool to
        // the live market price (an empty pool moves to the limit for ~free) before minting.
        uint160 sqrtPriceLimitX96;
    }

    /// @dev Exit swap: convert the whole positive credit of the input side to the other
    /// side in the same unlock. Output floor is enforced by the verb's min amounts.
    struct Zap {
        bool enabled;
        PoolKey venue; // must share both currencies with the position's pool
        bool zeroForOne;
    }

    enum Action {
        Open,
        Increase,
        Decrease,
        Collect
    }

    struct BinDelta {
        int24 tickLower;
        int24 tickUpper;
        int256 liquidityDelta;
        bytes32 salt;
    }

    struct Op {
        Action action;
        uint256 positionId;
        address account; // position owner: sole payer and sole payout recipient
        uint16 feeBps; // resolved at verb entry: 0 when exempt, else simple/perf rate by bin count
        PoolKey key;
        BinDelta[] bins;
        SwapIn swapIn;
        Zap zap;
    }

    /// @dev Slippage bounds for an exit. Grouped so the verbs stay under the stack limit.
    /// `maxPay` is what keeps a hostile zap venue from turning an exit into a withdrawal
    /// from the owner's wallet: `_resolve` settles any negative delta via transferFrom,
    /// and a venue hook may return an unbounded swap delta.
    struct Bounds {
        uint256 minReceive0;
        uint256 minReceive1;
        uint256 maxPay0;
        uint256 maxPay1;
    }

    /// @dev delta0/delta1: the owner's net cash flow (positive = received, negative = paid).
    struct OpResult {
        int256 delta0;
        int256 delta1;
        uint256 fees0;
        uint256 fees1;
        uint256 perf0;
        uint256 perf1;
    }

    mapping(uint256 => Position) internal _positions;
    mapping(address => uint256[]) internal _ownerIds;
    /// @notice Next id to mint. Set at construction so a redeployed manager can continue
    /// past a previous deployment's ids instead of reusing them — position history is
    /// indexed off-chain by id, and colliding ids would clobber it.
    uint256 public nextPositionId;

    event PositionOpened(
        uint256 indexed positionId,
        address indexed owner,
        bytes32 indexed poolId,
        PoolKey key,
        Bin[] bins,
        int256 delta0,
        int256 delta1
    );
    event PositionIncreased(
        uint256 indexed positionId,
        uint128[] liquidityDeltas,
        int256 delta0,
        int256 delta1,
        uint256 fees0,
        uint256 fees1
    );
    event PositionDecreased(
        uint256 indexed positionId,
        uint128[] liquidityDeltas,
        int256 delta0,
        int256 delta1,
        uint256 fees0,
        uint256 fees1,
        bool closed
    );
    event FeesCollected(uint256 indexed positionId, uint256 fees0, uint256 fees1, int256 delta0, int256 delta1);
    event PerfFeeCharged(uint256 indexed positionId, address indexed treasury, uint256 perf0, uint256 perf1);
    event TreasuryTransferStarted(address indexed from, address indexed to);
    event TreasuryTransferred(address indexed from, address indexed to);

    constructor(
        IPoolManager _manager,
        uint16 _perfFeeBps,
        uint16 _simpleFeeBps,
        address _treasury,
        IFeeExemptionRegistry _feeExemptionRegistry,
        uint256 _startingPositionId
    ) {
        if (_perfFeeBps > MAX_PERF_FEE_BPS || _simpleFeeBps > MAX_PERF_FEE_BPS) {
            revert PerfFeeTooHigh();
        }
        if (_startingPositionId == 0) revert InvalidStartingPositionId();
        // A zero treasury would send every perf fee to address(0) — burned, unrecoverable,
        // and unfixable since `treasury` is only reachable through the two-step transfer
        // (which itself can never RESULT in zero: `acceptTreasury` sets treasury to
        // msg.sender, and address(0) cannot originate a transaction, so `setTreasury(0)`
        // merely cancels a pending handover). The constructor is the only way in.
        if (_treasury == address(0)) revert ZeroTreasury();
        nextPositionId = _startingPositionId;
        manager = _manager;
        perfFeeBps = _perfFeeBps;
        simpleFeeBps = _simpleFeeBps;
        treasury = _treasury;
        if (address(_feeExemptionRegistry) == address(0)) revert ZeroFeeExemptionRegistry();
        feeExemptionRegistry = _feeExemptionRegistry;
    }

    // ---------------------------------------------------------------- verbs

    /// @notice Mint all bins atomically and record the position. `maxPay0/1` cap what
    /// the caller can be charged. With `swapIn`, ask-side inventory is funded by an
    /// in-unlock swap and any surplus sweeps back to the caller. The pool must already
    /// be initialized — to create it and seed it in one transaction, use `openNew`.
    function open(PoolKey calldata key, Bin[] calldata bins, SwapIn calldata swapIn, uint256 maxPay0, uint256 maxPay1)
        external
        returns (uint256 positionId)
    {
        return _open(key, bins, swapIn, maxPay0, maxPay1);
    }

    /// @notice Create the pool at `sqrtPriceX96` and open the first position, atomically.
    /// Reverts (`PoolAlreadyInitialized`) if the pool exists — the chosen price is then
    /// stale, so re-quote against the live pool and call `open` instead. The first LP
    /// sets the pool price unilaterally: seed at market or be arbitrage food.
    function openNew(
        PoolKey calldata key,
        uint160 sqrtPriceX96,
        Bin[] calldata bins,
        SwapIn calldata swapIn,
        uint256 maxPay0,
        uint256 maxPay1
    ) external returns (uint256 positionId) {
        manager.initialize(key, sqrtPriceX96);
        return _open(key, bins, swapIn, maxPay0, maxPay1);
    }

    /// @notice Create a pool with NON-DEFAULT hook parameters and open a position in it,
    /// in one transaction.
    ///
    /// Needed because hooks with per-pool parameters (v4 has no `hookData` at initialize)
    /// key their proposals by registrant, and for a manager-created pool the registrant is
    /// THIS CONTRACT, not the caller. A user who registers a config from their own wallet
    /// and then calls `openNew` would silently get hook defaults. See
    /// `IConfigurableFeeHook`.
    ///
    /// The hook call is typed, not raw calldata: this contract holds user approvals, so an
    /// arbitrary-call primitive is not worth the flexibility.
    ///
    /// ABI COMPATIBILITY IS NOT SEMANTIC COMPATIBILITY. A hook matching this signature only
    /// proves it can RECEIVE the call, not that it honoured it — a different hook may
    /// accept the config and ignore it, or adopt it under different rules. So the frozen
    /// config is read back after initialization and compared, which catches an honest
    /// mismatch. It does NOT defend against a hook that lies in `configOf` as well; a
    /// caller who has chosen to supply a hostile hook is outside this contract's
    /// guarantees either way, and their exposure is bounded by `maxPay0/1`.
    ///
    /// This does not make you the pool's creator in any privileged sense. Nothing can:
    /// `PoolManager.initialize` is permissionless, so somebody may always initialize a
    /// given PoolKey before you, at a price and config of their choosing. If that has
    /// already happened, this reverts — against a hook that freezes config at
    /// initialization the revert normally comes from `setPoolConfig` rejecting a write to
    /// an already-locked pool, before `initialize` is even reached — and no funds move.
    function openNewConfigured(
        PoolKey calldata key,
        uint160 sqrtPriceX96,
        IConfigurableFeeHook.PoolConfig calldata cfg,
        Bin[] calldata bins,
        SwapIn calldata swapIn,
        uint256 maxPay0,
        uint256 maxPay1
    ) external returns (uint256 positionId) {
        IConfigurableFeeHook(address(key.hooks)).setPoolConfig(key, cfg);
        manager.initialize(key, sqrtPriceX96);
        _assertConfigApplied(key, cfg);
        return _open(key, bins, swapIn, maxPay0, maxPay1);
    }

    /// @dev Read the frozen config back and require it matches what was asked for, with
    /// `locked` normalised since the hook sets it during adoption.
    function _assertConfigApplied(PoolKey calldata key, IConfigurableFeeHook.PoolConfig calldata cfg) internal view {
        IConfigurableFeeHook.PoolConfig memory got = IConfigurableFeeHook(address(key.hooks)).configOf(key.toId());
        IConfigurableFeeHook.PoolConfig memory want = cfg;
        want.locked = true;
        if (keccak256(abi.encode(got)) != keccak256(abi.encode(want))) revert HookConfigNotApplied();
    }

    function _open(PoolKey calldata key, Bin[] calldata bins, SwapIn calldata swapIn, uint256 maxPay0, uint256 maxPay1)
        internal
        returns (uint256 positionId)
    {
        if (Currency.unwrap(key.currency0) == address(0)) revert NativeCurrencyUnsupported();
        uint256 n = bins.length;
        if (n == 0 || n > MAX_BINS) revert InvalidBins();

        positionId = nextPositionId++;
        Position storage p = _positions[positionId];
        p.owner = msg.sender;
        p.key = key;

        BinDelta[] memory deltas = new BinDelta[](n);
        for (uint256 i = 0; i < n; i++) {
            Bin calldata b = bins[i];
            if (b.liquidity == 0) revert InvalidBins();
            p.bins.push(b);
            deltas[i] = BinDelta(b.tickLower, b.tickUpper, int256(uint256(b.liquidity)), binSalt(positionId, i));
        }
        _ownerIds[msg.sender].push(positionId);
        p.ownerIndex = uint96(_ownerIds[msg.sender].length - 1);

        Zap memory noZap;
        OpResult memory r =
            _run(Op(Action.Open, positionId, msg.sender, _feeRate(msg.sender, n), key, deltas, swapIn, noZap));
        _checkPay(r, maxPay0, maxPay1);

        emit PositionOpened(positionId, msg.sender, PoolId.unwrap(key.toId()), key, bins, r.delta0, r.delta1);
        _emitPerfFee(positionId, r);
    }

    /// @notice Add liquidity to existing bins (entry per bin; 0 = leave untouched).
    /// Fees on touched bins are auto-collected by v4 and charged like any collection.
    function increase(
        uint256 positionId,
        uint128[] calldata liquidityDeltas,
        SwapIn calldata swapIn,
        uint256 maxPay0,
        uint256 maxPay1
    ) external {
        Position storage p = _requireOwner(positionId);
        uint256 n = p.bins.length;
        if (liquidityDeltas.length != n) revert LengthMismatch();

        BinDelta[] memory deltas;
        {
            uint256 m;
            for (uint256 i = 0; i < n; i++) {
                if (p.bins[i].liquidity > 0 || liquidityDeltas[i] > 0) m++;
            }
            deltas = new BinDelta[](m);
        }
        {
            uint256 k;
            for (uint256 i = 0; i < n; i++) {
                uint128 d = liquidityDeltas[i];
                Bin storage b = p.bins[i];
                if (b.liquidity == 0 && d == 0) continue; // v4 rejects a 0-delta poke on an empty position
                if (d > 0) b.liquidity += d;
                deltas[k++] = BinDelta(b.tickLower, b.tickUpper, int256(uint256(d)), binSalt(positionId, i));
            }
        }

        Zap memory noZap;
        OpResult memory r =
            _run(Op(Action.Increase, positionId, msg.sender, _feeRate(msg.sender, n), p.key, deltas, swapIn, noZap));
        _checkPay(r, maxPay0, maxPay1);

        emit PositionIncreased(positionId, liquidityDeltas, r.delta0, r.delta1, r.fees0, r.fees1);
        _emitPerfFee(positionId, r);
    }

    /// @notice Remove liquidity (amount per bin). Removing everything deletes the
    /// record. `minReceive0/1` floor the owner's net receipts (post-perf fee, post-zap);
    /// `maxPay0/1` cap what the exit may charge the owner (pass 0 for the normal case —
    /// an exit that pays out on both sides).
    function decrease(
        uint256 positionId,
        uint128[] calldata liquidityDeltas,
        Zap calldata zap,
        uint256 minReceive0,
        uint256 minReceive1,
        uint256 maxPay0,
        uint256 maxPay1
    ) external {
        Position storage p = _requireOwner(positionId);
        uint256 n = p.bins.length;
        if (liquidityDeltas.length != n) revert LengthMismatch();
        uint128[] memory ds = new uint128[](n);
        for (uint256 i = 0; i < n; i++) {
            ds[i] = liquidityDeltas[i];
        }
        _decrease(positionId, p, ds, zap, Bounds(minReceive0, minReceive1, maxPay0, maxPay1));
    }

    /// @notice Exit knowing only the positionId: removes all remaining liquidity using
    /// the on-chain record. No bins, no off-chain data, no backend required.
    function close(
        uint256 positionId,
        Zap calldata zap,
        uint256 minReceive0,
        uint256 minReceive1,
        uint256 maxPay0,
        uint256 maxPay1
    ) external {
        Position storage p = _requireOwner(positionId);
        uint256 n = p.bins.length;
        uint128[] memory ds = new uint128[](n);
        for (uint256 i = 0; i < n; i++) {
            ds[i] = p.bins[i].liquidity;
        }
        _decrease(positionId, p, ds, zap, Bounds(minReceive0, minReceive1, maxPay0, maxPay1));
    }

    /// @notice Claim fees without touching liquidity (a 0-delta poke on every bin).
    /// Fee amounts don't depend on price, so no-zap collection needs no floors; with a
    /// zap the floors guard the swap output and `maxPay0/1` cap what it may charge.
    function collect(
        uint256 positionId,
        Zap calldata zap,
        uint256 minReceive0,
        uint256 minReceive1,
        uint256 maxPay0,
        uint256 maxPay1
    ) external {
        Position storage p = _requireOwner(positionId);
        uint256 n = p.bins.length;

        BinDelta[] memory deltas;
        {
            uint256 m;
            for (uint256 i = 0; i < n; i++) {
                if (p.bins[i].liquidity > 0) m++;
            }
            deltas = new BinDelta[](m);
        }
        {
            uint256 k;
            for (uint256 i = 0; i < n; i++) {
                Bin storage b = p.bins[i];
                if (b.liquidity == 0) continue; // an emptied bin holds no fees and cannot be poked
                deltas[k++] = BinDelta(b.tickLower, b.tickUpper, 0, binSalt(positionId, i));
            }
        }

        SwapIn memory noSwapIn;
        OpResult memory r =
            _run(Op(Action.Collect, positionId, msg.sender, _feeRate(msg.sender, n), p.key, deltas, noSwapIn, zap));
        _checkReceive(r, minReceive0, minReceive1);
        _checkPay(r, maxPay0, maxPay1);

        emit FeesCollected(positionId, r.fees0, r.fees1, r.delta0, r.delta1);
        _emitPerfFee(positionId, r);
    }

    // ------------------------------------------------------------- treasury

    function setTreasury(address newTreasury) external {
        if (msg.sender != treasury) revert NotTreasury();
        pendingTreasury = newTreasury;
        emit TreasuryTransferStarted(treasury, newTreasury);
    }

    function acceptTreasury() external {
        if (msg.sender != pendingTreasury) revert NotPendingTreasury();
        emit TreasuryTransferred(treasury, msg.sender);
        treasury = msg.sender;
        pendingTreasury = address(0);
    }

    // ---------------------------------------------------------------- views

    function getPosition(uint256 positionId)
        external
        view
        returns (address owner, PoolKey memory key, Bin[] memory bins)
    {
        Position storage p = _positions[positionId];
        if (p.owner == address(0)) revert UnknownPosition();
        return (p.owner, p.key, p.bins);
    }

    function positionsOf(address owner) external view returns (uint256[] memory) {
        return _ownerIds[owner];
    }

    /// @dev Salts are pure-derivable so any indexer can compute v4 position keys.
    function binSalt(uint256 positionId, uint256 index) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(positionId, index));
    }

    // ------------------------------------------------------------- internal

    function _requireOwner(uint256 positionId) internal view returns (Position storage p) {
        p = _positions[positionId];
        if (p.owner == address(0)) revert UnknownPosition();
        if (p.owner != msg.sender) revert NotPositionOwner();
    }

    /// @dev Fee rate for an operation: exempt accounts pay nothing; single-bin ("simple")
    /// positions pay simpleFeeBps; shaped (multi-bin) positions pay perfFeeBps.
    function _feeRate(address account, uint256 binCount) internal view returns (uint16) {
        if (_isExempt(account)) return 0;
        return binCount == 1 ? simpleFeeBps : perfFeeBps;
    }

    /// @dev A registry failure must never trap funds. Defaulting to NOT exempt means the
    /// worst case is that someone pays the manager's own immutable rate, which is the same
    /// bounded harm the treasury already has; the alternative would let a reverting
    /// registry block every collect and close.
    function _isExempt(address account) internal view returns (bool) {
        try feeExemptionRegistry.isExempt(account) returns (bool exempt) {
            return exempt;
        } catch {
            return false;
        }
    }

    function _decrease(
        uint256 positionId,
        Position storage p,
        uint128[] memory liquidityDeltas,
        Zap calldata zap,
        Bounds memory bounds
    ) internal {
        uint256 n = p.bins.length;
        bool anyLeft = false;
        BinDelta[] memory deltas;
        {
            uint256 m;
            for (uint256 i = 0; i < n; i++) {
                if (p.bins[i].liquidity > 0) m++;
            }
            deltas = new BinDelta[](m);
        }
        {
            uint256 k;
            for (uint256 i = 0; i < n; i++) {
                uint128 d = liquidityDeltas[i];
                Bin storage b = p.bins[i];
                if (d > b.liquidity) revert DecreaseExceedsLiquidity();
                if (b.liquidity == 0) continue; // already emptied — v4 rejects a 0-delta poke here
                b.liquidity -= d;
                if (b.liquidity > 0) anyLeft = true;
                deltas[k++] = BinDelta(b.tickLower, b.tickUpper, -int256(uint256(d)), binSalt(positionId, i));
            }
        }

        SwapIn memory noSwapIn;
        OpResult memory r =
            _run(Op(Action.Decrease, positionId, msg.sender, _feeRate(msg.sender, n), p.key, deltas, noSwapIn, zap));
        _checkReceive(r, bounds.minReceive0, bounds.minReceive1);
        _checkPay(r, bounds.maxPay0, bounds.maxPay1);

        bool closed = !anyLeft;
        emit PositionDecreased(positionId, liquidityDeltas, r.delta0, r.delta1, r.fees0, r.fees1, closed);
        _emitPerfFee(positionId, r);
        if (closed) _remove(positionId, p);
    }

    function _remove(uint256 positionId, Position storage p) internal {
        uint256[] storage ids = _ownerIds[p.owner];
        uint256 idx = p.ownerIndex;
        uint256 last = ids[ids.length - 1];
        if (last != positionId) {
            ids[idx] = last;
            _positions[last].ownerIndex = uint96(idx);
        }
        ids.pop();
        delete _positions[positionId];
    }

    function _run(Op memory op) internal returns (OpResult memory r) {
        if (op.swapIn.enabled) _requireSameCurrencies(op.key, op.swapIn.venue);
        if (op.zap.enabled) _requireSameCurrencies(op.key, op.zap.venue);
        r = abi.decode(manager.unlock(abi.encode(op)), (OpResult));
    }

    function _requireSameCurrencies(PoolKey memory key, PoolKey memory venue) internal pure {
        if (
            Currency.unwrap(key.currency0) != Currency.unwrap(venue.currency0)
                || Currency.unwrap(key.currency1) != Currency.unwrap(venue.currency1)
        ) revert VenueMismatch();
    }

    function _checkPay(OpResult memory r, uint256 maxPay0, uint256 maxPay1) internal pure {
        if (r.delta0 < 0 && uint256(-r.delta0) > maxPay0) revert PaidTooMuch();
        if (r.delta1 < 0 && uint256(-r.delta1) > maxPay1) revert PaidTooMuch();
    }

    function _checkReceive(OpResult memory r, uint256 minReceive0, uint256 minReceive1) internal pure {
        uint256 got0 = r.delta0 > 0 ? uint256(r.delta0) : 0;
        uint256 got1 = r.delta1 > 0 ? uint256(r.delta1) : 0;
        if (got0 < minReceive0 || got1 < minReceive1) revert ReceivedTooLittle();
    }

    function _emitPerfFee(uint256 positionId, OpResult memory r) internal {
        if (r.perf0 > 0 || r.perf1 > 0) emit PerfFeeCharged(positionId, treasury, r.perf0, r.perf1);
    }

    // ------------------------------------------------------------- callback

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(manager)) revert NotPoolManager();
        Op memory op = abi.decode(data, (Op));
        OpResult memory r;

        if (op.swapIn.enabled) {
            manager.swap(
                op.swapIn.venue,
                SwapParams({
                    zeroForOne: op.swapIn.zeroForOne,
                    amountSpecified: -int256(op.swapIn.amountIn),
                    sqrtPriceLimitX96: op.swapIn.sqrtPriceLimitX96 != 0
                        ? op.swapIn.sqrtPriceLimitX96
                        : (op.swapIn.zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1)
                }),
                ""
            );
            Currency swapOut = op.swapIn.zeroForOne ? op.swapIn.venue.currency1 : op.swapIn.venue.currency0;
            if (manager.currencyDelta(address(this), swapOut) < int256(op.swapIn.minAmountOut)) {
                revert SwapInsufficientOutput();
            }
        }

        for (uint256 i = 0; i < op.bins.length; i++) {
            BinDelta memory b = op.bins[i];
            (, BalanceDelta feesAccrued) = manager.modifyLiquidity(
                op.key,
                ModifyLiquidityParams({
                    tickLower: b.tickLower, tickUpper: b.tickUpper, liquidityDelta: b.liquidityDelta, salt: b.salt
                }),
                ""
            );
            int128 f0 = feesAccrued.amount0();
            int128 f1 = feesAccrued.amount1();
            if (f0 > 0) r.fees0 += uint256(uint128(f0));
            if (f1 > 0) r.fees1 += uint256(uint128(f1));
        }

        if (op.feeBps > 0) {
            r.perf0 = (r.fees0 * op.feeBps) / BPS;
            r.perf1 = (r.fees1 * op.feeBps) / BPS;
            if (r.perf0 > 0) op.key.currency0.take(manager, treasury, r.perf0, false);
            if (r.perf1 > 0) op.key.currency1.take(manager, treasury, r.perf1, false);
        }

        if (op.zap.enabled) {
            Currency zapIn = op.zap.zeroForOne ? op.zap.venue.currency0 : op.zap.venue.currency1;
            int256 credit = manager.currencyDelta(address(this), zapIn);
            if (credit > 0) {
                manager.swap(
                    op.zap.venue,
                    SwapParams({
                        zeroForOne: op.zap.zeroForOne,
                        amountSpecified: -credit,
                        sqrtPriceLimitX96: op.zap.zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
                    }),
                    ""
                );
            }
        }

        r.delta0 = _resolve(op.key.currency0, op.account);
        r.delta1 = _resolve(op.key.currency1, op.account);
        return abi.encode(r);
    }

    /// @dev Settle what the account owes / take what the account is due. The account is
    /// always the position owner: funds can never be directed anywhere else.
    function _resolve(Currency currency, address account) internal returns (int256 delta) {
        delta = manager.currencyDelta(address(this), currency);
        if (delta < 0) {
            currency.settle(manager, account, uint256(-delta), false);
        } else if (delta > 0) {
            currency.take(manager, account, uint256(delta), false);
        }
    }
}
