import factoryArtifact from "./artifacts/LaunchFactory.json";
import tokenArtifact from "./artifacts/LaunchToken.json";
import pairArtifact from "./artifacts/IUniswapV2LikePair.json";

export const launchFactoryAbi = factoryArtifact.abi;
const extraTokenAbi = [
  {
    type: "function",
    name: "taxConfig",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "enabled", type: "bool" },
      { name: "configuredTaxBps", type: "uint16" },
      { name: "burnBps", type: "uint16" },
      { name: "treasuryBps", type: "uint16" },
      { name: "wallet", type: "address" },
      { name: "active", type: "bool" }
    ]
  }
] as const;

export const launchTokenAbi = [...tokenArtifact.abi, ...extraTokenAbi] as const;
export const v2PairAbi = pairArtifact.abi;
