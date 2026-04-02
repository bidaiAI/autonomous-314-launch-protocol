import { bsc, hardhat, mainnet, type Chain } from "viem/chains";

export type IndexerChainProfile = {
  chainId: number;
  chainLabel: string;
  nativeSymbol: string;
  wrappedNativeSymbol: string;
  dexName: string;
  defaultRpcUrl: string;
  viemChain: Chain;
  official: boolean;
};

const profiles: Record<number, IndexerChainProfile> = {
  1: {
    chainId: 1,
    chainLabel: "Ethereum",
    nativeSymbol: "ETH",
    wrappedNativeSymbol: "WETH",
    dexName: "Uniswap V2",
    defaultRpcUrl: "https://ethereum-rpc.publicnode.com",
    viemChain: mainnet,
    official: false
  },
  56: {
    chainId: 56,
    chainLabel: "BNB Smart Chain",
    nativeSymbol: "BNB",
    wrappedNativeSymbol: "WBNB",
    dexName: "PancakeSwap V2",
    defaultRpcUrl: "https://bsc-dataseed.binance.org",
    viemChain: bsc,
    official: true
  },
  31337: {
    chainId: 31337,
    chainLabel: "Local Hardhat",
    nativeSymbol: "ETH",
    wrappedNativeSymbol: "WETH",
    dexName: "Local V2 DEX",
    defaultRpcUrl: "http://127.0.0.1:8545",
    viemChain: hardhat,
    official: false
  }
};

export function resolveIndexerProfile(chainId: number): IndexerChainProfile {
  return profiles[chainId] ?? profiles[56];
}
