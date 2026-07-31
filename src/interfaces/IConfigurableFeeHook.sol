// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";

/// @title IConfigurableFeeHook
/// @notice The slice of a fee hook that the position manager needs in order to create a
/// pool with non-default parameters in one transaction.
///
/// WHY THE MANAGER NEEDS THIS AT ALL. v4 removed `hookData` from `initialize`, so a hook
/// with per-pool parameters has to have them registered beforehand. FriarV2 keys those
/// proposals by REGISTRANT — the address that calls `PoolManager.initialize` is the one
/// whose proposal the pool adopts — which is what stops a searcher freezing their own
/// parameters onto somebody else's pool. For a manager-created pool that address is the
/// MANAGER, not the user. So a user who registers a config from their own wallet and then
/// opens through the manager would silently get hook defaults. The manager has to register
/// on their behalf, in the same transaction, or custom-configured pools are simply not
/// creatable through the app.
///
/// STRUCT MUST MATCH THE HOOK'S EXACTLY. The function selector covers the full struct
/// shape, so any drift produces a different selector and the call reverts rather than
/// misencoding — it fails safe, not silently. `FriarPositionManager.t.sol` asserts the
/// selector matches `FriarV2.setPoolConfig` so drift is caught at test time instead.
interface IConfigurableFeeHook {
    struct PoolConfig {
        uint24 baseFeePips;
        uint16 filterPeriod;
        uint16 decayPeriod;
        uint16 reductionFactor;
        uint24 variableFeeControl;
        uint24 maxVolatilityTicks;
        bool locked;
    }

    /// @notice Propose parameters for a pool that has not been initialized yet. The
    /// proposal is recorded under `msg.sender` and is adopted only if `msg.sender` is also
    /// the address that initializes the pool.
    function setPoolConfig(PoolKey calldata key, PoolConfig calldata cfg) external;

    /// @notice The frozen configuration a pool is actually running.
    ///
    /// The manager reads this back after initializing so that "your config was applied" is
    /// verified rather than assumed. Matching the `setPoolConfig` ABI only proves a hook
    /// can RECEIVE the call; it proves nothing about whether the hook honoured it.
    function configOf(PoolId poolId) external view returns (PoolConfig memory);
}
