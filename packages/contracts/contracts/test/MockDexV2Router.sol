// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MockDexV2Factory} from "./MockDexV2Factory.sol";
import {MockDexV2Pair} from "./MockDexV2Pair.sol";
import {MockERC20} from "./MockERC20.sol";

interface IERC20Transfer {
    function transferFrom(address from, address to, uint256 value) external returns (bool);
}

contract MockDexV2Router {
    address public immutable factory;
    address public immutable WETH;

    constructor(address factory_, address wrappedNative_) {
        factory = factory_;
        WETH = wrappedNative_;
    }

    function addLiquidityETH(
        address token,
        uint256 amountTokenDesired,
        uint256 amountTokenMin,
        uint256 amountETHMin,
        address to,
        uint256 deadline
    ) external payable returns (uint256 amountToken, uint256 amountETH, uint256 liquidity) {
        amountTokenMin;
        amountETHMin;
        deadline;

        address pair = MockDexV2Factory(factory).getPair(token, WETH);
        require(pair != address(0), "PAIR_NOT_FOUND");

        IERC20Transfer(token).transferFrom(msg.sender, pair, amountTokenDesired);
        MockERC20(WETH).mint(pair, msg.value);

        amountToken = amountTokenDesired;
        amountETH = msg.value;
        liquidity = MockDexV2Pair(pair).initializeLiquidityFromBalances(to);
    }
}
