// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev A stable token for tests: 18 decimals, free to mint, and able to refuse a recipient (as a token with a blocklist would).
contract MockUSD is ERC20 {
    mapping(address => bool) public blocked;

    constructor() ERC20("Mock USD", "mUSD") {}

    function mint(address to, uint256 amount) external { _mint(to, amount); }
    function setBlocked(address who, bool b) external { blocked[who] = b; }

    function _update(address from, address to, uint256 value) internal override {
        require(!blocked[to], "recipient blocked");
        super._update(from, to, value);
    }
}
