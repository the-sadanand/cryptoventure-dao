// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts/access/OwnableUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";

contract Treasury is Initializable, OwnableUpgradeable, UUPSUpgradeable {
    uint256 public versionNumber;

    function initialize(address governanceExecutor) external initializer {
        require(governanceExecutor != address(0), "Treasury: zero executor");
        __Ownable_init(governanceExecutor);
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
