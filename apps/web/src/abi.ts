import factoryArtifact from "../../../packages/contracts/artifacts/contracts/LaunchFactory.sol/LaunchFactory.json";
import tokenArtifact from "../../../packages/contracts/artifacts/contracts/LaunchToken.sol/LaunchToken.json";
import pairArtifact from "../../../packages/contracts/artifacts/contracts/interfaces/IUniswapV2LikePair.sol/IUniswapV2LikePair.json";

export const launchFactoryAbi = factoryArtifact.abi;
export const launchTokenAbi = tokenArtifact.abi;
export const v2PairAbi = pairArtifact.abi;
export const launchTokenBytecode = tokenArtifact.bytecode as `0x${string}`;
