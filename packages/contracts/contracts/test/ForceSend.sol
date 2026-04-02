// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract ForceSend {
    constructor() payable {}

    function boom(address payable target) external {
        selfdestruct(target);
    }
}
