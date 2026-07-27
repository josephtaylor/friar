// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Currency} from "v4-core/src/types/Currency.sol";
import {IERC20Minimal} from "v4-core/src/interfaces/external/IERC20Minimal.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";

/// @notice Settle open deltas against the PoolManager.
///
/// Vendored verbatim from Uniswap v4-core `test/utils/CurrencySettler.sol` (MIT) so that
/// production code does not import from a dependency's test tree — that keeps version
/// pinning and audit scope clean. Behavior is unchanged from upstream; the copy is kept
/// faithful (including the native-currency and ERC-6909 branches) so it diffs cleanly
/// against the original.
///
/// @dev In FriarPositionManager every call site passes `burn`/`claims` as false, and
/// native currency is rejected at `_open`, so only the ERC-20 transfer branches are
/// reachable. The others are retained purely for upstream parity.
library CurrencySettler {
    /// @notice Settle (pay) a currency to the PoolManager
    /// @param currency Currency to settle
    /// @param manager IPoolManager to settle to
    /// @param payer Address of the payer, the token sender
    /// @param amount Amount to send
    /// @param burn If true, burn the ERC-6909 token, otherwise ERC20-transfer to the PoolManager
    function settle(Currency currency, IPoolManager manager, address payer, uint256 amount, bool burn) internal {
        // for native currencies or burns, calling sync is not required
        // short circuit for ERC-6909 burns to support ERC-6909-wrapped native tokens
        if (burn) {
            manager.burn(payer, currency.toId(), amount);
        } else if (currency.isAddressZero()) {
            manager.settle{value: amount}();
        } else {
            manager.sync(currency);
            // The unchecked return values below are deliberate and are what upstream does.
            // v4 settles on the MEASURED balance delta (`sync` ... transfer ... `settle`),
            // so a token that returns false, returns nothing, or silently under-delivers
            // (fee-on-transfer) simply fails to move the balance and the unlock reverts
            // with `CurrencyNotSettled`. Trusting the boolean would be strictly weaker.
            // Pinned by test_returnsFalseToken_cannotMintFree / test_feeOnTransferToken_cannotUnderpay.
            if (payer != address(this)) {
                // forge-lint: disable-next-line(erc20-unchecked-transfer)
                IERC20Minimal(Currency.unwrap(currency)).transferFrom(payer, address(manager), amount);
            } else {
                // forge-lint: disable-next-line(erc20-unchecked-transfer)
                IERC20Minimal(Currency.unwrap(currency)).transfer(address(manager), amount);
            }
            manager.settle();
        }
    }

    /// @notice Take (receive) a currency from the PoolManager
    /// @param currency Currency to take
    /// @param manager IPoolManager to take from
    /// @param recipient Address of the recipient, the token receiver
    /// @param amount Amount to receive
    /// @param claims If true, mint the ERC-6909 token, otherwise ERC20-transfer from the PoolManager to recipient
    function take(Currency currency, IPoolManager manager, address recipient, uint256 amount, bool claims) internal {
        claims ? manager.mint(recipient, currency.toId(), amount) : manager.take(currency, recipient, amount);
    }
}
