import factoryArtifact from "./artifacts/LaunchFactory.json";
import tokenArtifact from "./artifacts/LaunchToken.json";
import whitelistTokenArtifact from "./artifacts/LaunchTokenWhitelist.json";
import pairArtifact from "./artifacts/IUniswapV2LikePair.json";

export const launchFactoryAbi = factoryArtifact.abi;
export const launchTokenAbi = tokenArtifact.abi;
export const launchTokenWhitelistAbi = whitelistTokenArtifact.abi;
export const v2PairAbi = pairArtifact.abi;
export const launchTokenBytecode = tokenArtifact.bytecode as `0x${string}`;
export const launchTokenWhitelistBytecode = whitelistTokenArtifact.bytecode as `0x${string}`;
