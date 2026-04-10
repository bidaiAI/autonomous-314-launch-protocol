import { useSyncExternalStore } from "react";
import { base, bsc, hardhat, mainnet, type Chain } from "viem/chains";

export type ProtocolChainProfile = {
  chainId: number;
  chain: Chain;
  chainLabel: string;
  nativeSymbol: string;
  wrappedNativeSymbol: string;
  dexName: string;
  defaultRpcUrl: string;
  officialFactoryAddress: string;
  indexerApiBaseUrl: string;
  indexerSnapshotUrl: string;
  enabled: boolean;
  official: boolean;
  whitelistThresholdOptions: readonly string[];
  whitelistSlotSizeOptions: readonly string[];
  defaultWhitelistThreshold: string;
  defaultWhitelistSlotSize: string;
};

const DEFAULT_CHAIN_ID = Number(import.meta.env.VITE_CHAIN_ID ?? 56);
const STORAGE_KEY = "a314_chain_id";
const selectableChainIds = [56, 8453] as const;
const listeners = new Set<() => void>();

function resolveRuntimeIndexerApiBaseUrl(configuredUrl: string | undefined, devProxyPath: string) {
  const normalized = configuredUrl?.trim() ?? "";
  if (!normalized) return "";
  if (import.meta.env.DEV && /^https?:\/\//i.test(normalized)) {
    return devProxyPath;
  }
  return normalized;
}

const profiles: Record<number, ProtocolChainProfile> = {
  1: {
    chainId: 1,
    chain: mainnet,
    chainLabel: "Ethereum",
    nativeSymbol: "ETH",
    wrappedNativeSymbol: "WETH",
    dexName: "Uniswap V2",
    defaultRpcUrl: "https://ethereum-rpc.publicnode.com",
    officialFactoryAddress: "",
    indexerApiBaseUrl: "",
    indexerSnapshotUrl: "/data/indexer-snapshot.json",
    enabled: false,
    official: false,
    whitelistThresholdOptions: ["4", "6", "8"],
    whitelistSlotSizeOptions: ["0.1", "0.2", "0.5", "1"],
    defaultWhitelistThreshold: "4",
    defaultWhitelistSlotSize: "0.2"
  },
  56: {
    chainId: 56,
    chain: bsc,
    chainLabel: "BNB Smart Chain",
    nativeSymbol: "BNB",
    wrappedNativeSymbol: "WBNB",
    dexName: "PancakeSwap V2",
    defaultRpcUrl: (import.meta.env.VITE_RPC_URL ?? "https://bsc-dataseed.binance.org").trim(),
    officialFactoryAddress: (import.meta.env.VITE_FACTORY_ADDRESS ?? "").trim(),
    indexerApiBaseUrl: resolveRuntimeIndexerApiBaseUrl(import.meta.env.VITE_INDEXER_API_URL, "/__proxy/indexer"),
    indexerSnapshotUrl: import.meta.env.VITE_INDEXER_SNAPSHOT_URL ?? "/data/indexer-snapshot.json",
    enabled: true,
    official: true,
    whitelistThresholdOptions: ["4", "6", "8"],
    whitelistSlotSizeOptions: ["0.1", "0.2", "0.5", "1"],
    defaultWhitelistThreshold: "4",
    defaultWhitelistSlotSize: "0.2"
  },
  8453: {
    chainId: 8453,
    chain: base,
    chainLabel: "Base",
    nativeSymbol: "ETH",
    wrappedNativeSymbol: "WETH",
    dexName: "QuickSwap V2",
    defaultRpcUrl: (import.meta.env.VITE_BASE_RPC_URL ?? "https://mainnet.base.org").trim(),
    officialFactoryAddress: (import.meta.env.VITE_BASE_FACTORY_ADDRESS ?? "").trim(),
    indexerApiBaseUrl: resolveRuntimeIndexerApiBaseUrl(
      import.meta.env.VITE_BASE_INDEXER_API_URL,
      "/__proxy/base-indexer"
    ),
    indexerSnapshotUrl: import.meta.env.VITE_BASE_INDEXER_SNAPSHOT_URL ?? "/data/base-indexer-snapshot.json",
    enabled: Boolean((import.meta.env.VITE_BASE_FACTORY_ADDRESS ?? "").trim()),
    official: true,
    whitelistThresholdOptions: ["1", "2", "3"],
    whitelistSlotSizeOptions: ["0.04", "0.1", "0.2", "0.5"],
    defaultWhitelistThreshold: "1",
    defaultWhitelistSlotSize: "0.1"
  },
  31337: {
    chainId: 31337,
    chain: hardhat,
    chainLabel: "Local Hardhat",
    nativeSymbol: "ETH",
    wrappedNativeSymbol: "WETH",
    dexName: "Local V2 DEX",
    defaultRpcUrl: "http://127.0.0.1:8545",
    officialFactoryAddress: "",
    indexerApiBaseUrl: "",
    indexerSnapshotUrl: "/data/indexer-snapshot.json",
    enabled: false,
    official: false,
    whitelistThresholdOptions: ["4", "6", "8"],
    whitelistSlotSizeOptions: ["0.1", "0.2", "0.5", "1"],
    defaultWhitelistThreshold: "4",
    defaultWhitelistSlotSize: "0.2"
  }
};

function readStoredChainId() {
  if (typeof window === "undefined") return DEFAULT_CHAIN_ID;
  const stored = Number(window.localStorage.getItem(STORAGE_KEY) ?? DEFAULT_CHAIN_ID);
  const resolved = Number.isFinite(stored) && stored > 0 ? stored : DEFAULT_CHAIN_ID;
  const profile = resolveProtocolProfile(resolved);
  if (profile.enabled) return profile.chainId;
  return resolveProtocolProfile(DEFAULT_CHAIN_ID).enabled ? DEFAULT_CHAIN_ID : 56;
}

let currentChainId = readStoredChainId();

export function resolveProtocolProfile(chainId: number): ProtocolChainProfile {
  return profiles[chainId] ?? profiles[56];
}

export function getActiveProtocolProfile(): ProtocolChainProfile {
  return resolveProtocolProfile(currentChainId);
}

export function setActiveProtocolChainId(chainId: number) {
  const targetProfile = resolveProtocolProfile(chainId);
  const fallbackChainId = resolveProtocolProfile(DEFAULT_CHAIN_ID).enabled ? DEFAULT_CHAIN_ID : 56;
  const resolved = targetProfile.enabled ? targetProfile.chainId : fallbackChainId;
  if (resolved === currentChainId) return;
  currentChainId = resolved;
  if (typeof window !== "undefined") {
    window.localStorage.setItem(STORAGE_KEY, String(resolved));
  }
  listeners.forEach((listener) => listener());
}

export function onActiveProtocolProfileChange(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useActiveProtocolProfile() {
  return useSyncExternalStore(onActiveProtocolProfileChange, getActiveProtocolProfile, getActiveProtocolProfile);
}

export function getSelectableProtocolProfiles(currentChainId = getActiveProtocolProfile().chainId) {
  const currentProfile = resolveProtocolProfile(currentChainId);
  const baseProfiles = selectableChainIds.map((chainId) => resolveProtocolProfile(chainId)).filter((profile) => profile.enabled);
  if (baseProfiles.some((profile) => profile.chainId === currentProfile.chainId)) {
    return baseProfiles;
  }
  return currentProfile.enabled ? [currentProfile, ...baseProfiles] : baseProfiles;
}
