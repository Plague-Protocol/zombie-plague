// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {PlagueRooms} from "../src/PlagueRooms.sol";
import {PotEscrow} from "../src/PotEscrow.sol";
import {FeeManager} from "../src/FeeManager.sol";
import {MockUSD} from "./MockUSD.sol";

contract PlagueRoomsV2 is PlagueRooms {
    uint256 public addedLater;
    function setAddedLater(uint256 v) external { addedLater = v; }
    function version() external pure returns (uint256) { return 2; }
}

contract Base is Test {
    MockUSD public usd;
    PotEscrow public escrow;
    FeeManager public fees;
    PlagueRooms public rooms;
    address admin = makeAddr("admin");
    address backend = makeAddr("backend");
    address[8] public p; // players
    uint96 constant STAKE = 5e18;

    function setUp() public virtual {
        usd = new MockUSD();
        escrow = new PotEscrow(admin, admin, address(usd));
        fees = new FeeManager(admin, admin, address(usd));
        PlagueRooms impl = new PlagueRooms();
        ERC1967Proxy proxy = new ERC1967Proxy(address(impl), abi.encodeCall(PlagueRooms.initialize, (admin, backend, address(usd), address(escrow), address(fees), 1e18, 10e18)));
        rooms = PlagueRooms(address(proxy));
        vm.startPrank(admin);
        escrow.setAuthorizedGame(address(rooms));
        fees.setAuthorizedGame(address(rooms));
        vm.stopPrank();
        for (uint256 i = 0; i < 8; i++) {
            p[i] = makeAddr(string.concat("player", vm.toString(i)));
            usd.mint(p[i], 100e18);
            vm.prank(p[i]);
            usd.approve(address(rooms), type(uint256).max);
        }
    }

    /// @dev A started room with `n` players, the first the host.
    function started(uint8 n, uint96 stake) internal returns (uint256 id) {
        id = waiting(n, stake);
        vm.prank(p[0]);
        rooms.startGame(id);
    }

    function waiting(uint8 n, uint96 stake) internal returns (uint256 id) {
        vm.prank(p[0]);
        id = rooms.createRoom(8, stake, 1 hours);
        for (uint8 i = 1; i < n; i++) { vm.prank(p[i]); rooms.joinRoom(id); }
    }

    function one(address a) internal pure returns (address[] memory w) { w = new address[](1); w[0] = a; }
    function two(address a, address b) internal pure returns (address[] memory w) { w = new address[](2); w[0] = a; w[1] = b; }
    function status(uint256 id) internal view returns (PlagueRooms.Status s) { (, s,,,,,,,) = rooms.getRoom(id); }
}

