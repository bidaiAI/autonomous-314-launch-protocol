import { bsc, hardhat, mainnet, type Chain } from "viem/chains";

export type ProtocolChainProfile = {
  chainId: number;
  chain: Chain;
  chainLabel: string;
  nativeSymbol: string;
  wrappedNativeSymbol: string;
  dexName: string;
  defaultRpcUrl: string;
  official: boolean;
};

const profiles: Record<number, ProtocolChainProfile> = {
  1: {
    chainId: 1,
    chain: mainnet,
    chainLabel: "Ethereum",
    nativeSymbol: "ETH",
    wrappedNativeSymbol: "WETH",
    dexName: "Uniswap V2",
    defaultRpcUrl: "https://ethereum-rpc.publicnode.com",
    official: false
  },
  56: {
    chainId: 56,
    chain: bsc,
    chainLabel: "BNB Smart Chain",
    nativeSymbol: "BNB",
    wrappedNativeSymbol: "WBNB",
    dexName: "PancakeSwap V2",
    defaultRpcUrl: "https://bsc-dataseed.binance.org",
    official: true
  },
  31337: {
    chainId: 31337,
    chain: hardhat,
    chainLabel: "Local Hardhat",
    nativeSymbol: "ETH",
    wrappedNativeSymbol: "WETH",
    dexName: "Local V2 DEX",
    defaultRpcUrl: "http://127.0.0.1:8545",
    official: false
  }
};

export function resolveProtocolProfile(chainId: number): ProtocolChainProfile {
  return profiles[chainId] ?? profiles[56];
}

export const activeProtocolProfile = resolveProtocolProfile(Number(import.meta.env.VITE_CHAIN_ID ?? 56));
