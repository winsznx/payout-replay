// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title TestToken
/// @notice TEST TOKEN with no value, deployed only for the Payout Replay
/// testnet demonstration. Owner-mintable, 6 decimals like common stablecoins.
contract TestToken is ERC20, Ownable {
    constructor(address initialOwner) ERC20("Payout Replay Test Token", "PRT") Ownable(initialOwner) {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }
}
