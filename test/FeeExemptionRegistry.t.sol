// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {FeeExemptionRegistry} from "../src/FeeExemptionRegistry.sol";

contract FeeExemptionRegistryTest is Test {
    FeeExemptionRegistry reg;

    address admin = makeAddr("admin");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    function setUp() public {
        address[] memory seed = new address[](1);
        seed[0] = alice;
        reg = new FeeExemptionRegistry(admin, seed);
    }

    function test_constructorSeedsAndSetsAdmin() public view {
        assertEq(reg.admin(), admin);
        assertTrue(reg.isExempt(alice), "seed applied");
        assertFalse(reg.isExempt(bob));
    }

    /// A zero admin would strand the list permanently: non-upgradeable, and `acceptAdmin`
    /// can only ever be reached by a live caller, so there is no recovery path.
    function test_rejectsZeroAdmin() public {
        address[] memory none = new address[](0);
        vm.expectRevert(FeeExemptionRegistry.ZeroAdmin.selector);
        new FeeExemptionRegistry(address(0), none);
    }

    function test_setExemptIsAdminGated() public {
        vm.prank(alice);
        vm.expectRevert(FeeExemptionRegistry.NotAdmin.selector);
        reg.setExempt(bob, true);

        vm.prank(admin);
        reg.setExempt(bob, true);
        assertTrue(reg.isExempt(bob));

        vm.prank(admin);
        reg.setExempt(bob, false);
        assertFalse(reg.isExempt(bob));
    }

    function test_batchSet() public {
        address[] memory many = new address[](3);
        many[0] = bob;
        many[1] = makeAddr("carol");
        many[2] = makeAddr("dave");

        vm.prank(admin);
        reg.setExemptBatch(many, true);
        for (uint256 i; i < many.length; ++i) {
            assertTrue(reg.isExempt(many[i]));
        }

        vm.prank(admin);
        reg.setExemptBatch(many, false);
        for (uint256 i; i < many.length; ++i) {
            assertFalse(reg.isExempt(many[i]));
        }
    }

    function test_adminTransferIsTwoStep() public {
        vm.prank(admin);
        reg.transferAdmin(bob);
        assertEq(reg.admin(), admin, "handover is not complete until accepted");

        vm.prank(alice);
        vm.expectRevert(FeeExemptionRegistry.NotPendingAdmin.selector);
        reg.acceptAdmin();

        vm.prank(bob);
        reg.acceptAdmin();
        assertEq(reg.admin(), bob);
        assertEq(reg.pendingAdmin(), address(0));

        vm.prank(admin);
        vm.expectRevert(FeeExemptionRegistry.NotAdmin.selector);
        reg.setExempt(alice, false);
    }

    /// A pending handover to a wrong address is cancellable, and the role can never end up
    /// at address(0) because acceptAdmin only ever sets it to a live caller.
    function test_pendingTransferCanBeReplaced() public {
        vm.startPrank(admin);
        reg.transferAdmin(bob);
        reg.transferAdmin(alice);
        vm.stopPrank();

        vm.prank(bob);
        vm.expectRevert(FeeExemptionRegistry.NotPendingAdmin.selector);
        reg.acceptAdmin();

        vm.prank(alice);
        reg.acceptAdmin();
        assertEq(reg.admin(), alice);
    }
}