contract PlagueRoomsTest is Base {
    function test_happyPath_exactToTheWei() public {
        uint256 id = started(3, STAKE);
        assertEq(escrow.roomBalance(id), 15e18);
        vm.prank(backend);
        rooms.settle(id, two(p[1], p[2]), keccak256("log"));
        // pot 15, fee 1.5% = 0.225, two winners split 14.775
        assertEq(usd.balanceOf(p[1]), 100e18 - 5e18 + 7.3875e18);
        assertEq(usd.balanceOf(p[2]), 100e18 - 5e18 + 7.3875e18);
        assertEq(usd.balanceOf(p[0]), 100e18 - 5e18);
        assertEq(fees.balance(), 0.225e18);
        assertEq(escrow.roomBalance(id), 0);
        assertEq(usd.balanceOf(address(rooms)), 0);
        assertEq(uint8(status(id)), uint8(PlagueRooms.Status.Settled));
        assertEq(rooms.activeRooms(), 0);
    }

    function test_theAuditEventCarriesTheLogHash() public {
        uint256 id = started(2, STAKE);
        vm.expectEmit(true, false, false, false);
        emit PlagueRooms.RoomSettled(id, one(p[0]), 0, 0, keccak256("round"));
        vm.prank(backend);
        rooms.settle(id, one(p[0]), keccak256("round"));
    }

    function test_onlyTheServerSettles_andOnlyPlayersInThatRoomCanWin() public {
        uint256 id = started(3, STAKE);
        vm.expectRevert();
        vm.prank(p[0]);
        rooms.settle(id, one(p[0]), 0);
        vm.expectRevert(abi.encodeWithSelector(PlagueRooms.NotAWinner.selector, p[5]));
        vm.prank(backend);
        rooms.settle(id, one(p[5]), 0); // staked in no room
        vm.expectRevert(abi.encodeWithSelector(PlagueRooms.NotAWinner.selector, p[1]));
        vm.prank(backend);
        rooms.settle(id, two(p[1], p[1]), 0); // the same one twice
        uint256 other = waiting(1, STAKE);
        vm.expectRevert(PlagueRooms.NotStarted.selector);
        vm.prank(backend);
        rooms.settle(other, one(p[0]), 0); // still waiting
    }

    function test_cannotSettleTwice() public {
        uint256 id = started(2, STAKE);
        vm.startPrank(backend);
        rooms.settle(id, one(p[0]), 0);
        vm.expectRevert(PlagueRooms.NotStarted.selector);
        rooms.settle(id, one(p[0]), 0);
        vm.stopPrank();
    }

    function test_nobodyGotOut_everyoneIsRefundedInFull_noFee() public {
        uint256 id = started(3, STAKE);
        vm.prank(backend);
        rooms.settle(id, new address[](0), 0);
        for (uint256 i = 0; i < 3; i++) assertEq(usd.balanceOf(p[i]), 100e18);
        assertEq(fees.balance(), 0);
        assertEq(uint8(status(id)), uint8(PlagueRooms.Status.Settled));
    }

    function test_leaveRefunds_theHostCannotLeave_cancelRefundsEveryone() public {
        uint256 id = waiting(3, STAKE);
        vm.prank(p[2]);
        rooms.leaveRoom(id);
        assertEq(usd.balanceOf(p[2]), 100e18);
        assertEq(escrow.roomBalance(id), 10e18);
        vm.expectRevert(PlagueRooms.HostCannotLeave.selector);
        vm.prank(p[0]);
        rooms.leaveRoom(id);
        vm.expectRevert(PlagueRooms.NotInRoom.selector);
        vm.prank(p[2]);
        rooms.leaveRoom(id);
        vm.expectRevert(PlagueRooms.NotHost.selector);
        vm.prank(p[1]);
        rooms.cancelRoom(id);
        vm.prank(p[0]);
        rooms.cancelRoom(id);
        assertEq(usd.balanceOf(p[0]), 100e18);
        assertEq(usd.balanceOf(p[1]), 100e18);
        assertEq(escrow.roomBalance(id), 0);
        assertEq(rooms.activeRooms(), 0);
        vm.expectRevert(PlagueRooms.NotWaiting.selector);
        vm.prank(p[1]);
        rooms.joinRoom(id);
    }

    function test_leavingAStartedRoomIsNotAllowed() public {
        uint256 id = started(3, STAKE);
        vm.expectRevert(PlagueRooms.NotWaiting.selector);
        vm.prank(p[1]);
        rooms.leaveRoom(id);
    }

    function test_aWaitingRoomExpires_andAnyoneCanRefundIt() public {
        uint256 id = waiting(3, STAKE);
        vm.expectRevert(PlagueRooms.NotExpired.selector);
        rooms.expireRoom(id);
        vm.warp(block.timestamp + 1 hours);
        vm.expectRevert(PlagueRooms.Expired.selector);
        vm.prank(p[4]);
        rooms.joinRoom(id);
        vm.expectRevert(PlagueRooms.Expired.selector);
        vm.prank(p[0]);
        rooms.startGame(id);
        rooms.expireRoom(id); // called by nobody in particular
        for (uint256 i = 0; i < 3; i++) assertEq(usd.balanceOf(p[i]), 100e18);
        assertEq(rooms.activeRooms(), 0);
    }

    function test_joinAndStartRules() public {
        uint256 id = waiting(1, STAKE);
        vm.expectRevert(PlagueRooms.AlreadyJoined.selector);
        vm.prank(p[0]);
        rooms.joinRoom(id);
        vm.expectRevert(PlagueRooms.NotEnoughPlayers.selector);
        vm.prank(p[0]);
        rooms.startGame(id);
        vm.prank(p[1]);
        rooms.joinRoom(id);
        vm.expectRevert(PlagueRooms.NotHost.selector);
        vm.prank(p[1]);
        rooms.startGame(id);
        vm.expectRevert(PlagueRooms.NoSuchRoom.selector);
        rooms.joinRoom(999);
        // a full room
        vm.prank(p[0]);
        uint256 small = rooms.createRoom(2, STAKE, 1 hours);
        vm.prank(p[1]);
        rooms.joinRoom(small);
        vm.expectRevert(PlagueRooms.RoomFull.selector);
        vm.prank(p[2]);
        rooms.joinRoom(small);
    }

    function test_roomBounds() public {
        vm.startPrank(p[0]);
        vm.expectRevert(PlagueRooms.BadPlayers.selector);
        rooms.createRoom(1, STAKE, 1 hours);
        vm.expectRevert(PlagueRooms.BadPlayers.selector);
        rooms.createRoom(9, STAKE, 1 hours);
        vm.expectRevert(PlagueRooms.BadStake.selector);
        rooms.createRoom(4, 0.5e18, 1 hours);
        vm.expectRevert(PlagueRooms.BadStake.selector);
        rooms.createRoom(4, 11e18, 1 hours);
        vm.expectRevert(PlagueRooms.BadExpiry.selector);
        rooms.createRoom(4, STAKE, 30);
        vm.stopPrank();
    }

    function test_theNumberOfOpenRoomsIsCapped() public {
        vm.prank(admin);
        rooms.setMaxActiveRooms(2);
        for (uint256 i = 0; i < 2; i++) { vm.prank(p[i]); rooms.createRoom(4, STAKE, 1 hours); }
        vm.expectRevert(PlagueRooms.TooManyRooms.selector);
        vm.prank(p[2]);
        rooms.createRoom(4, STAKE, 1 hours);
    }

    // ─── the server never settles ───────────────────────────────────────────────────────────────────────

    function test_reclaimIsClosedUntilTheTimeoutThenPaysOnce() public {
        uint256 id = started(3, STAKE);
        vm.expectRevert(PlagueRooms.ReclaimNotOpen.selector);
        vm.prank(p[1]);
        rooms.reclaim(id);
        vm.warp(block.timestamp + 6 hours);
        vm.prank(p[1]);
        rooms.reclaim(id);
        assertEq(usd.balanceOf(p[1]), 100e18);
        vm.expectRevert(PlagueRooms.NotInRoom.selector);
        vm.prank(p[1]);
        rooms.reclaim(id);
        vm.expectRevert(PlagueRooms.NotInRoom.selector);
        vm.prank(p[6]); // never in it
        rooms.reclaim(id);
    }

    function test_afterOneReclaimsTheServerCanStillSettleWhatIsLeft() public {
        uint256 id = started(3, STAKE);
        vm.warp(block.timestamp + 6 hours);
        vm.prank(p[1]);
        rooms.reclaim(id);
        vm.prank(backend);
        rooms.settle(id, one(p[0]), 0); // pot is now the two stakes left: 10
        assertEq(usd.balanceOf(p[0]), 100e18 - 5e18 + 9.85e18); // 10 less 1.5%
        assertEq(usd.balanceOf(p[2]), 100e18 - 5e18);
        vm.expectRevert(PlagueRooms.NotStarted.selector); // settled once, settled for good
        vm.prank(backend);
        rooms.settle(id, one(p[1]), 0);
    }

    function test_aPlayerWhoReclaimedCannotBeNamedAWinner() public {
        uint256 id = started(3, STAKE);
        vm.warp(block.timestamp + 6 hours);
        vm.prank(p[1]);
        rooms.reclaim(id);
        vm.expectRevert(abi.encodeWithSelector(PlagueRooms.NotAWinner.selector, p[1]));
        vm.prank(backend);
        rooms.settle(id, one(p[1]), 0);
    }

    function test_whenEveryoneReclaimsTheRoomIsClosedAndNothingIsLeft() public {
        uint256 id = started(3, STAKE);
        vm.warp(block.timestamp + 6 hours);
        for (uint256 i = 0; i < 3; i++) { vm.prank(p[i]); rooms.reclaim(id); }
        assertEq(uint8(status(id)), uint8(PlagueRooms.Status.Cancelled));
        assertEq(rooms.activeRooms(), 0);
        assertEq(escrow.roomBalance(id), 0);
        for (uint256 i = 0; i < 3; i++) assertEq(usd.balanceOf(p[i]), 100e18);
    }

    // ─── a recipient the token will not pay ─────────────────────────────────────────────────────────────

    function test_oneBlockedRecipientDoesNotBlockTheRoom_theyClaimLater() public {
        uint256 id = started(3, STAKE);
        usd.setBlocked(p[1], true);
        vm.prank(backend);
        rooms.settle(id, two(p[1], p[2]), 0); // still settles
        assertEq(usd.balanceOf(p[2]), 100e18 - 5e18 + 7.3875e18);
        assertEq(rooms.owed(id, p[1]), 7.3875e18);
        vm.expectRevert();
        vm.prank(p[1]);
        rooms.claim(id); // still blocked
        assertEq(rooms.owed(id, p[1]), 7.3875e18); // and nothing was lost
        usd.setBlocked(p[1], false);
        vm.prank(p[1]);
        rooms.claim(id);
        assertEq(usd.balanceOf(p[1]), 100e18 - 5e18 + 7.3875e18);
        assertEq(rooms.owed(id, p[1]), 0);
        assertEq(escrow.roomBalance(id), 0);
        vm.expectRevert(PlagueRooms.NothingOwed.selector);
        vm.prank(p[1]);
        rooms.claim(id);
    }

    // ─── admin, pause, upgrade ──────────────────────────────────────────────────────────────────────────

    function test_pauseStopsNewRoomsAndJoins_butNotMoneyComingOut() public {
        uint256 live = started(2, STAKE);
        uint256 wait = waiting(1, STAKE);
        vm.prank(admin);
        rooms.pause();
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        vm.prank(p[3]);
        rooms.createRoom(4, STAKE, 1 hours);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        vm.prank(p[3]);
        rooms.joinRoom(wait);
        vm.prank(backend);
        rooms.settle(live, one(p[0]), 0);
        vm.prank(p[0]);
        rooms.cancelRoom(wait);
        assertEq(rooms.activeRooms(), 0);
    }

    function test_configIsBoundedAndAdminOnly() public {
        vm.startPrank(admin);
        vm.expectRevert(PlagueRooms.BadConfig.selector);
        rooms.setFeeBps(501);
        rooms.setFeeBps(500);
        vm.expectRevert(PlagueRooms.BadConfig.selector);
        rooms.setReclaimAfter(30 minutes);
        vm.expectRevert(PlagueRooms.BadConfig.selector);
        rooms.setStakeLimits(0, 1);
        vm.stopPrank();
        vm.expectRevert();
        vm.prank(p[0]);
        rooms.setFeeBps(0);
        vm.expectRevert();
        vm.prank(backend); // the server key is not an admin
        rooms.pause();
    }

    function test_plumbingCannotBeSwappedWhileRoomsHoldMoney() public {
        waiting(1, STAKE);
        vm.prank(admin);
        vm.expectRevert(PlagueRooms.RoomsActive.selector);
        rooms.setPlumbing(address(escrow), address(fees));
    }

    function test_upgradeKeepsEveryRoom_andOnlyTheAdminCanUpgrade() public {
        uint256 id = started(3, STAKE);
        PlagueRoomsV2 v2 = new PlagueRoomsV2();
        vm.expectRevert();
        vm.prank(p[0]);
        rooms.upgradeToAndCall(address(v2), "");
        vm.expectRevert();
        vm.prank(backend);
        rooms.upgradeToAndCall(address(v2), "");
        vm.prank(admin);
        rooms.upgradeToAndCall(address(v2), "");
        PlagueRoomsV2 up = PlagueRoomsV2(address(rooms));
        assertEq(up.version(), 2);
        up.setAddedLater(7);
        assertEq(up.addedLater(), 7);
        assertEq(up.roomCount(), 1);
        assertEq(escrow.roomBalance(id), 15e18);
        assertEq(up.stakedIn(id, p[1]), STAKE);
        vm.prank(backend);
        up.settle(id, one(p[2]), 0); // an old room still settles after the upgrade
        assertGt(usd.balanceOf(p[2]), 100e18);
        // and the new variable did not land on an old one
        assertEq(up.feeBps(), 150);
        assertEq(up.maxActiveRooms(), 25);
    }

    function test_cannotInitializeTwice() public {
        vm.expectRevert();
        rooms.initialize(admin, backend, address(usd), address(escrow), address(fees), 1e18, 10e18);
    }

    // ─── fuzz: money in equals money out ────────────────────────────────────────────────────────────────

    function testFuzz_everyWeiIsAccountedFor(uint96 stake, uint8 n, uint8 w, uint16 bps) public {
        stake = uint96(bound(stake, 1e18, 10e18));
        n = uint8(bound(n, 2, 8));
        w = uint8(bound(w, 0, n));
        bps = uint16(bound(bps, 0, 500));
        vm.prank(admin);
        rooms.setFeeBps(bps);
        uint256 id = started(n, stake);
        address[] memory winners = new address[](w);
        for (uint8 i = 0; i < w; i++) winners[i] = p[i];
        uint256 before = 0;
        for (uint8 i = 0; i < n; i++) before += usd.balanceOf(p[i]);
        vm.prank(backend);
        rooms.settle(id, winners, 0);
        uint256 afterAll = 0;
        for (uint8 i = 0; i < n; i++) afterAll += usd.balanceOf(p[i]);
        uint256 pot = uint256(stake) * n;
        assertEq(afterAll - before + fees.balance(), pot, "nothing created or destroyed");
        assertEq(escrow.roomBalance(id), 0);
        assertEq(usd.balanceOf(address(rooms)), 0);
        if (w == 0) { assertEq(fees.balance(), 0); assertEq(afterAll - before, pot); }
        else assertGe(fees.balance(), pot * bps / 10_000); // at least the fee (plus any dust)
    }
}

