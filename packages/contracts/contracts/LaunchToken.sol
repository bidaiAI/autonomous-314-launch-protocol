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
        uint8 launchModeId;
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
        args.launchModeId,
        LaunchState.Bonding314
    ) {
        if (!_isAuthorizedFactoryDeployment(args.factory)) revert UnauthorizedFactoryDeployment();
    }

    receive() external payable nonReentrant {
        if (state != LaunchState.Bonding314) revert InvalidState();
        _buyFrom(msg.sender, payable(msg.sender), 0);
    }

    function launchSuffix() public view virtual override returns (string memory) {
        return "0314";
    }

    function _isAuthorizedFactoryDeployment(address factory_) private view returns (bool) {
        if (msg.sender == factory_) return true;
        if (factory_.code.length == 0) return false;
        ILaunchFactoryRegistry registry = ILaunchFactoryRegistry(factory_);
        if (launchModeId == MODE_STANDARD_0314) {
            return msg.sender == registry.standardDeployer();
        }
        if (launchModeId >= MODE_TAXED_1314 && launchModeId <= MODE_TAXED_9314) {
            return msg.sender == registry.taxedDeployer();
        }
        return false;
    }
}
