// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Treasury} from "./Treasury.sol";

contract TreasuryV2 is Treasury {
    function version() external pure override returns (uint256) {
        return 2;
    }

    function sweep(address payable recipient, uint256 amount) external onlyOwner {
        require(recipient != address(0), "TreasuryV2: zero recipient");
        require(amount <= address(this).balance, "TreasuryV2: insufficient balance");
        (bool ok, ) = recipient.call{value: amount}("");
        require(ok, "TreasuryV2: transfer failed");
    }
}