// ─── invariant: the custody contract always holds exactly what the rooms say they hold ──────────────────

contract Handler is Base {
    uint256[] public ids;
    /// how many of each action actually went through (so we know the campaign reached deep states)
    uint256 public nStarted; uint256 public nSettled; uint256 public nRefunded; uint256 public nReclaimed; uint256 public nLeft;
    function _a(uint256 seed) internal view returns (address) { return p[seed % 8]; }
    /// @dev A recent room, so actions land on rooms that are still in play rather than ones long over.
    function _pick(uint256 which) internal view returns (uint256) { uint256 n = ids.length; uint256 span = n < 4 ? n : 4; return ids[n - 1 - (which % span)]; }

    function create(uint256 who, uint256 stake, uint256 max) external {
        vm.prank(_a(who));
        try rooms.createRoom(uint8(bound(max, 2, 8)), uint96(bound(stake, 1e18, 10e18)), 1 hours) returns (uint256 id) { ids.push(id); } catch {}
    }
    function join(uint256 who, uint256 which) external {
        if (ids.length == 0) return;
        vm.prank(_a(who));
        try rooms.joinRoom(_pick(which)) {} catch {}
    }
    function leave(uint256 who, uint256 which) external {
        if (ids.length == 0) return;
        vm.prank(_a(who));
        try rooms.leaveRoom(_pick(which)) { nLeft++; } catch {}
    }
    function start(uint256 which) external {
        if (ids.length == 0) return;
        uint256 id = _pick(which);
        (address host,,,,,,,,) = rooms.getRoom(id);
        vm.prank(host);
        try rooms.startGame(id) { nStarted++; } catch {}
    }
    function settle(uint256 which, uint256 mask) external {
        if (ids.length == 0) return;
        uint256 id = _pick(which);
        (,,,,,,,, address[] memory players) = rooms.getRoom(id);
        address[] memory w = new address[](players.length);
        uint256 k;
        for (uint256 i = 0; i < players.length; i++) if ((mask >> i) & 1 == 1) w[k++] = players[i];
        assembly { mstore(w, k) }
        vm.prank(backend);
        try rooms.settle(id, w, 0) { nSettled++; } catch {}
    }
    function cancel(uint256 which) external {
        if (ids.length == 0) return;
        uint256 id = _pick(which);
        (address host,,,,,,,,) = rooms.getRoom(id);
        vm.prank(host);
        try rooms.cancelRoom(id) { nRefunded++; } catch {}
    }
    function pass(uint256 mins) external { vm.warp(block.timestamp + bound(mins, 0, 150) * 1 minutes); }
    function expire(uint256 which) external {
        if (ids.length == 0) return;
        try rooms.expireRoom(_pick(which)) { nRefunded++; } catch {}
    }
    function reclaim(uint256 who, uint256 which) external {
        if (ids.length == 0) return;
        vm.prank(_a(who));
        try rooms.reclaim(_pick(which)) { nReclaimed++; } catch {}
    }
    function count() external view returns (uint256) { return ids.length; }
}

