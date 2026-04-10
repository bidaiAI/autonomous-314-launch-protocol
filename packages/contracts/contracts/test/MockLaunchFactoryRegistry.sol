// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ILaunchFactoryRegistry} from "../interfaces/ILaunchFactoryRegistry.sol";

contract MockLaunchFactoryRegistry is ILaunchFactoryRegistry {
    address private immutable _whitelistDeployer;
    uint256[] private whitelistThresholds;
    uint256[] private whitelistSlotSizes;

    constructor(address whitelistDeployer_, uint256[] memory thresholds_, uint256[] memory slotSizes_) {
        _whitelistDeployer = whitelistDeployer_;
        whitelistThresholds = thresholds_;
        whitelistSlotSizes = slotSizes_;
    }

    function standardDeployer() external pure returns (address) {
        return address(0);
    }

    function whitelistDeployer() external view returns (address) {
        return _whitelistDeployer;
    }

    function taxedDeployer() external pure returns (address) {
        return address(0);
    }

    function whitelistTaxedDeployer() external pure returns (address) {
        return address(0);
    }

    function pendingModeOf(address) external pure returns (uint8) {
        return 0;
    }

    function isAllowedWhitelistThreshold(uint256 threshold) external view returns (bool) {
        for (uint256 i = 0; i < whitelistThresholds.length; i++) {
            if (whitelistThresholds[i] == threshold) return true;
        }
        return false;
    }

    function isAllowedWhitelistSlotSize(uint256 slotSize) external view returns (bool) {
        for (uint256 i = 0; i < whitelistSlotSizes.length; i++) {
            if (whitelistSlotSizes[i] == slotSize) return true;
        }
        return false;
    }
}
