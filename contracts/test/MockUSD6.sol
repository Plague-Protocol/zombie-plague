// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MockUSD} from "./MockUSD.sol";

/// @dev A 6-decimal stable token for tests, like USDT on Celo.
contract MockUSD6 is MockUSD {
    function decimals() public pure override returns (uint8) { return 6; }
}
