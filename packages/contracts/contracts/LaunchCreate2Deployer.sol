// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract LaunchCreate2Deployer {
    error Create2DeploymentFailed();
    error Unauthorized();
    error AlreadyConfigured();

    address public immutable owner;
    address public factory;

    constructor() {
        owner = msg.sender;
    }

    function setFactory(address factory_) external {
        if (msg.sender != owner) revert Unauthorized();
        if (factory != address(0)) revert AlreadyConfigured();
        if (factory_ == address(0)) revert Unauthorized();
        factory = factory_;
    }

    function deploy(bytes32 salt, bytes calldata initCode) external returns (address deployed) {
        if (msg.sender != factory) revert Unauthorized();
        bytes memory creationCode = initCode;
        assembly {
            deployed := create2(0, add(creationCode, 0x20), mload(creationCode), salt)
        }
        if (deployed == address(0)) revert Create2DeploymentFailed();
    }

    function predict(bytes32 salt, bytes32 initCodeHash) external view returns (address predicted) {
        predicted = address(
            uint160(
                uint256(
                    keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, initCodeHash))
                )
            )
        );
    }
}
