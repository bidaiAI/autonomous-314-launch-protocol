// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IUniswapV2LikeFactory {
    function getPair(address tokenA, address tokenB) external view returns (address pair);
    function createPair(address tokenA, address tokenB) external returns (address pair);
}
