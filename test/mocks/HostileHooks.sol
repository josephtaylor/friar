// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {BaseTestHooks} from "v4-core/src/test/BaseTestHooks.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {BalanceDelta, toBalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "v4-core/src/types/BeforeSwapDelta.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/src/types/PoolOperation.sol";

/// @notice A swap-fee hook with NO bound on the fee.
///
/// Structurally identical to v4-core's own `FeeTakingHook` (the canonical, legitimate
/// pattern: `take` inside `afterSwap` to create a hook debit, then return the delta so
/// core credits it back — netting zero for the hook and charging the swapper). The only
/// difference is that the "fee" here is an absolute amount set by the attacker rather
/// than a small share of the swap.
///
/// That equivalence is the point: on Robinhood Chain the dominant launchpad hook holds
/// `afterSwapReturnsDelta` too, so no address-bit screen can separate this from an honest
/// venue. Only a bound on what the owner can be charged can.
contract UnboundedFeeHook is BaseTestHooks {
    IPoolManager public immutable manager;
    uint256 public grab;

    constructor(IPoolManager _manager) {
        manager = _manager;
    }

    function setGrab(uint256 g) external {
        grab = g;
    }

    function afterSwap(address, PoolKey calldata key, SwapParams calldata params, BalanceDelta, bytes calldata)
        external
        override
        returns (bytes4, int128)
    {
        require(msg.sender == address(manager), "not manager");
        if (grab == 0) return (IHooks.afterSwap.selector, int128(0));
        // the hook's delta always lands on the swap's UNSPECIFIED currency
        bool specifiedTokenIs0 = (params.amountSpecified < 0 == params.zeroForOne);
        Currency feeCurrency = specifiedTokenIs0 ? key.currency1 : key.currency0;
        manager.take(feeCurrency, address(this), grab);
        return (IHooks.afterSwap.selector, int128(int256(grab)));
    }
}

/// @notice A hook on the POSITION'S OWN pool that takes an unbounded delta from the
/// caller during `modifyLiquidity` — on adds, on removes, or both.
///
/// This is a different surface from `UnboundedFeeHook`: that one attacks the zap venue's
/// swap, this one attacks the liquidity operation itself, so it reaches `open`, `increase`,
/// `decrease`, `close` AND the fee poke inside `collect` — including exits that use no zap
/// at all. The app's `classifyHook` blocks remove-liquidity hooks outright, but the
/// manager is permissionless, so the bound has to hold on-chain regardless.
contract UnboundedLiquidityFeeHook is BaseTestHooks {
    IPoolManager public immutable manager;
    uint256 public grabOnAdd;
    uint256 public grabOnRemove;

    constructor(IPoolManager _manager) {
        manager = _manager;
    }

    function setGrabs(uint256 onAdd, uint256 onRemove) external {
        grabOnAdd = onAdd;
        grabOnRemove = onRemove;
    }

    function _take(PoolKey calldata key, uint256 amount) internal returns (BalanceDelta) {
        if (amount == 0) return BalanceDelta.wrap(0);
        // take now (hook debit), return the delta (core credits it back) -> the CALLER pays
        manager.take(key.currency1, address(this), amount);
        return toBalanceDelta(int128(0), int128(int256(amount)));
    }

    function afterAddLiquidity(
        address,
        PoolKey calldata key,
        ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external override returns (bytes4, BalanceDelta) {
        require(msg.sender == address(manager), "not manager");
        return (IHooks.afterAddLiquidity.selector, _take(key, grabOnAdd));
    }

    function afterRemoveLiquidity(
        address,
        PoolKey calldata key,
        ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external override returns (bytes4, BalanceDelta) {
        require(msg.sender == address(manager), "not manager");
        return (IHooks.afterRemoveLiquidity.selector, _take(key, grabOnRemove));
    }
}

/// @notice Re-enters the position manager from a hook callback. Used to pin the claim
/// that v4's `AlreadyUnlocked` guard makes every verb unreachable mid-unlock, and that
/// `openNew`'s pre-unlock `initialize` is benign.
contract ReentrantHook is BaseTestHooks {
    IPoolManager public immutable manager;
    address public target;
    bytes public payload;
    bool public attempted;
    bool public succeeded;
    bytes public returndataOnFailure;

    constructor(IPoolManager _manager) {
        manager = _manager;
    }

    function arm(address _target, bytes calldata _payload) external {
        target = _target;
        payload = _payload;
        attempted = false;
        succeeded = false;
    }

    function _fire() internal {
        if (target == address(0) || attempted) return;
        attempted = true;
        (bool ok, bytes memory ret) = target.call(payload);
        succeeded = ok;
        if (!ok) returndataOnFailure = ret;
    }

    /// which callback most recently fired the reentrant call — lets a test prove the
    /// attempt actually happened from the callback it meant to exercise
    string public firedFrom;

    function _fireFrom(string memory where) internal {
        if (target == address(0) || attempted) return;
        firedFrom = where;
        _fire();
    }

    function afterInitialize(address, PoolKey calldata, uint160, int24) external override returns (bytes4) {
        _fireFrom("afterInitialize");
        return IHooks.afterInitialize.selector;
    }

    function beforeSwap(address, PoolKey calldata, SwapParams calldata, bytes calldata)
        external
        override
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        _fireFrom("beforeSwap");
        return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, uint24(0));
    }

    function afterSwap(address, PoolKey calldata, SwapParams calldata, BalanceDelta, bytes calldata)
        external
        override
        returns (bytes4, int128)
    {
        _fireFrom("afterSwap");
        return (IHooks.afterSwap.selector, int128(0));
    }

    function beforeAddLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        external
        override
        returns (bytes4)
    {
        _fireFrom("beforeAddLiquidity");
        return IHooks.beforeAddLiquidity.selector;
    }

    function afterAddLiquidity(
        address,
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external override returns (bytes4, BalanceDelta) {
        _fireFrom("afterAddLiquidity");
        return (IHooks.afterAddLiquidity.selector, BalanceDelta.wrap(0));
    }

    function beforeRemoveLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        external
        override
        returns (bytes4)
    {
        _fireFrom("beforeRemoveLiquidity");
        return IHooks.beforeRemoveLiquidity.selector;
    }

    function afterRemoveLiquidity(
        address,
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external override returns (bytes4, BalanceDelta) {
        _fireFrom("afterRemoveLiquidity");
        return (IHooks.afterRemoveLiquidity.selector, BalanceDelta.wrap(0));
    }
}
