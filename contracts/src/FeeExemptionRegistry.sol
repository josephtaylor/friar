// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IFeeExemptionRegistry} from "./interfaces/IFeeExemptionRegistry.sol";

/// @title FeeExemptionRegistry — who pays no performance fee, across manager generations
/// @notice Fee exemptions are CONFIGURATION, not code. They describe a relationship with a
/// person (a partner, a beta tester, the house bot) and have no reason to expire because a
/// manager was redeployed. Holding the list inside each `FriarPositionManager` tied its
/// lifetime to a contract that is deliberately disposable, and the drift was not
/// hypothetical: `0x65d9…d2d7` was exempt on two successive managers and silently lost it
/// in the 2026-07-27 redeploy, unnoticed for days.
///
/// Deployed once. Every subsequent manager takes this address as an immutable constructor
/// argument, so the list stops being per-deployment bookkeeping. Managers already deployed
/// cannot be retrofitted — they keep their own internal lists — so persistence begins with
/// the first registry-aware manager.
///
/// DESIGN CONSTRAINTS, and why each one:
/// - NOT upgradeable and not a proxy. Every manager will call this on every open, increase,
///   decrease, collect and close. A replaceable implementation would be a single dependency
///   able to break every manager generation at once, which is far more authority than a
///   discount list warrants.
/// - Admin is SEPARATE from any manager's treasury. They are different roles: a treasury
///   receives fees for one manager, this admin grants discounts across all of them. Keeping
///   them distinct means transferring an old manager's treasury cannot hand someone global
///   authority over current and future managers. They may be the same key today; the point
///   is that they need not stay that way.
/// - Powers are bounded in one direction only. The admin can waive a fee or restore it to
///   the manager's own immutable rate. It can never charge more than that rate, touch
///   principal, or block an exit.
///
/// Exemptions are read at operation time, so changing the list affects future collections
/// on positions that are already open. That matches the behaviour of the per-manager
/// mapping it replaces.
contract FeeExemptionRegistry is IFeeExemptionRegistry {
    error NotAdmin();
    error NotPendingAdmin();
    error ZeroAdmin();

    address public admin;
    address public pendingAdmin;

    mapping(address => bool) public isExempt;

    event ExemptionSet(address indexed account, bool exempt);
    event AdminTransferStarted(address indexed currentAdmin, address indexed pendingAdmin);
    event AdminTransferred(address indexed previousAdmin, address indexed newAdmin);

    constructor(address initialAdmin, address[] memory initialExempt) {
        if (initialAdmin == address(0)) revert ZeroAdmin();
        admin = initialAdmin;
        for (uint256 i; i < initialExempt.length; ++i) {
            isExempt[initialExempt[i]] = true;
            emit ExemptionSet(initialExempt[i], true);
        }
    }

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    function setExempt(address account, bool exempt) external onlyAdmin {
        isExempt[account] = exempt;
        emit ExemptionSet(account, exempt);
    }

    function setExemptBatch(address[] calldata accounts, bool exempt) external onlyAdmin {
        for (uint256 i; i < accounts.length; ++i) {
            isExempt[accounts[i]] = exempt;
            emit ExemptionSet(accounts[i], exempt);
        }
    }

    /// @notice Two-step, so a typo in `newAdmin` cannot strand the registry. A pending
    /// handover can be cancelled by starting another one; `acceptAdmin` can only ever set
    /// `admin` to a live caller, so the role can never become address(0).
    function transferAdmin(address newAdmin) external onlyAdmin {
        pendingAdmin = newAdmin;
        emit AdminTransferStarted(admin, newAdmin);
    }

    function acceptAdmin() external {
        if (msg.sender != pendingAdmin) revert NotPendingAdmin();
        address previousAdmin = admin;
        admin = msg.sender;
        pendingAdmin = address(0);
        emit AdminTransferred(previousAdmin, msg.sender);
    }
}
