// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {LaunchTokenTaxed} from "./LaunchTokenTaxed.sol";

contract LaunchTokenTaxedDeployer {
    address private recoveryRecipient;

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
        uint8 launchModeId;
        uint16 taxBps;
        uint16 burnShareBps;
        uint16 treasuryShareBps;
        address treasuryWallet;
        bytes32 salt;
    }

    constructor() {
        recoveryRecipient = msg.sender;
    }

    function deploy(DeployConfig calldata config) external returns (address token) {
        if (msg.sender != config.factory) revert Unauthorized();
        token = address(
            new LaunchTokenTaxed{salt: config.salt}(LaunchTokenTaxed.TaxedConstructorArgs({
                name: config.name,
                symbol: config.symbol,
                metadataURI: config.metadataURI,
                creator: config.creator,
                factory: config.factory,
                protocolFeeRecipient: config.protocolFeeRecipient,
                router: config.router,
                graduationQuoteReserve: config.graduationQuoteReserve,
                launchModeId: config.launchModeId,
                taxBps: config.taxBps,
                burnShareBps: config.burnShareBps,
                treasuryShareBps: config.treasuryShareBps,
                treasuryWallet: config.treasuryWallet
            }))
        );
    }

    function recoverUnexpectedNative() external {
        uint256 amount = address(this).balance;
        bool ok;
        address recipient = recoveryRecipient;
        assembly ("memory-safe") {
            ok := call(gas(), recipient, amount, 0, 0, 0, 0)
        }
        if (!ok) revert Unauthorized();
    }
}
