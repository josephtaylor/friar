// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title IFeeExemptionRegistry
/// @notice The single call a position manager makes into the shared exemption list.
/// Kept to one view function on purpose: the manager depends on this during every verb,
/// so the surface it depends on should be as small as it can be.
interface IFeeExemptionRegistry {
    function isExempt(address account) external view returns (bool);
}
