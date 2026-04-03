// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {LaunchTokenBase} from "./LaunchTokenBase.sol";
import {ILaunchFactoryRegistry} from "./interfaces/ILaunchFactoryRegistry.sol";

contract LaunchToken is LaunchTokenBase {
    error UnauthorizedFactoryDeployment();

    struct ConstructorArgs {
        string name;
        string symbol;
        string metadataURI;
        address creator;
        address factory;
        address protocolFeeRecipient;
        address router;
        uint256 graduationQuoteReserve;
    }

    constructor(ConstructorArgs memory args) LaunchTokenBase(
        args.name,
        args.symbol,
        args.metadataURI,
        args.creator,
        args.factory,
        args.protocolFeeRecipient,
        args.router,
        args.graduationQuoteReserve,
        MODE_STANDARD_0314,
        LaunchState.Bonding314
    ) {
        if (!_isAuthorizedFactoryDeployment(args.factory)) revert UnauthorizedFactoryDeployment();
    }

    receive() external payable nonReentrant {
        if (state != LaunchState.Bonding314) revert InvalidState();
        _buy(msg.sender, 0);
    }

    function launchSuffix() external pure override returns (string memory) {
        return "0314";
    }

    function _isAuthorizedFactoryDeployment(address factory_) private view returns (bool) {
        if (msg.sender == factory_) return true;
        if (factory_.code.length == 0) return false;
        return msg.sender == ILaunchFactoryRegistry(factory_).standardDeployer();
    }
}
