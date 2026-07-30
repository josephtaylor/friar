// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {Deployers} from "v4-core/test/utils/Deployers.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {LPFeeLibrary} from "v4-core/src/libraries/LPFeeLibrary.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {SwapParams, ModifyLiquidityParams} from "v4-core/src/types/PoolOperation.sol";

import {Friar} from "../src/Friar.sol";
import {FriarV2} from "../src/FriarV2.sol";

/// What V2's per-pool config and EWMA cost on every swap, forever. V2 reads a config slot
/// and reads+writes an EWMA slot that V1 does not, so the delta is expected to be roughly
/// one warm SLOAD plus one warm SSTORE. Measured rather than assumed, because it is paid
/// by every trader on every swap and it feeds straight into routing competitiveness.
contract FriarV2GasTest is Test, Deployers {
    int24 constant TICK_SPACING = 150;

    Friar v1;
    FriarV2 v2;
    PoolKey keyV1;
    PoolKey keyV2;

    function setUp() public {
        deployFreshManagerAndRouters();
        deployMintAndApprove2Currencies();

        // V1 tuned to the same 0.90% base at this spacing: baseFactor x binStep x 1e10,
        // so 6000 x 150 x 1e10 = 9e15 = 0.90%. Like for like.
        address a1 = address(uint160(Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG) | (1 << 20));
        deployCodeTo(
            "Friar.sol:Friar",
            abi.encode(manager, uint16(6000), uint16(10), uint16(600), uint16(5000), uint24(40_000), uint24(350_000)),
            a1
        );
        v1 = Friar(a1);

        address a2 = address(uint160(Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG) | (1 << 21));
        deployCodeTo(
            "FriarV2.sol:FriarV2",
            abi.encode(
                manager,
                FriarV2.PoolConfig({
                    baseFeePips: 9000,
                    filterFloor: 10,
                    filterCeil: 300,
                    windowK: 3,
                    decayPeriod: 600,
                    reductionFactor: 5000,
                    variableFeeControl: 40_000,
                    maxVolatilityTicks: 7000,
                    locked: false
                })
            ),
            a2
        );
        v2 = FriarV2(a2);

        (keyV1,) =
            initPool(currency0, currency1, IHooks(a1), LPFeeLibrary.DYNAMIC_FEE_FLAG, TICK_SPACING, SQRT_PRICE_1_1);
        (keyV2,) =
            initPool(currency0, currency1, IHooks(a2), LPFeeLibrary.DYNAMIC_FEE_FLAG, TICK_SPACING, SQRT_PRICE_1_1);

        ModifyLiquidityParams memory lp =
            ModifyLiquidityParams({tickLower: -6000, tickUpper: 6000, liquidityDelta: 100e18, salt: 0});
        modifyLiquidityRouter.modifyLiquidity(keyV1, lp, ZERO_BYTES);
        modifyLiquidityRouter.modifyLiquidity(keyV2, lp, ZERO_BYTES);

        // Warm both pools to STEADY STATE. This warp matters: without it the warm-up swap
        // lands on the same timestamp as initialize, the gap is 0, and V2's EWMA slot stays
        // zero — so the measured swap would pay SSTORE_SET (22_100) instead of the
        // SSTORE_RESET (2_900) every real swap after the first one pays.
        vm.warp(block.timestamp + 30);
        swap(keyV1, true, -1e15, ZERO_BYTES);
        swap(keyV2, true, -1e15, ZERO_BYTES);
    }

    function test_gas_beforeSwapDelta() public {
        SwapParams memory p = SwapParams({zeroForOne: true, amountSpecified: -1e15, sqrtPriceLimitX96: 0});

        vm.warp(block.timestamp + 30);
        vm.prank(address(manager));
        uint256 g0 = gasleft();
        v1.beforeSwap(address(this), keyV1, p, ZERO_BYTES);
        uint256 gasV1 = g0 - gasleft();

        vm.warp(block.timestamp + 30);
        vm.prank(address(manager));
        uint256 g1 = gasleft();
        v2.beforeSwap(address(this), keyV2, p, ZERO_BYTES);
        uint256 gasV2 = g1 - gasleft();

        console2.log("beforeSwap gas  v1:", gasV1);
        console2.log("beforeSwap gas  v2:", gasV2);
        console2.log("delta:", gasV2 - gasV1);
        // a full swap is ~150-200k, so anything in the low thousands is noise for routing
        // Two extra warm SLOADs plus one SSTORE_RESET. At 0.0202 gwei and ETH $1900 this is
        // well under a hundredth of a cent per swap, so it is irrelevant to routing on this
        // chain — but it is paid forever, so it is measured rather than assumed.
        assertLt(gasV2 - gasV1, 9_000, "V2 steady-state beforeSwap overhead regressed");
    }
}