contract PlagueRoomsInvariant is Test {
    Handler h;

    function setUp() public {
        h = new Handler();
        h.setUp();
        targetContract(address(h));
        bytes4[] memory sel = new bytes4[](9);
        sel[0] = Handler.create.selector; sel[1] = Handler.join.selector; sel[2] = Handler.leave.selector; sel[3] = Handler.start.selector;
        sel[4] = Handler.settle.selector; sel[5] = Handler.cancel.selector; sel[6] = Handler.pass.selector; sel[7] = Handler.expire.selector;
        sel[8] = Handler.reclaim.selector;
        targetSelector(FuzzSelector({addr: address(h), selectors: sel}));
    }

    /// custody holds exactly the live rooms' pots, and the game contract itself never holds a token
    function invariant_custodyEqualsThePots() public view {
        PlagueRooms rooms = h.rooms();
        MockUSD usd = h.usd();
        uint256 pots;
        for (uint256 i = 1; i <= rooms.roomCount(); i++) { (,,,, uint96 pot,,,,) = rooms.getRoom(i); pots += pot; }
        assertEq(usd.balanceOf(address(h.escrow())), pots);
        assertEq(usd.balanceOf(address(rooms)), 0);
    }

    /// every token ever minted is still somewhere: with players, in custody, or in the fee manager
    function invariant_nothingIsCreatedOrDestroyed() public view {
        MockUSD usd = h.usd();
        uint256 total = usd.balanceOf(address(h.escrow())) + usd.balanceOf(address(h.fees()));
        for (uint256 i = 0; i < 8; i++) total += usd.balanceOf(h.p(i));
        assertEq(total, 800e18);
    }

    /// the number of rooms still open matches the rooms whose status says so
    function invariant_activeRoomsIsHonest() public view {
        PlagueRooms rooms = h.rooms();
        uint256 live;
        for (uint256 i = 1; i <= rooms.roomCount(); i++) {
            (, PlagueRooms.Status st,,,,,,,) = rooms.getRoom(i);
            if (st == PlagueRooms.Status.Waiting || st == PlagueRooms.Status.Started) live++;
        }
        assertEq(rooms.activeRooms(), live);
    }
}

