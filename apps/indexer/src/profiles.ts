import { base, bsc, hardhat, mainnet, type Chain } from "viem/chains";

export type IndexerChainProfile = {
  chainId: number;
  chainLabel: string;
  nativeSymbol: string;
  wrappedNativeSymbol: string;
  dexName: string;
  defaultRpcUrl: string;
  explorerApiUrl: string;
  nativeUsdPriceApiUrl: string;
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
    explorerApiUrl: "https://api.etherscan.io/v2/api",
    nativeUsdPriceApiUrl: "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd",
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
    explorerApiUrl: "https://api.bscscan.com/api",
    nativeUsdPriceApiUrl: "https://api.coingecko.com/api/v3/simple/price?ids=binancecoin&vs_currencies=usd",
    viemChain: bsc,
    official: true
  },
  8453: {
    chainId: 8453,
    chainLabel: "Base",
    nativeSymbol: "ETH",
    wrappedNativeSymbol: "WETH",
    dexName: "QuickSwap V2",
    defaultRpcUrl: "https://mainnet.base.org",
    explorerApiUrl: "https://api.basescan.org/api",
    nativeUsdPriceApiUrl: "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd",
    viemChain: base,
    official: true
  },
  31337: {
    chainId: 31337,
    chainLabel: "Local Hardhat",
    nativeSymbol: "ETH",
    wrappedNativeSymbol: "WETH",
    dexName: "Local V2 DEX",
    defaultRpcUrl: "http://127.0.0.1:8545",
    explorerApiUrl: "https://api.etherscan.io/v2/api",
    nativeUsdPriceApiUrl: "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd",
    viemChain: hardhat,
    official: false
  }
};

export function resolveIndexerProfile(chainId: number): IndexerChainProfile {
  return profiles[chainId] ?? profiles[56];
}
