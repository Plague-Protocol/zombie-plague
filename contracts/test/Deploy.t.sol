// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Deploy} from "../script/Deploy.s.sol";
import {MockUSD} from "./MockUSD.sol";

contract DeployTest is Test {
    function test_theScriptWiresEverythingAndLeavesNoKeysWithTheDeployer() public {
        Deploy script = new Deploy();
        MockUSD usd = new MockUSD();
        address admin = makeAddr("admin");
        address backend = makeAddr("backend");
        // outside a broadcast the script contract itself sends the transactions
        Deploy.Deployed memory d = script.deploy(address(script), admin, backend, address(usd), 1e18, 10e18);
        assertEq(d.escrow.authorizedGame(), address(d.rooms));
        assertEq(d.fees.authorizedGame(), address(d.rooms));
        assertEq(d.escrow.admin(), admin);
        assertEq(d.fees.admin(), admin);
        assertTrue(d.rooms.hasRole(d.rooms.DEFAULT_ADMIN_ROLE(), admin));
        assertTrue(d.rooms.hasRole(d.rooms.BACKEND_ROLE(), backend));
        assertFalse(d.rooms.hasRole(d.rooms.DEFAULT_ADMIN_ROLE(), address(script)));
        assertFalse(d.rooms.hasRole(d.rooms.DEFAULT_ADMIN_ROLE(), address(this)));
        assertEq(address(d.rooms.token()), address(usd));
        assertEq(d.rooms.feeBps(), 150);
        assertEq(d.rooms.minStake(), 1e18);
        assertEq(d.rooms.maxStake(), 10e18);
        // the implementation itself cannot be initialised by anyone
        vm.expectRevert();
        (bool ok,) = d.implementation.call(abi.encodeWithSignature("initialize(address,address,address,address,address,uint96,uint96)", admin, backend, address(usd), address(d.escrow), address(d.fees), 1e18, 10e18));
        ok;
    }
}