/// The fuzzed invariants above are only worth something if the random calls get deep (rooms started, settled,
/// refunded, reclaimed). This runs a long scripted campaign through the same handler, checks the same properties
/// after every action, and fails if any kind of ending was never reached.
contract PlagueRoomsCampaign is Test {
    function test_aLongCampaignReachesEveryKindOfEnding() public {
        vm.pauseGasMetering(); // the checks after every action scan every room: not what is being measured here
        Handler h = new Handler();
        h.setUp();
        PlagueRooms rooms = h.rooms();
        MockUSD usd = h.usd();
        for (uint256 i = 0; i < 1200; i++) {
            uint256 r = uint256(keccak256(abi.encode(i, "campaign")));
            if (i % 150 == 0) { // a fixed storyline now and then: leave while waiting, then a started room nobody settles, then a reclaim
                h.create(0, 5e18, 4);
                h.join(1, 0);
                h.join(2, 0);
                h.leave(2, 0);
                h.start(0);
                h.pass(150); h.pass(150); h.pass(150);
                h.reclaim(1, 0);
            }
            uint256 a = r % 16;
            uint256 x = r >> 8;
            uint256 y = r >> 40;
            uint256 z = r >> 72;
            if (a == 0) h.create(x, y, z);
            else if (a <= 4) h.join(x, y);
            else if (a <= 7) h.start(x);
            else if (a <= 9) h.settle(x, y);
            else if (a == 10) h.cancel(x);
            else if (a == 11) h.leave(x, y);
            else if (a <= 13) h.pass(x);
            else if (a == 14) h.expire(x);
            else h.reclaim(x, y);
            uint256 pots;
            uint256 live;
            for (uint256 k = 1; k <= rooms.roomCount(); k++) {
                (, PlagueRooms.Status st,,, uint96 pot,,,,) = rooms.getRoom(k);
                pots += pot;
                if (st == PlagueRooms.Status.Waiting || st == PlagueRooms.Status.Started) live++;
            }
            assertEq(usd.balanceOf(address(h.escrow())), pots, "custody equals the pots");
            assertEq(usd.balanceOf(address(rooms)), 0, "the game contract holds nothing");
            assertEq(rooms.activeRooms(), live, "open-room count is honest");
            uint256 total = usd.balanceOf(address(h.escrow())) + usd.balanceOf(address(h.fees()));
            for (uint256 k = 0; k < 8; k++) total += usd.balanceOf(h.p(k));
            assertEq(total, 800e18, "nothing created or destroyed");
        }
        emit log_named_uint("rooms", rooms.roomCount());
        emit log_named_uint("started", h.nStarted());
        emit log_named_uint("settled", h.nSettled());
        emit log_named_uint("refunded (cancel or expire)", h.nRefunded());
        emit log_named_uint("reclaimed", h.nReclaimed());
        emit log_named_uint("left", h.nLeft());
        assertGt(h.nStarted(), 5);
        assertGt(h.nSettled(), 0);
        assertGt(h.nRefunded(), 0);
        assertGt(h.nReclaimed(), 0);
        assertGt(h.nLeft(), 0);
    }
}
