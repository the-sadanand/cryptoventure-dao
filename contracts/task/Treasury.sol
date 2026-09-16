// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";

contract Treasury is Initializable, UUPSUpgradeable {
    address public owner;
    uint256 public versionNumber;

    modifier onlyOwner() {
        require(msg.sender == owner, "Treasury: not owner");
        _;
    }

    function initialize(address governanceExecutor) external initializer {
        require(governanceExecutor != address(0), "Treasury: zero executor");
        owner = governanceExecutor;
        versionNumber = 1;
    }

    function deposit() external payable {}

    function balance() external view returns (uint256) {
        return address(this).balance;
    }

    function transferETH(address payable recipient, uint256 amount) external onlyOwner {
        require(recipient != address(0), "Treasury: zero recipient");
        require(amount <= address(this).balance, "Treasury: insufficient balance");
        (bool ok, ) = recipient.call{value: amount}("");
        require(ok, "Treasury: transfer failed");
    }

    function version() external view virtual returns (uint256) {
        return versionNumber;
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}

    receive() external payable {}
}
