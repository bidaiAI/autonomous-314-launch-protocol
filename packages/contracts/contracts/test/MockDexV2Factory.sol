// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MockDexV2Pair} from "./MockDexV2Pair.sol";

contract MockDexV2Factory {
    mapping(address => mapping(address => address)) public getPair;

    function createPair(address tokenA, address tokenB) external returns (address pair) {
        require(getPair[tokenA][tokenB] == address(0), "PAIR_EXISTS");
        MockDexV2Pair deployed = new MockDexV2Pair(tokenA, tokenB);
        pair = address(deployed);
        getPair[tokenA][tokenB] = pair;
        getPair[tokenB][tokenA] = pair;
    }
}
