// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";

/// @notice Takes a cut on every transfer. v4 settles by measured balance delta, so an
/// under-delivery must surface as `CurrencyNotSettled`, never as a silent shortfall.
contract FeeOnTransferToken is MockERC20 {
    uint256 public feeBps;

    constructor(uint256 _feeBps) MockERC20("FeeOnTransfer", "FOT", 18) {
        feeBps = _feeBps;
    }

    function _take(address from, address to, uint256 amount) internal returns (bool) {
        uint256 fee = (amount * feeBps) / 10_000;
        balanceOf[from] -= amount;
        unchecked {
            balanceOf[to] += amount - fee;
            balanceOf[address(0xFEE)] += fee;
        }
        return true;
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        return _take(msg.sender, to, amount);
    }

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - amount;
        return _take(from, to, amount);
    }
}

/// @notice Returns false instead of reverting on failure — the classic "unchecked return"
/// trap. v4's balance-delta settlement must catch it regardless.
contract ReturnsFalseToken is MockERC20 {
    bool public failing;

    constructor() MockERC20("ReturnsFalse", "RF", 18) {}

    function setFailing(bool f) external {
        failing = f;
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        if (failing) return false;
        return super.transfer(to, amount);
    }

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        if (failing) return false;
        return super.transferFrom(from, to, amount);
    }
}

/// @notice Reverts only on the way out (withdrawal/fee collection), never on entry — the
/// honeypot shape. Entry must work and exit must fail loudly rather than corrupt state.
contract ExitRevertingToken is MockERC20 {
    address public trapped;

    constructor() MockERC20("ExitRevert", "XR", 18) {}

    function setTrapped(address who) external {
        trapped = who;
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        if (to == trapped) revert("no exit");
        return super.transfer(to, amount);
    }
}

/// @notice ERC-777-style: calls back into an arbitrary target during transfer. Used to
/// prove settlement-time reentrancy cannot reach any manager verb.
contract CallbackToken is MockERC20 {
    address public target;
    bytes public payload;
    bool public fired;
    bool public callSucceeded;

    constructor() MockERC20("Callback", "CB", 18) {}

    function arm(address _target, bytes calldata _payload) external {
        target = _target;
        payload = _payload;
        fired = false;
    }

    function _hook() internal {
        if (target == address(0) || fired) return;
        fired = true;
        (bool ok,) = target.call(payload);
        callSucceeded = ok;
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        bool ok = super.transfer(to, amount);
        _hook();
        return ok;
    }

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        bool ok = super.transferFrom(from, to, amount);
        _hook();
        return ok;
    }
}
