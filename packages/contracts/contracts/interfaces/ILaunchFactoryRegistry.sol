// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface ILaunchFactoryRegistry {
    function standardDeployer() external view returns (address);
    function whitelistDeployer() external view returns (address);
    function taxedDeployer() external view returns (address);
    function whitelistTaxedDeployer() external view returns (address);
    function pendingModeOf(address token) external view returns (uint8);
}
