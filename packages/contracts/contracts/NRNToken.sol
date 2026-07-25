// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

contract NRNToken is ERC20, Ownable {
    uint256 public constant MAX_SUPPLY = 1_000_000_000 ether;

    constructor(address initialOwner) ERC20("Neurion", "NRN") Ownable(initialOwner) {
        _mint(initialOwner, MAX_SUPPLY);
    }
}
