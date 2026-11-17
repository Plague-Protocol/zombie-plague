// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {PlagueRooms} from "../src/PlagueRooms.sol";
import {PotEscrow} from "../src/PotEscrow.sol";
import {FeeManager} from "../src/FeeManager.sol";

/**
 * Deploys the staked rooms: PotEscrow (custody), FeeManager, the PlagueRooms implementation and its UUPS proxy,
 * wires them together, and hands the keys to the right hands.
 *
 *   ADMIN     gets the admin role on all three. For real money: a multisig behind a timelock, never a single key.
 *   BACKEND   the game server's settle key (BACKEND_ROLE). Holds no funds; pays no gas for players.
 *   TOKEN     the stake token (USDm on Celo).
 *   MIN_STAKE, MAX_STAKE   in token units (18 decimals).
 *
 * Celo Sepolia first. After a broadcast, CHECK the result on chain (`cast code <proxy>`): a forge broadcast file alone
 * proved nothing once before (plague-celo's recorded a mainnet address with no bytecode).
 *
 *   forge script script/Deploy.s.sol --rpc-url $CELO_SEPOLIA_RPC --private-key $DEPLOYER_KEY --broadcast
 */
contract Deploy is Script {
    struct Deployed { PlagueRooms rooms; PotEscrow escrow; FeeManager fees; address implementation; }

    /// @dev Everything in one place so a test can build exactly what the script builds.
    function deploy(address deployer, address admin, address backend, address token, uint96 minStake, uint96 maxStake) public returns (Deployed memory d) {
        // `deployer` is whoever will send these transactions. It holds the plumbing's admin only long enough to
        // point it at the proxy, then hands it to `admin`.
        d.escrow = new PotEscrow(deployer, deployer, token);
        d.fees = new FeeManager(deployer, deployer, token);
        d.implementation = address(new PlagueRooms());
        ERC1967Proxy proxy = new ERC1967Proxy(
            d.implementation,
            abi.encodeCall(PlagueRooms.initialize, (admin, backend, token, address(d.escrow), address(d.fees), minStake, maxStake))
        );
        d.rooms = PlagueRooms(address(proxy));
        d.escrow.setAuthorizedGame(address(proxy));
        d.fees.setAuthorizedGame(address(proxy));
        d.escrow.transferAdmin(admin);
        d.fees.transferAdmin(admin);
    }

    function run() external returns (Deployed memory d) {
        address admin = vm.envAddress("ADMIN");
        address backend = vm.envAddress("BACKEND");
        address token = vm.envAddress("TOKEN");
        uint96 minStake = uint96(vm.envUint("MIN_STAKE"));
        uint96 maxStake = uint96(vm.envUint("MAX_STAKE"));
        vm.startBroadcast();
        (, address deployer,) = vm.readCallers(); // the broadcaster (msg.sender in a script is not)
        d = deploy(deployer, admin, backend, token, minStake, maxStake);
        vm.stopBroadcast();
        console2.log("PlagueRooms proxy   ", address(d.rooms));
        console2.log("PlagueRooms impl    ", d.implementation);
        console2.log("PotEscrow           ", address(d.escrow));
        console2.log("FeeManager          ", address(d.fees));
    }
}
