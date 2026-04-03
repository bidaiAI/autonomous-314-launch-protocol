// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {LaunchTokenWhitelist} from "./LaunchTokenWhitelist.sol";

contract LaunchTokenWhitelistDeployer {
    error Unauthorized();
    struct DeployConfig {
        string name;
        string symbol;
        string metadataURI;
        address creator;
        address factory;
        address protocolFeeRecipient;
        address router;
        uint256 graduationQuoteReserve;
        uint256 whitelistThreshold;
        uint256 whitelistSlotSize;
        uint256 whitelistOpensAt;
        address[] whitelistAddresses;
        uint8 launchModeId;
        bytes32 salt;
    }

    function deploy(DeployConfig calldata config) external returns (address token) {
        if (msg.sender != config.factory) revert Unauthorized();
        token = address(
            new LaunchTokenWhitelist{salt: config.salt}(LaunchTokenWhitelist.ConstructorArgs({
                name: config.name,
                symbol: config.symbol,
                metadataURI: config.metadataURI,
                creator: config.creator,
                factory: config.factory,
                protocolFeeRecipient: config.protocolFeeRecipient,
                router: config.router,
                graduationQuoteReserve: config.graduationQuoteReserve,
                whitelistThreshold: config.whitelistThreshold,
                whitelistSlotSize: config.whitelistSlotSize,
                whitelistOpensAt: config.whitelistOpensAt,
                whitelistAddresses: config.whitelistAddresses,
                launchModeId: config.launchModeId
            }))
        );
    }
}
