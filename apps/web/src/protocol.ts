import {
  concatHex,
  createPublicClient,
  createWalletClient,
  custom,
  decodeEventLog,
  encodeAbiParameters,
  encodeEventTopics,
  formatEther,
  formatUnits,
  getAddress,
  http,
  keccak256,
  parseEther,
  parseUnits,
  type Hex,
  type Log
} from "viem";
import {
  launchFactoryAbi,
  launchTokenAbi,
  launchTokenBytecode,
  launchTokenTaxedAbi,
  launchTokenTaxedBytecode,
  launchTokenWhitelistAbi,
  launchTokenWhitelistBytecode,
  launchTokenWhitelistTaxedAbi,
  launchTokenWhitelistTaxedBytecode,
  v2PairAbi
} from "./abi";
import { activeProtocolProfile } from "./profiles";
import type {
  ActivityFeedItem,
  CandlePoint,
  FactorySnapshot,
  LaunchCreationFamily,
  LaunchMode,
  LaunchMetadata,
  ProtocolVerification,
  SegmentedChartSnapshot,
  TokenSnapshot,
  TaxConfig,
  TradeFeedItem
} from "./types";

const launchStates = ["Created", "Bonding314", "Migrating", "DEXOnly", "WhitelistCommit"] as const;
const launchModes = [
  "Unregistered",
  "Standard0314",
  "WhitelistB314",
  "Taxed1314",
  "Taxed2314",
  "Taxed3314",
  "Taxed4314",
  "Taxed5314",
  "Taxed6314",
  "Taxed7314",
  "Taxed8314",
  "Taxed9314",
  "WhitelistTaxF314"
] as const;
const indexerApiBase = import.meta.env.VITE_INDEXER_API_URL?.replace(/\/$/, "");
const snapshotUrl = import.meta.env.VITE_INDEXER_SNAPSHOT_URL ?? "/data/indexer-snapshot.json";
const zeroAddress = getAddress("0x0000000000000000000000000000000000000000");
const standardVanitySuffix = "0314";
const whitelistVanitySuffix = "b314";
const whitelistTaxVanitySuffix = "f314";

const appChain = activeProtocolProfile.chain;
const appRpcUrl = import.meta.env.VITE_RPC_URL || activeProtocolProfile.defaultRpcUrl;
const v2FactoryAbi = [
  {
    type: "function",
    name: "getPair",
    stateMutability: "view",
    inputs: [
      { name: "tokenA", type: "address" },
      { name: "tokenB", type: "address" }
    ],
    outputs: [{ name: "pair", type: "address" }]
  }
] as const;
const legacyFactoryAbi = [
  {
    type: "function",
    name: "createFee",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }]
  },
  {
    type: "function",
    name: "totalLaunches",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }]
  },
  {
    type: "function",
    name: "allLaunches",
    stateMutability: "view",
    inputs: [{ name: "", type: "uint256" }],
    outputs: [{ name: "", type: "address" }]
  },
  {
    type: "event",
    name: "LaunchCreated",
    anonymous: false,
    inputs: [
      { indexed: true, name: "creator", type: "address" },
      { indexed: true, name: "token", type: "address" },
      { indexed: false, name: "name", type: "string" },
      { indexed: false, name: "symbol", type: "string" },
      { indexed: false, name: "metadataURI", type: "string" }
    ]
  }
] as const;
const launchCreatedEventAbi = launchFactoryAbi.find(
  (entry) => entry.type === "event" && entry.name === "LaunchCreated"
) as (typeof launchFactoryAbi)[number] | undefined;

export function buildLaunchMetadata(params: {
  name: string;
  symbol: string;
  description?: string;
  image?: string;
  website?: string;
  twitter?: string;
  telegram?: string;
  discord?: string;
}): LaunchMetadata {
  const description = params.description?.trim();
  const image = params.image?.trim();
  const website = params.website?.trim();
  const twitter = params.twitter?.trim();
  const telegram = params.telegram?.trim();
  const discord = params.discord?.trim();

  return {
    version: "autonomous314/v1",
    name: params.name.trim(),
    symbol: params.symbol.trim(),
    ...(description ? { description } : {}),
    ...(image ? { image } : {}),
    ...(website ? { external_url: website, website } : {}),
    ...(twitter ? { twitter } : {}),
    ...(telegram ? { telegram } : {}),
    ...(discord ? { discord } : {})
  };
}

export function buildInlineMetadataUri(metadata: LaunchMetadata) {
  return `data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(metadata))}`;
}

export function downloadLaunchMetadata(metadata: LaunchMetadata, filename = "metadata.json") {
  const blob = new Blob([JSON.stringify(metadata, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

type SnapshotActivityJson =
  | {
      kind: "trade";
      token: `0x${string}`;
      marketAddress: `0x${string}`;
      txHash: `0x${string}`;
      blockNumber: string;
      logIndex: number;
      timestampMs: number;
      source: "protocol" | "dex";
      phase: "bonding" | "dexOnly";
      side: "buy" | "sell";
      grossQuote: string;
      netQuote: string;
      protocolFee: string;
      creatorFee: string;
      tokenAmount: string;
    }
  | {
      kind: "graduated";
      token: `0x${string}`;
      marketAddress: `0x${string}`;
      txHash: `0x${string}`;
      blockNumber: string;
      logIndex: number;
      timestampMs: number;
      source: "system";
      phase: "migrating";
      quoteAmountContributed: string;
      preloadedQuoteAmount: string;
      tokenAmount: string;
      liquidityBurned: string;
    };

type SnapshotCandleJson = {
  bucketStart: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volumeQuote: string;
  volumeToken: string;
  trades: number;
};

type SnapshotLaunchJson = {
  token: `0x${string}`;
  creator: `0x${string}`;
  name: string;
  symbol: string;
  mode: number;
  suffix: string;
  metadataURI: string;
  state: string;
  pair: `0x${string}`;
  currentPriceQuotePerToken: string;
  graduationProgressBps: number;
  remainingQuoteCapacity: string;
  pairPreloadedQuote: string;
  pairClean: boolean;
  pairGraduationCompatible: boolean;
  protocolClaimable: string;
  creatorClaimable: string;
  taxConfig?: {
    enabled: boolean;
    taxBps: string;
    burnShareBps: string;
    treasuryShareBps: string;
    treasuryWallet: `0x${string}` | null;
    active: boolean;
  } | null;
  whitelistStatus?: number;
  whitelistSnapshot?: {
    status: string | number;
    opensAt: string;
    deadline: string;
    threshold: string;
    slotSize: string;
    seatCount: string;
    seatsFilled: string;
    committedTotal: string;
    tokensPerSeat: string;
  } | null;
  dexTokenReserve: string;
  dexQuoteReserve: string;
  recentActivity: SnapshotActivityJson[];
  segmentedChart: {
    bondingCandles: SnapshotCandleJson[];
    dexCandles: SnapshotCandleJson[];
    graduationTimestampMs: number | null;
  };
};

type ApiLaunchSummaryJson = {
  token: `0x${string}`;
  creator?: `0x${string}`;
  metadataURI?: string;
  symbol: string;
  name: string;
  mode?: number;
  modeLabel?: LaunchMode;
  suffix?: string;
  state: string;
  pair: `0x${string}`;
  graduationQuoteReserve: string;
  currentPriceQuotePerToken: string;
  graduationProgressBps: number;
  pairPreloadedQuote: string;
  taxConfig?: SnapshotLaunchJson["taxConfig"];
  whitelistStatus?: string;
  whitelistSnapshot?: SnapshotLaunchJson["whitelistSnapshot"];
};

type ApiLaunchesJson = {
  generatedAtMs: number;
  factory: `0x${string}`;
  count: number;
  launches: ApiLaunchSummaryJson[];
};

type ApiLaunchActivityJson = {
  token: `0x${string}`;
  factory: `0x${string}`;
  generatedAtMs: number;
  count: number;
  recentActivity: SnapshotActivityJson[];
};

type ApiLaunchChartJson = {
  token: `0x${string}`;
  factory: `0x${string}`;
  generatedAtMs: number;
  segmentedChart: {
    bondingCandles: SnapshotCandleJson[];
    dexCandles: SnapshotCandleJson[];
    graduationTimestampMs: number | null;
  };
};

type IndexerSnapshotJson = {
  generatedAtMs: number;
  chain: string;
  factory: `0x${string}`;
  fromBlock: string;
  toBlock: string;
  launchCount: number;
  launches: SnapshotLaunchJson[];
};

let cachedIndexerSnapshot: Promise<IndexerSnapshotJson | null> | null = null;
const metadataResolutionCache = new Map<string, Promise<LaunchMetadata | null>>();

function launchModeFromId(modeId: number): LaunchMode {
  return (launchModes[modeId] ?? "Unregistered") as LaunchMode;
}

function expectedSuffixForMode(modeId: number, taxBps?: number) {
  if (modeId === 1) return standardVanitySuffix;
  if (modeId === 2) return whitelistVanitySuffix;
  if (modeId >= 3 && modeId <= 11) {
    const normalizedTaxBps = taxBps ?? (modeId - 2) * 100;
    return `${Math.floor(normalizedTaxBps / 100)}314`;
  }
  if (modeId === 12) return whitelistTaxVanitySuffix;
  return "";
}

function deployerForFamily(snapshot: FactorySnapshot, family: LaunchCreationFamily) {
  if (family === "whitelist") return snapshot.whitelistDeployer || snapshot.standardDeployer;
  if (family === "taxed") return snapshot.taxedDeployer || snapshot.standardDeployer;
  if (family === "whitelistTaxed") return snapshot.whitelistTaxedDeployer || snapshot.whitelistDeployer || snapshot.standardDeployer;
  return snapshot.standardDeployer;
}

export function getPublicClient() {
  return createPublicClient({
    chain: appChain,
    transport: http(appRpcUrl)
  });
}

async function readIndexerSnapshot(): Promise<IndexerSnapshotJson | null> {
  if (cachedIndexerSnapshot) {
    return cachedIndexerSnapshot;
  }

  cachedIndexerSnapshot = readJson<IndexerSnapshotJson>(snapshotUrl);

  return cachedIndexerSnapshot;
}

async function readJson<T>(url: string): Promise<T | null> {
  return fetch(url)
    .then(async (response) => {
      if (!response.ok) return null;
      return (await response.json()) as T;
    })
    .catch(() => null);
}

function decodeDataUriPayload(uri: string) {
  const commaIndex = uri.indexOf(",");
  if (commaIndex === -1) return null;

  const header = uri.slice(5, commaIndex);
  const payload = uri.slice(commaIndex + 1);

  try {
    if (header.includes(";base64")) {
      return atob(payload);
    }

    return decodeURIComponent(payload);
  } catch {
    return null;
  }
}

function metadataUriToFetchUrl(uri: string) {
  if (!uri) return null;
  if (uri.startsWith("http://") || uri.startsWith("https://")) return uri;
  if (uri.startsWith("ipfs://")) return `https://ipfs.io/ipfs/${uri.replace("ipfs://", "")}`;
  if (uri.startsWith("ar://")) return `https://arweave.net/${uri.replace("ar://", "")}`;
  return null;
}

function convertJsonTaxConfig(
  taxConfig:
    | {
        enabled: boolean;
        taxBps: string;
        burnShareBps: string;
        treasuryShareBps: string;
        treasuryWallet: `0x${string}` | null;
        active: boolean;
      }
    | null
    | undefined
): TokenSnapshot["taxConfig"] {
  if (!taxConfig) return null;

  return {
    enabled: taxConfig.enabled,
    configuredTaxBps: BigInt(taxConfig.taxBps),
    burnBps: BigInt(taxConfig.burnShareBps),
    treasuryBps: BigInt(taxConfig.treasuryShareBps),
    wallet: getAddress(taxConfig.treasuryWallet ?? zeroAddress),
    active: taxConfig.active
  };
}

function normalizeLaunchMetadata(raw: unknown): LaunchMetadata | null {
  if (!raw || typeof raw !== "object") return null;
  const candidate = raw as Record<string, unknown>;
  const name = typeof candidate.name === "string" ? candidate.name.trim() : "";
  const symbol = typeof candidate.symbol === "string" ? candidate.symbol.trim() : "";
  const version = candidate.version === "autonomous314/v1" ? "autonomous314/v1" : null;

  if (!name || !symbol || !version) {
    return null;
  }

  const description = typeof candidate.description === "string" ? candidate.description.trim() : "";
  const image = typeof candidate.image === "string" ? candidate.image.trim() : "";
  const external_url = typeof candidate.external_url === "string" ? candidate.external_url.trim() : "";
  const website = typeof candidate.website === "string" ? candidate.website.trim() : "";
  const twitter = typeof candidate.twitter === "string" ? candidate.twitter.trim() : "";
  const telegram = typeof candidate.telegram === "string" ? candidate.telegram.trim() : "";
  const discord = typeof candidate.discord === "string" ? candidate.discord.trim() : "";

  return {
    version,
    name,
    symbol,
    ...(description ? { description } : {}),
    ...(image ? { image } : {}),
    ...(external_url ? { external_url } : {}),
    ...(website ? { website } : {}),
    ...(twitter ? { twitter } : {}),
    ...(telegram ? { telegram } : {}),
    ...(discord ? { discord } : {})
  };
}

export async function resolveLaunchMetadata(metadataURI: string): Promise<LaunchMetadata | null> {
  const normalizedUri = metadataURI.trim();
  if (!normalizedUri) return null;

  const cached = metadataResolutionCache.get(normalizedUri);
  if (cached) return cached;

  const promise = (async () => {
    if (normalizedUri.startsWith("data:")) {
      const decoded = decodeDataUriPayload(normalizedUri);
      if (!decoded) return null;

      try {
        return normalizeLaunchMetadata(JSON.parse(decoded));
      } catch {
        return null;
      }
    }

    const fetchUrl = metadataUriToFetchUrl(normalizedUri);
    if (!fetchUrl) return null;

    try {
      const response = await fetch(fetchUrl);
      if (!response.ok) return null;
      return normalizeLaunchMetadata(await response.json());
    } catch {
      return null;
    }
  })();

  metadataResolutionCache.set(normalizedUri, promise);
  return promise;
}

async function readApiLaunchSummaries(
  factoryAddress: `0x${string}`,
  graduationQuoteReserve: bigint,
  limit = 5
): Promise<TokenSnapshot[] | null> {
  if (!indexerApiBase) return null;

  const response = await readJson<ApiLaunchesJson>(`${indexerApiBase}/launches?limit=${limit}`);
  if (!response) return null;
  if (response.factory.toLowerCase() !== factoryAddress.toLowerCase()) {
    return null;
  }

  return response.launches.map((launch) => convertApiLaunchSummary(launch, graduationQuoteReserve));
}

async function readApiLaunchWorkspace(tokenAddress: `0x${string}`): Promise<{
  recentActivity: ActivityFeedItem[];
  segmentedChart: SegmentedChartSnapshot;
} | null> {
  if (!indexerApiBase) return null;

  const [activityResponse, chartResponse] = await Promise.all([
    readJson<ApiLaunchActivityJson>(`${indexerApiBase}/launches/${tokenAddress}/activity?limit=40`),
    readJson<ApiLaunchChartJson>(`${indexerApiBase}/launches/${tokenAddress}/chart`)
  ]);

  if (!activityResponse || !chartResponse) {
    return null;
  }

  if (activityResponse.token.toLowerCase() !== tokenAddress.toLowerCase()) {
    return null;
  }
  if (chartResponse.token.toLowerCase() !== tokenAddress.toLowerCase()) {
    return null;
  }

  return {
    recentActivity: activityResponse.recentActivity.map(convertSnapshotActivity),
    segmentedChart: {
      bondingCandles: chartResponse.segmentedChart.bondingCandles.map(convertSnapshotCandle),
      dexCandles: chartResponse.segmentedChart.dexCandles.map(convertSnapshotCandle),
      graduationTimestampMs: chartResponse.segmentedChart.graduationTimestampMs
    }
  };
}

export async function connectWallet() {
  if (!window.ethereum) {
    throw new Error("No injected wallet found");
  }

  const [account] = await window.ethereum.request({ method: "eth_requestAccounts" });
  const chainId = await getWalletChainId();
  const walletClient = createWalletClient({
    chain: appChain,
    transport: custom(window.ethereum)
  });

  return {
    account: getAddress(account),
    walletClient,
    chainId,
    expectedChainId: appChain.id,
    chainMatches: chainId === appChain.id
  };
}

function getWalletClientOrThrow() {
  if (!window.ethereum) {
    throw new Error("No injected wallet found");
  }

  return createWalletClient({
    chain: appChain,
    transport: custom(window.ethereum)
  });
}

export async function getWalletChainId() {
  if (!window.ethereum) {
    return null;
  }

  const chainIdHex = (await window.ethereum.request({ method: "eth_chainId" })) as string;
  return Number.parseInt(chainIdHex, 16);
}

export async function isWalletOnExpectedChain() {
  const chainId = await getWalletChainId();
  return chainId === appChain.id;
}

export async function switchWalletToExpectedChain() {
  if (!window.ethereum) {
    throw new Error("No injected wallet found");
  }

  const targetChainHex = `0x${appChain.id.toString(16)}`;

  try {
    await window.ethereum.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: targetChainHex }]
    });
    return;
  } catch (error) {
    const switchError = error as { code?: number };
    if (switchError.code !== 4902) {
      throw error;
    }
  }

  await window.ethereum.request({
    method: "wallet_addEthereumChain",
    params: [
      {
        chainId: targetChainHex,
        chainName: activeProtocolProfile.chainLabel,
        nativeCurrency: appChain.nativeCurrency,
        rpcUrls: [appRpcUrl],
        blockExplorerUrls: appChain.blockExplorers?.default?.url ? [appChain.blockExplorers.default.url] : undefined
      }
    ]
  });
}

async function ensureWalletOnExpectedChain() {
  const chainId = await getWalletChainId();
  if (chainId !== appChain.id) {
    throw new Error(`Wrong network. Switch wallet to ${activeProtocolProfile.chainLabel} (chainId ${appChain.id}).`);
  }
}

async function getActiveAccount() {
  if (!window.ethereum) {
    throw new Error("No injected wallet found");
  }

  const accounts = (await window.ethereum.request({ method: "eth_accounts" })) as string[];
  if (!accounts[0]) {
    throw new Error("Connect wallet first");
  }

  return getAddress(accounts[0]);
}

function randomBytes32Hex(): Hex {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return `0x${Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("")}` as Hex;
}

function computeCreate2Address(deployer: `0x${string}`, salt: Hex, initCodeHash: Hex): `0x${string}` {
  const payload = concatHex(["0xff", deployer, salt, initCodeHash]);
  const hash = keccak256(payload);
  return getAddress(`0x${hash.slice(-40)}`);
}

function buildLaunchInitCode(params: {
  name: string;
  symbol: string;
  metadataURI: string;
  creator: `0x${string}`;
  factory: `0x${string}`;
  protocolFeeRecipient: `0x${string}`;
  router: `0x${string}`;
  graduationQuoteReserve: bigint;
}): Hex {
  const encodedArgs = encodeAbiParameters(
    [
      { type: "string" },
      { type: "string" },
      { type: "string" },
      { type: "address" },
      { type: "address" },
      { type: "address" },
      { type: "address" },
      { type: "uint256" }
    ],
    [
      params.name,
      params.symbol,
      params.metadataURI,
      params.creator,
      params.factory,
      params.protocolFeeRecipient,
      params.router,
      params.graduationQuoteReserve
    ]
  );

  return concatHex([launchTokenBytecode, encodedArgs]);
}

function buildWhitelistLaunchInitCode(params: {
  name: string;
  symbol: string;
  metadataURI: string;
  creator: `0x${string}`;
  factory: `0x${string}`;
  protocolFeeRecipient: `0x${string}`;
  router: `0x${string}`;
  graduationQuoteReserve: bigint;
  whitelistThreshold: bigint;
  whitelistSlotSize: bigint;
  whitelistOpensAt: bigint;
  whitelistAddresses: readonly `0x${string}`[];
}): Hex {
  const encodedArgs = encodeAbiParameters(
    [
      { type: "string" },
      { type: "string" },
      { type: "string" },
      { type: "address" },
      { type: "address" },
      { type: "address" },
      { type: "address" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "address[]" }
    ],
    [
      params.name,
      params.symbol,
      params.metadataURI,
      params.creator,
      params.factory,
      params.protocolFeeRecipient,
      params.router,
      params.graduationQuoteReserve,
      params.whitelistThreshold,
      params.whitelistSlotSize,
      params.whitelistOpensAt,
      params.whitelistAddresses
    ]
  );

  return concatHex([launchTokenWhitelistBytecode, encodedArgs]);
}

function buildTaxedLaunchInitCode(params: {
  name: string;
  symbol: string;
  metadataURI: string;
  creator: `0x${string}`;
  factory: `0x${string}`;
  protocolFeeRecipient: `0x${string}`;
  router: `0x${string}`;
  graduationQuoteReserve: bigint;
  launchModeId: number;
  taxBps: number;
  burnShareBps: number;
  treasuryShareBps: number;
  treasuryWallet: `0x${string}`;
}): Hex {
  const encodedArgs = encodeAbiParameters(
    [
      { type: "string" },
      { type: "string" },
      { type: "string" },
      { type: "address" },
      { type: "address" },
      { type: "address" },
      { type: "address" },
      { type: "uint256" },
      { type: "uint8" },
      { type: "uint16" },
      { type: "uint16" },
      { type: "uint16" },
      { type: "address" }
    ],
    [
      params.name,
      params.symbol,
      params.metadataURI,
      params.creator,
      params.factory,
      params.protocolFeeRecipient,
      params.router,
      params.graduationQuoteReserve,
      params.launchModeId,
      params.taxBps,
      params.burnShareBps,
      params.treasuryShareBps,
      params.treasuryWallet
    ]
  );

  return concatHex([launchTokenTaxedBytecode, encodedArgs]);
}

function buildWhitelistTaxedLaunchInitCode(params: {
  name: string;
  symbol: string;
  metadataURI: string;
  creator: `0x${string}`;
  factory: `0x${string}`;
  protocolFeeRecipient: `0x${string}`;
  router: `0x${string}`;
  graduationQuoteReserve: bigint;
  whitelistThreshold: bigint;
  whitelistSlotSize: bigint;
  whitelistOpensAt: bigint;
  whitelistAddresses: readonly `0x${string}`[];
  launchModeId: number;
  taxBps: number;
  burnShareBps: number;
  treasuryShareBps: number;
  treasuryWallet: `0x${string}`;
}): Hex {
  const encodedArgs = encodeAbiParameters(
    [
      { type: "string" },
      { type: "string" },
      { type: "string" },
      { type: "address" },
      { type: "address" },
      { type: "address" },
      { type: "address" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "address[]" },
      { type: "uint8" },
      { type: "uint16" },
      { type: "uint16" },
      { type: "uint16" },
      { type: "address" }
    ],
    [
      params.name,
      params.symbol,
      params.metadataURI,
      params.creator,
      params.factory,
      params.protocolFeeRecipient,
      params.router,
      params.graduationQuoteReserve,
      params.whitelistThreshold,
      params.whitelistSlotSize,
      params.whitelistOpensAt,
      params.whitelistAddresses,
      params.launchModeId,
      params.taxBps,
      params.burnShareBps,
      params.treasuryShareBps,
      params.treasuryWallet
    ]
  );

  return concatHex([launchTokenWhitelistTaxedBytecode, encodedArgs]);
}

async function findVanityLaunchSalt(params: {
  mode: LaunchCreationFamily;
  deployer: `0x${string}`;
  factory: `0x${string}`;
  name: string;
  symbol: string;
  metadataURI: string;
  creator: `0x${string}`;
  protocolFeeRecipient: `0x${string}`;
  router: `0x${string}`;
  graduationQuoteReserve: bigint;
  whitelistThreshold?: bigint;
  whitelistSlotSize?: bigint;
  whitelistOpensAt?: bigint;
  whitelistAddresses?: readonly `0x${string}`[];
  taxBps?: number;
  burnShareBps?: number;
  treasuryShareBps?: number;
  treasuryWallet?: `0x${string}`;
  suffix?: string;
  onProgress?: (update: { attempts: number; elapsedMs: number }) => void;
}) {
  const suffix =
    (params.suffix ??
      (params.mode === "whitelist"
        ? whitelistVanitySuffix
        : params.mode === "whitelistTaxed"
          ? whitelistTaxVanitySuffix
          : params.mode === "taxed"
            ? `${Math.floor((params.taxBps ?? 100) / 100)}314`
            : standardVanitySuffix)).toLowerCase();
  const initCode =
    params.mode === "whitelist"
      ? buildWhitelistLaunchInitCode({
          name: params.name,
          symbol: params.symbol,
          metadataURI: params.metadataURI,
          creator: params.creator,
          factory: params.factory,
          protocolFeeRecipient: params.protocolFeeRecipient,
          router: params.router,
          graduationQuoteReserve: params.graduationQuoteReserve,
          whitelistThreshold: params.whitelistThreshold ?? 0n,
          whitelistSlotSize: params.whitelistSlotSize ?? 0n,
          whitelistOpensAt: params.whitelistOpensAt ?? 0n,
          whitelistAddresses: params.whitelistAddresses ?? []
        })
      : params.mode === "taxed"
        ? buildTaxedLaunchInitCode({
            name: params.name,
            symbol: params.symbol,
            metadataURI: params.metadataURI,
            creator: params.creator,
            factory: params.factory,
            protocolFeeRecipient: params.protocolFeeRecipient,
            router: params.router,
            graduationQuoteReserve: params.graduationQuoteReserve,
            launchModeId: Math.floor((params.taxBps ?? 100) / 100) + 2,
            taxBps: params.taxBps ?? 100,
            burnShareBps: params.burnShareBps ?? 5000,
            treasuryShareBps: params.treasuryShareBps ?? 5000,
            treasuryWallet: params.treasuryWallet ?? params.protocolFeeRecipient
          })
        : params.mode === "whitelistTaxed"
          ? buildWhitelistTaxedLaunchInitCode({
              name: params.name,
              symbol: params.symbol,
              metadataURI: params.metadataURI,
              creator: params.creator,
              factory: params.factory,
              protocolFeeRecipient: params.protocolFeeRecipient,
              router: params.router,
              graduationQuoteReserve: params.graduationQuoteReserve,
              whitelistThreshold: params.whitelistThreshold ?? 0n,
              whitelistSlotSize: params.whitelistSlotSize ?? 0n,
              whitelistOpensAt: params.whitelistOpensAt ?? 0n,
              whitelistAddresses: params.whitelistAddresses ?? [],
              launchModeId: 12,
              taxBps: params.taxBps ?? 100,
              burnShareBps: params.burnShareBps ?? 5000,
              treasuryShareBps: params.treasuryShareBps ?? 5000,
              treasuryWallet: params.treasuryWallet ?? params.protocolFeeRecipient
            })
        : buildLaunchInitCode({
          name: params.name,
          symbol: params.symbol,
          metadataURI: params.metadataURI,
          creator: params.creator,
          factory: params.factory,
          protocolFeeRecipient: params.protocolFeeRecipient,
          router: params.router,
          graduationQuoteReserve: params.graduationQuoteReserve
        });
  const initCodeHash = keccak256(initCode);
  const vanityDeployer = params.deployer ?? params.factory;
  const started = performance.now();
  let attempts = 0;

  while (true) {
    const salt = randomBytes32Hex();
    const predictedAddress = computeCreate2Address(vanityDeployer, salt, initCodeHash);
    attempts += 1;

    if (predictedAddress.toLowerCase().endsWith(suffix)) {
      return {
        salt,
        predictedAddress,
        attempts,
        elapsedMs: Math.round(performance.now() - started)
      };
    }

    if (attempts % 4096 === 0) {
      params.onProgress?.({
        attempts,
        elapsedMs: Math.round(performance.now() - started)
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
}

export async function readFactory(address: string): Promise<FactorySnapshot> {
  const factoryAddress = getAddress(address);
  const client = getPublicClient();

  const [router, protocolFeeRecipient, createFee, graduationQuoteReserve, totalLaunches, accruedProtocolCreateFees] =
    (await Promise.all([
    client.readContract({ address: factoryAddress, abi: launchFactoryAbi, functionName: "router" }),
    client.readContract({ address: factoryAddress, abi: launchFactoryAbi, functionName: "protocolFeeRecipient" }),
    client.readContract({ address: factoryAddress, abi: legacyFactoryAbi, functionName: "createFee" }),
    client.readContract({ address: factoryAddress, abi: launchFactoryAbi, functionName: "graduationQuoteReserve" }),
    client.readContract({ address: factoryAddress, abi: legacyFactoryAbi, functionName: "totalLaunches" }),
    client.readContract({
      address: factoryAddress,
      abi: launchFactoryAbi,
      functionName: "accruedProtocolCreateFees"
    })
  ])) as [`0x${string}`, `0x${string}`, bigint, bigint, bigint, bigint];

  let standardCreateFee = createFee;
  let whitelistCreateFee = 0n;
  let supportsWhitelistMode = false;
  let supportsTaxedMode = false;
  let supportsWhitelistTaxedMode = false;
  let standardDeployer = zeroAddress;
  let whitelistDeployer = zeroAddress;
  let taxedDeployer = zeroAddress;
  let whitelistTaxedDeployer = zeroAddress;

  const v2Reads = await Promise.allSettled([
    client.readContract({ address: factoryAddress, abi: launchFactoryAbi, functionName: "standardCreateFee" }),
    client.readContract({ address: factoryAddress, abi: launchFactoryAbi, functionName: "whitelistCreateFee" }),
    client.readContract({ address: factoryAddress, abi: launchFactoryAbi, functionName: "standardDeployer" }),
    client.readContract({ address: factoryAddress, abi: launchFactoryAbi, functionName: "whitelistDeployer" }),
    client.readContract({ address: factoryAddress, abi: launchFactoryAbi, functionName: "taxedDeployer" }),
    client.readContract({ address: factoryAddress, abi: launchFactoryAbi, functionName: "whitelistTaxedDeployer" })
  ]);

  if (v2Reads[0].status === "fulfilled") standardCreateFee = v2Reads[0].value as bigint;
  if (v2Reads[1].status === "fulfilled") whitelistCreateFee = v2Reads[1].value as bigint;
  if (v2Reads[2].status === "fulfilled") standardDeployer = v2Reads[2].value as `0x${string}`;
  if (v2Reads[3].status === "fulfilled") whitelistDeployer = v2Reads[3].value as `0x${string}`;
  if (v2Reads[4].status === "fulfilled") taxedDeployer = v2Reads[4].value as `0x${string}`;
  if (v2Reads[5].status === "fulfilled") whitelistTaxedDeployer = v2Reads[5].value as `0x${string}`;

  supportsWhitelistMode = whitelistDeployer !== zeroAddress;
  supportsTaxedMode = taxedDeployer !== zeroAddress;
  supportsWhitelistTaxedMode = whitelistTaxedDeployer !== zeroAddress;

  const recentLaunches: `0x${string}`[] = [];
  const recentCount = Number(totalLaunches > 5n ? 5n : totalLaunches);
  for (let offset = 0; offset < recentCount; offset += 1) {
    const index = totalLaunches - 1n - BigInt(offset);
    const launch = (await client.readContract({
      address: factoryAddress,
      abi: legacyFactoryAbi,
      functionName: "allLaunches",
      args: [index]
    })) as `0x${string}`;
    recentLaunches.push(launch);
  }

  return {
    address: factoryAddress,
    router,
    protocolFeeRecipient,
    standardDeployer,
    whitelistDeployer,
    taxedDeployer,
    whitelistTaxedDeployer,
    createFee,
    standardCreateFee,
    whitelistCreateFee,
    supportsWhitelistMode,
    supportsTaxedMode,
    supportsWhitelistTaxedMode,
    graduationQuoteReserve,
    totalLaunches,
    accruedProtocolCreateFees,
    recentLaunches
  };
}

export async function readRecentLaunchSnapshots(address: string) {
  const snapshot = await readFactory(address);
  const indexed = await readApiLaunchSummaries(snapshot.address, snapshot.graduationQuoteReserve, 24);
  let launches: TokenSnapshot[];

  if (indexed) {
    launches = indexed;
  } else {
    const fallbackSnapshot = await readIndexerSnapshot();
    if (fallbackSnapshot && fallbackSnapshot.factory.toLowerCase() === snapshot.address.toLowerCase()) {
      launches = fallbackSnapshot.launches.map(convertSnapshotLaunch).slice(0, 5);
    } else {
      launches = await Promise.all(snapshot.recentLaunches.map((launch) => readToken(launch)));
    }
  }

  return {
    factory: snapshot,
    launches
  };
}

export async function readToken(address: string): Promise<TokenSnapshot> {
  const tokenAddress = getAddress(address);
  const client = getPublicClient();

  const [
    name,
    symbol,
    state,
    factory,
    pair,
    creator,
    protocolFeeRecipient,
    router,
    dexFactory,
    wrappedNative,
    metadataURI,
    graduationQuoteReserve,
    currentPriceQuotePerToken,
    graduationProgressBps,
    remainingQuoteCapacity,
    pairPreloadedQuote,
    pairClean,
    pairGraduationCompatible,
    protocolClaimable,
    creatorClaimable,
    creatorFeeSweepReady,
    createdAt,
    lastTradeAt,
    dexReserves
  ] = (await Promise.all([
    client.readContract({ address: tokenAddress, abi: launchTokenAbi, functionName: "name" }),
    client.readContract({ address: tokenAddress, abi: launchTokenAbi, functionName: "symbol" }),
    client.readContract({ address: tokenAddress, abi: launchTokenAbi, functionName: "state" }),
    client.readContract({ address: tokenAddress, abi: launchTokenAbi, functionName: "factory" }),
    client.readContract({ address: tokenAddress, abi: launchTokenAbi, functionName: "pair" }),
    client.readContract({ address: tokenAddress, abi: launchTokenAbi, functionName: "creator" }),
    client.readContract({ address: tokenAddress, abi: launchTokenAbi, functionName: "protocolFeeRecipient" }),
    client.readContract({ address: tokenAddress, abi: launchTokenAbi, functionName: "router" }),
    client.readContract({ address: tokenAddress, abi: launchTokenAbi, functionName: "dexFactory" }),
    client.readContract({ address: tokenAddress, abi: launchTokenAbi, functionName: "wrappedNative" }),
    client.readContract({ address: tokenAddress, abi: launchTokenAbi, functionName: "metadataURI" }),
    client.readContract({ address: tokenAddress, abi: launchTokenAbi, functionName: "graduationQuoteReserve" }),
    client.readContract({
      address: tokenAddress,
      abi: launchTokenAbi,
      functionName: "currentPriceQuotePerToken"
    }),
    client.readContract({
      address: tokenAddress,
      abi: launchTokenAbi,
      functionName: "displayGraduationProgressBps"
    }),
    client.readContract({
      address: tokenAddress,
      abi: launchTokenAbi,
      functionName: "remainingQuoteCapacity"
    }),
    client.readContract({
      address: tokenAddress,
      abi: launchTokenAbi,
      functionName: "pairPreloadedQuote"
    }),
    client.readContract({ address: tokenAddress, abi: launchTokenAbi, functionName: "isPairClean" }),
    client.readContract({
      address: tokenAddress,
      abi: launchTokenAbi,
      functionName: "isPairGraduationCompatible"
    }),
    client.readContract({ address: tokenAddress, abi: launchTokenAbi, functionName: "protocolClaimable" }),
    client.readContract({ address: tokenAddress, abi: launchTokenAbi, functionName: "creatorClaimable" }),
    client.readContract({ address: tokenAddress, abi: launchTokenAbi, functionName: "creatorFeeSweepReady" }),
    client.readContract({ address: tokenAddress, abi: launchTokenAbi, functionName: "createdAt" }),
    client.readContract({ address: tokenAddress, abi: launchTokenAbi, functionName: "lastTradeAt" }),
    client.readContract({ address: tokenAddress, abi: launchTokenAbi, functionName: "dexReserves" })
  ])) as [
    string,
    string,
    bigint,
    `0x${string}`,
    `0x${string}`,
    `0x${string}`,
    `0x${string}`,
    `0x${string}`,
    `0x${string}`,
    `0x${string}`,
    string,
    bigint,
    bigint,
    bigint,
    bigint,
    bigint,
    boolean,
    boolean,
    bigint,
    bigint,
    boolean,
    bigint,
    bigint,
    readonly [bigint, bigint]
  ];

  let launchModeId = 1n;
  let launchSuffix = standardVanitySuffix;
  let whitelistStatus = 0n;
  let whitelistSnapshot: readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint] = [
    0n,
    0n,
    0n,
    0n,
    0n,
    0n,
    0n,
    0n,
    0n
  ];

  try {
    launchModeId = (await client.readContract({
      address: tokenAddress,
      abi: launchTokenAbi,
      functionName: "launchMode"
    })) as bigint;
  } catch {}

  try {
    launchSuffix = (await client.readContract({
      address: tokenAddress,
      abi: launchTokenAbi,
      functionName: "launchSuffix"
    })) as string;
  } catch {}

  try {
    whitelistStatus = (await client.readContract({
      address: tokenAddress,
      abi: launchTokenAbi,
      functionName: "whitelistStatus"
    })) as bigint;
    whitelistSnapshot = (await client.readContract({
      address: tokenAddress,
      abi: launchTokenAbi,
      functionName: "whitelistSnapshot"
    })) as readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint];
  } catch {}

  let taxConfig = null as TokenSnapshot["taxConfig"];
  try {
    const rawTaxConfig = (await client.readContract({
      address: tokenAddress,
      abi: launchTokenAbi,
      functionName: "taxConfig"
    })) as readonly [boolean, bigint, bigint, bigint, `0x${string}`, boolean];
    const [enabled, configuredTaxBps, burnBps, treasuryBps, wallet, active] = rawTaxConfig;
    if (enabled || configuredTaxBps > 0n || burnBps > 0n || treasuryBps > 0n || wallet !== zeroAddress || active) {
      taxConfig = {
        enabled,
        configuredTaxBps,
        burnBps,
        treasuryBps,
        wallet: getAddress(wallet),
        active
      };
    }
  } catch {}

  return {
    address: tokenAddress,
    name,
    symbol,
    state: launchStates[Number(state)] ?? `Unknown(${state})`,
    launchModeId,
    launchMode: launchModeFromId(Number(launchModeId)),
    launchSuffix,
    factory,
    pair,
    creator,
    protocolFeeRecipient,
    router,
    dexFactory,
    wrappedNative,
    metadataURI,
    graduationQuoteReserve,
    currentPriceQuotePerToken,
    graduationProgressBps,
    remainingQuoteCapacity,
    pairPreloadedQuote,
    pairClean,
    pairGraduationCompatible,
    protocolClaimable,
    creatorClaimable,
    creatorFeeSweepReady,
    createdAt,
    lastTradeAt,
    taxConfig,
    whitelistStatus,
    whitelistSnapshot:
      whitelistStatus === 0n && whitelistSnapshot[1] === 0n
        ? null
        : {
            status: whitelistSnapshot[0],
            opensAt: whitelistSnapshot[1],
            deadline: whitelistSnapshot[2],
            threshold: whitelistSnapshot[3],
            slotSize: whitelistSnapshot[4],
            seatCount: whitelistSnapshot[5],
            seatsFilled: whitelistSnapshot[6],
            committedTotal: whitelistSnapshot[7],
            tokensPerSeat: whitelistSnapshot[8]
          },
    dexTokenReserve: dexReserves[0],
    dexQuoteReserve: dexReserves[1]
  };
}

export async function verifyOfficialLaunch(factoryAddress: string, tokenAddress: string): Promise<ProtocolVerification> {
  const expectedFactory = getAddress(factoryAddress);
  const [factorySnapshot, tokenSnapshot] = await Promise.all([readFactory(expectedFactory), readToken(tokenAddress)]);
  const client = getPublicClient();

  let registeredMode = 0n;
  let usesLegacyRegistry = false;
  try {
    registeredMode = (await client.readContract({
      address: expectedFactory,
      abi: launchFactoryAbi,
      functionName: "modeOf",
      args: [tokenSnapshot.address]
    })) as bigint;
  } catch {
    usesLegacyRegistry = true;
    for (let index = 0n; index < factorySnapshot.totalLaunches; index += 1n) {
      const launch = (await client.readContract({
        address: expectedFactory,
        abi: legacyFactoryAbi,
        functionName: "allLaunches",
        args: [index]
      })) as `0x${string}`;
      if (launch.toLowerCase() === tokenSnapshot.address.toLowerCase()) {
        registeredMode = 1n;
        break;
      }
    }
  }

  const expectedPair = (await client.readContract({
    address: tokenSnapshot.dexFactory,
    abi: v2FactoryAbi,
    functionName: "getPair",
    args: [tokenSnapshot.address, tokenSnapshot.wrappedNative]
  })) as `0x${string}`;

  let launchEventArgs:
    | {
        creator?: `0x${string}`;
        token?: `0x${string}`;
        mode?: bigint;
        name?: string;
        symbol?: string;
        metadataURI?: string;
      }
    | undefined;

  if (!usesLegacyRegistry && tokenSnapshot.factory.toLowerCase() === expectedFactory.toLowerCase()) {
    const launchCreatedLogs = await client.getLogs({
      address: expectedFactory,
      fromBlock: 0n,
      toBlock: "latest"
    });

    const decodedLaunchEvent = launchCreatedLogs
      .map((log) => {
        try {
          return decodeEventLog({
            abi: launchFactoryAbi,
            data: log.data,
            topics: log.topics
          });
        } catch {
          return null;
        }
      })
      .find((decoded) => {
        if (!decoded || decoded.eventName !== "LaunchCreated") return false;
        const args = decoded.args as { token?: `0x${string}` };
        return args.token?.toLowerCase() === tokenSnapshot.address.toLowerCase();
      });

    launchEventArgs =
      decodedLaunchEvent?.eventName === "LaunchCreated"
        ? (decodedLaunchEvent.args as {
            creator?: `0x${string}`;
            token?: `0x${string}`;
            mode?: bigint;
            name?: string;
            symbol?: string;
            metadataURI?: string;
          })
        : undefined;
  }

  const expectedSuffix = expectedSuffixForMode(Number(registeredMode));
  const checks = {
    factoryMatches: tokenSnapshot.factory.toLowerCase() === expectedFactory.toLowerCase(),
    factoryRegistryRecognizesToken: registeredMode !== 0n,
    tokenModeMatchesFactory: tokenSnapshot.launchModeId === registeredMode && registeredMode !== 0n,
    launchEventFound: usesLegacyRegistry ? registeredMode !== 0n : Boolean(launchEventArgs),
    eventMetadataMatchesToken:
      usesLegacyRegistry
        ? registeredMode === 1n
        : Boolean(
            launchEventArgs &&
              launchEventArgs.creator &&
              launchEventArgs.name !== undefined &&
              launchEventArgs.symbol !== undefined &&
              launchEventArgs.metadataURI !== undefined &&
              launchEventArgs.mode !== undefined &&
              launchEventArgs.creator.toLowerCase() === tokenSnapshot.creator.toLowerCase() &&
              launchEventArgs.mode === registeredMode &&
              launchEventArgs.name === tokenSnapshot.name &&
              launchEventArgs.symbol === tokenSnapshot.symbol &&
              launchEventArgs.metadataURI === tokenSnapshot.metadataURI
          ),
    protocolRecipientMatches:
      tokenSnapshot.protocolFeeRecipient.toLowerCase() === factorySnapshot.protocolFeeRecipient.toLowerCase(),
    routerMatches: tokenSnapshot.router.toLowerCase() === factorySnapshot.router.toLowerCase(),
    graduationTargetMatches: tokenSnapshot.graduationQuoteReserve === factorySnapshot.graduationQuoteReserve,
    pairMatchesDex:
      tokenSnapshot.pair.toLowerCase() === getAddress(expectedPair).toLowerCase() && tokenSnapshot.pair !== zeroAddress,
    suffixMatchesMode:
      expectedSuffix.length > 0 &&
      tokenSnapshot.launchSuffix === expectedSuffix &&
      tokenSnapshot.address.toLowerCase().endsWith(expectedSuffix)
  } satisfies ProtocolVerification["checks"];

  if (Object.values(checks).every(Boolean)) {
    return {
      status: "official",
      summary: `Verified official ${tokenSnapshot.launchSuffix} launch from the canonical Autonomous 314 factory${usesLegacyRegistry ? " (legacy registry compatibility path)" : ""}.`,
      checks
    };
  }

  if (checks.factoryMatches || checks.factoryRegistryRecognizesToken || checks.launchEventFound) {
    return {
      status: "warning",
      summary:
        "This token exposes much of the Autonomous 314 surface, but it is missing one or more official invariants. The reference UI should treat it as read-only and suspicious.",
      checks
    };
  }

  return {
    status: "foreign",
    summary: "This address is not verified as an official Autonomous 314 launch from the canonical factory.",
    checks
  };
}

export function parseBnbInput(value: string) {
  if (!value.trim()) {
    return 0n;
  }
  return parseEther(value);
}

export function parseTokenInput(value: string, decimals = 18) {
  if (!value.trim()) {
    return 0n;
  }
  return parseUnits(value, decimals);
}

export function applySlippageBps(amount: bigint, bps: number) {
  if (amount === 0n) {
    return 0n;
  }

  const boundedBps = Math.max(0, Math.min(9_999, bps));
  return (amount * BigInt(10_000 - boundedBps)) / 10_000n;
}

export async function previewBuy(address: string, grossQuoteIn: string) {
  const tokenAddress = getAddress(address);
  const client = getPublicClient();

  const parsedQuote = parseBnbInput(grossQuoteIn);
  const [tokenOut, feeAmount, refundAmount] = (await client.readContract({
    address: tokenAddress,
    abi: launchTokenAbi,
    functionName: "previewBuy",
    args: [parsedQuote]
  })) as readonly [bigint, bigint, bigint];

  return { tokenOut, feeAmount, refundAmount };
}

export async function previewSell(address: string, tokenAmount: string) {
  const tokenAddress = getAddress(address);
  const client = getPublicClient();

  const parsedAmount = parseTokenInput(tokenAmount);
  const [grossQuoteOut, netQuoteOut, totalFee] = (await client.readContract({
    address: tokenAddress,
    abi: launchTokenAbi,
    functionName: "previewSell",
    args: [parsedAmount]
  })) as readonly [bigint, bigint, bigint];

  return { grossQuoteOut, netQuoteOut, totalFee };
}

export async function createLaunch(
  factoryAddress: string,
  params: {
    family: LaunchCreationFamily;
    name: string;
    symbol: string;
    metadataURI: string;
    createFee: bigint;
    atomicQuoteIn?: bigint;
    minTokenOut?: bigint;
    whitelistThreshold?: bigint;
    whitelistSlotSize?: bigint;
    whitelistOpensAt?: bigint;
    whitelistAddresses?: readonly `0x${string}`[];
    taxBps?: number;
    burnShareBps?: number;
    treasuryShareBps?: number;
    treasuryWallet?: `0x${string}`;
    onVanityProgress?: (update: { attempts: number; elapsedMs: number }) => void;
  }
) {
  const walletClient = getWalletClientOrThrow();
  const account = await getActiveAccount();
  await ensureWalletOnExpectedChain();
  const publicClient = getPublicClient();
  const normalizedFactoryAddress = getAddress(factoryAddress);
  const factorySnapshot = await readFactory(normalizedFactoryAddress);
  const family = params.family;
  const deployer = getAddress(deployerForFamily(factorySnapshot, family));
  const atomicQuoteIn = params.atomicQuoteIn ?? 0n;
  const minTokenOut = params.minTokenOut ?? 0n;
  const whitelistThreshold = params.whitelistThreshold ?? 0n;
  const whitelistSlotSize = params.whitelistSlotSize ?? 0n;
  const whitelistOpensAt = params.whitelistOpensAt ?? 0n;
  const taxBps = params.taxBps ?? 100;
  const burnShareBps = params.burnShareBps ?? 5000;
  const treasuryShareBps = params.treasuryShareBps ?? 5000;
  const treasuryWallet = params.treasuryWallet ?? factorySnapshot.protocolFeeRecipient;

  const vanity = await findVanityLaunchSalt({
    mode: family,
    deployer,
    factory: normalizedFactoryAddress,
    name: params.name,
    symbol: params.symbol,
    metadataURI: params.metadataURI,
    creator: account,
    protocolFeeRecipient: factorySnapshot.protocolFeeRecipient,
    router: factorySnapshot.router,
    graduationQuoteReserve: factorySnapshot.graduationQuoteReserve,
    whitelistThreshold: params.whitelistThreshold,
    whitelistSlotSize: params.whitelistSlotSize,
    whitelistAddresses: params.whitelistAddresses,
    taxBps,
    burnShareBps,
    treasuryShareBps,
    treasuryWallet,
    suffix:
      family === "whitelist"
        ? whitelistVanitySuffix
        : family === "whitelistTaxed"
          ? whitelistTaxVanitySuffix
          : family === "taxed" && params.taxBps
            ? `${Math.floor(params.taxBps / 100)}314`
            : standardVanitySuffix,
    onProgress: params.onVanityProgress
  });

  let hash: `0x${string}`;
  if (family === "standard") {
    if (atomicQuoteIn <= 0n) {
      throw new Error("Standard launches require an atomic buy amount.");
    }
    hash = await walletClient.writeContract({
      account,
      chain: appChain,
      address: normalizedFactoryAddress,
      abi: launchFactoryAbi,
      functionName: "createLaunchAndBuyWithSalt",
      args: [params.name, params.symbol, params.metadataURI, vanity.salt, minTokenOut],
      value: params.createFee + atomicQuoteIn
    });
  } else if (family === "whitelist") {
    if (!whitelistThreshold || !whitelistSlotSize) {
      throw new Error("Whitelist launches require a threshold and seat size.");
    }
    const delayedOpen = whitelistOpensAt > 0n;
    hash = await walletClient.writeContract({
      account,
      chain: appChain,
      address: normalizedFactoryAddress,
      abi: launchFactoryAbi,
      functionName: delayedOpen ? "createWhitelistLaunchWithSalt" : "createWhitelistLaunchAndCommitWithSalt",
      args: [
        params.name,
        params.symbol,
        params.metadataURI,
        whitelistThreshold,
        whitelistSlotSize,
        whitelistOpensAt,
        params.whitelistAddresses ?? [],
        vanity.salt
      ],
      value: delayedOpen ? params.createFee : params.createFee + whitelistSlotSize
    });
  } else if (family === "taxed") {
    if (atomicQuoteIn <= 0n) {
      throw new Error("Taxed launches require an atomic buy amount.");
    }
    hash = await walletClient.writeContract({
      account,
      chain: appChain,
      address: normalizedFactoryAddress,
      abi: launchFactoryAbi,
      functionName: "createTaxLaunchAndBuyWithSalt",
      args: [
        params.name,
        params.symbol,
        params.metadataURI,
        taxBps,
        burnShareBps,
        treasuryShareBps,
        treasuryWallet,
        vanity.salt,
        minTokenOut
      ],
      value: params.createFee + atomicQuoteIn
    });
  } else {
    if (!whitelistThreshold || !whitelistSlotSize) {
      throw new Error("Whitelist-taxed launches require a threshold and seat size.");
    }
    const delayedOpen = whitelistOpensAt > 0n;
    const initCode = buildWhitelistTaxedLaunchInitCode({
      name: params.name,
      symbol: params.symbol,
      metadataURI: params.metadataURI,
      creator: account,
      factory: normalizedFactoryAddress,
      protocolFeeRecipient: factorySnapshot.protocolFeeRecipient,
      router: factorySnapshot.router,
      graduationQuoteReserve: factorySnapshot.graduationQuoteReserve,
      whitelistThreshold,
      whitelistSlotSize,
      whitelistOpensAt,
      whitelistAddresses: params.whitelistAddresses ?? [],
      launchModeId: 12,
      taxBps,
      burnShareBps,
      treasuryShareBps,
      treasuryWallet
    });
    hash = await walletClient.writeContract({
      account,
      chain: appChain,
      address: normalizedFactoryAddress,
      abi: launchFactoryAbi,
      functionName: delayedOpen ? "createWhitelistTaxLaunchWithSalt" : "createWhitelistTaxLaunchAndCommitWithSalt",
      args: [
        params.name,
        params.symbol,
        params.metadataURI,
        {
          whitelistThreshold,
          whitelistSlotSize,
          whitelistOpensAt,
          whitelistAddresses: params.whitelistAddresses ?? []
        },
        {
          taxBps,
          burnShareBps,
          treasuryShareBps,
          treasuryWallet
        },
        initCode,
        vanity.salt
      ],
      value: delayedOpen ? params.createFee : params.createFee + whitelistSlotSize
    });
  }

  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  let createdToken: `0x${string}` | null = null;

  for (const log of receipt.logs) {
    try {
      const decoded = decodeEventLog({
        abi: launchFactoryAbi,
        data: log.data,
        topics: log.topics
      });
      if (decoded.eventName === "LaunchCreated") {
        const args = decoded.args as unknown as { token: string };
        createdToken = getAddress(args.token);
        break;
      }
    } catch {
      // ignore unrelated logs
    }
  }

  if (createdToken && createdToken.toLowerCase() !== vanity.predictedAddress.toLowerCase()) {
    throw new Error(
      `Vanity address mismatch. Predicted ${vanity.predictedAddress}, received ${createdToken}.`
    );
  }

  return {
    receipt,
    createdToken,
    vanity
  };
}

export async function executeBuy(address: string, grossQuoteIn: string, minTokenOut: bigint) {
  const walletClient = getWalletClientOrThrow();
  const account = await getActiveAccount();
  await ensureWalletOnExpectedChain();
  const publicClient = getPublicClient();

  const hash = await walletClient.writeContract({
    account,
    chain: appChain,
    address: getAddress(address),
    abi: launchTokenAbi,
    functionName: "buy",
    args: [minTokenOut],
    value: parseBnbInput(grossQuoteIn)
  });

  return publicClient.waitForTransactionReceipt({ hash });
}

export async function executeWhitelistCommit(address: string, slotSize: bigint) {
  const walletClient = getWalletClientOrThrow();
  const account = await getActiveAccount();
  await ensureWalletOnExpectedChain();
  const publicClient = getPublicClient();

  const hash = await walletClient.writeContract({
    account,
    chain: appChain,
    address: getAddress(address),
    abi: launchTokenWhitelistAbi,
    functionName: "commitWhitelistSeat",
    value: slotSize
  });

  return publicClient.waitForTransactionReceipt({ hash });
}

export async function claimWhitelistAllocation(address: string) {
  const walletClient = getWalletClientOrThrow();
  const account = await getActiveAccount();
  await ensureWalletOnExpectedChain();
  const publicClient = getPublicClient();

  const hash = await walletClient.writeContract({
    account,
    chain: appChain,
    address: getAddress(address),
    abi: launchTokenWhitelistAbi,
    functionName: "claimWhitelistAllocation"
  });

  return publicClient.waitForTransactionReceipt({ hash });
}

export async function claimWhitelistRefund(address: string) {
  const walletClient = getWalletClientOrThrow();
  const account = await getActiveAccount();
  await ensureWalletOnExpectedChain();
  const publicClient = getPublicClient();

  const hash = await walletClient.writeContract({
    account,
    chain: appChain,
    address: getAddress(address),
    abi: launchTokenWhitelistAbi,
    functionName: "claimWhitelistRefund"
  });

  return publicClient.waitForTransactionReceipt({ hash });
}

export async function executeSell(address: string, tokenAmount: string, minQuoteOut: bigint) {
  const walletClient = getWalletClientOrThrow();
  const account = await getActiveAccount();
  await ensureWalletOnExpectedChain();
  const publicClient = getPublicClient();

  const hash = await walletClient.writeContract({
    account,
    chain: appChain,
    address: getAddress(address),
    abi: launchTokenAbi,
    functionName: "sell",
    args: [parseTokenInput(tokenAmount), minQuoteOut]
  });

  return publicClient.waitForTransactionReceipt({ hash });
}

export async function claimFactoryProtocolFees(factoryAddress: string) {
  const walletClient = getWalletClientOrThrow();
  const account = await getActiveAccount();
  await ensureWalletOnExpectedChain();
  const publicClient = getPublicClient();

  const hash = await walletClient.writeContract({
    account,
    chain: appChain,
    address: getAddress(factoryAddress),
    abi: launchFactoryAbi,
    functionName: "claimProtocolCreateFees"
  });

  return publicClient.waitForTransactionReceipt({ hash });
}

export async function claimTokenProtocolFees(tokenAddress: string) {
  const walletClient = getWalletClientOrThrow();
  const account = await getActiveAccount();
  await ensureWalletOnExpectedChain();
  const publicClient = getPublicClient();

  const hash = await walletClient.writeContract({
    account,
    chain: appChain,
    address: getAddress(tokenAddress),
    abi: launchTokenAbi,
    functionName: "claimProtocolFees"
  });

  return publicClient.waitForTransactionReceipt({ hash });
}

export async function claimCreatorFees(tokenAddress: string) {
  const walletClient = getWalletClientOrThrow();
  const account = await getActiveAccount();
  await ensureWalletOnExpectedChain();
  const publicClient = getPublicClient();

  const hash = await walletClient.writeContract({
    account,
    chain: appChain,
    address: getAddress(tokenAddress),
    abi: launchTokenAbi,
    functionName: "claimCreatorFees"
  });

  return publicClient.waitForTransactionReceipt({ hash });
}

export async function sweepAbandonedCreatorFees(tokenAddress: string) {
  const walletClient = getWalletClientOrThrow();
  const account = await getActiveAccount();
  await ensureWalletOnExpectedChain();
  const publicClient = getPublicClient();

  const hash = await walletClient.writeContract({
    account,
    chain: appChain,
    address: getAddress(tokenAddress),
    abi: launchTokenAbi,
    functionName: "sweepAbandonedCreatorFees"
  });

  return publicClient.waitForTransactionReceipt({ hash });
}

export async function readWhitelistAccountState(tokenAddress: string, account: string) {
  const client = getPublicClient();
  const normalizedToken = getAddress(tokenAddress);
  const normalizedAccount = getAddress(account);

  const [approved, canCommit, canClaimAllocation, canClaimRefund] = (await Promise.all([
    client.readContract({
      address: normalizedToken,
      abi: launchTokenAbi,
      functionName: "isWhitelisted",
      args: [normalizedAccount]
    }),
    client.readContract({
      address: normalizedToken,
      abi: launchTokenAbi,
      functionName: "canCommitWhitelist",
      args: [normalizedAccount]
    }),
    client.readContract({
      address: normalizedToken,
      abi: launchTokenAbi,
      functionName: "canClaimWhitelistAllocation",
      args: [normalizedAccount]
    }),
    client.readContract({
      address: normalizedToken,
      abi: launchTokenAbi,
      functionName: "canClaimWhitelistRefund",
      args: [normalizedAccount]
    })
  ])) as [boolean, boolean, boolean, boolean];

  return { approved, canCommit, canClaimAllocation, canClaimRefund };
}

function tradePrice(netQuote: bigint, tokenAmount: bigint) {
  if (tokenAmount === 0n) {
    return 0n;
  }
  return (netQuote * 10n ** 18n) / tokenAmount;
}

function bucketStart(timestampMs: number, timeframeMs: number) {
  return Math.floor(timestampMs / timeframeMs) * timeframeMs;
}

function sortLogsAscending(a: Pick<Log, "blockNumber" | "logIndex">, b: Pick<Log, "blockNumber" | "logIndex">) {
  const blockA = a.blockNumber ?? 0n;
  const blockB = b.blockNumber ?? 0n;
  if (blockA < blockB) return -1;
  if (blockA > blockB) return 1;
  return Number((a.logIndex ?? 0) - (b.logIndex ?? 0));
}

async function resolveBlockTimes(client: ReturnType<typeof getPublicClient>, logs: Log[]) {
  const uniqueBlocks = [...new Set(logs.map((log) => log.blockNumber ?? 0n))];
  const blockEntries = await Promise.all(
    uniqueBlocks.map(async (blockNumber) => {
      const block = await client.getBlock({ blockNumber });
      return [blockNumber.toString(), Number(block.timestamp) * 1000] as const;
    })
  );
  return new Map<string, number>(blockEntries);
}

async function resolveGraduationContext(tokenAddress: `0x${string}`, lookbackBlocks: bigint) {
  const client = getPublicClient();
  const latestBlock = await client.getBlockNumber();
  const fromBlock = latestBlock > lookbackBlocks ? latestBlock - lookbackBlocks : 0n;

  const tokenLogs = await client.getLogs({
    address: tokenAddress,
    fromBlock,
    toBlock: latestBlock
  });

  const orderedTokenLogs = [...tokenLogs].sort(sortLogsAscending);
  const tokenBlockTimes = await resolveBlockTimes(client, orderedTokenLogs);

  let graduationBlock: bigint | null = null;
  let graduationTimestampMs: number | null = null;
  let pairAddress: `0x${string}` | null = null;

  for (const log of orderedTokenLogs) {
    try {
      const decoded = decodeEventLog({
        abi: launchTokenAbi,
        data: log.data,
        topics: log.topics
      });

      if (decoded.eventName !== "Graduated") continue;
      const args = decoded.args as unknown as { pair: `0x${string}` };
      graduationBlock = log.blockNumber ?? 0n;
      graduationTimestampMs = tokenBlockTimes.get((log.blockNumber ?? 0n).toString()) ?? null;
      pairAddress = getAddress(args.pair);
      break;
    } catch {
      // ignore unrelated logs
    }
  }

  return {
    client,
    latestBlock,
    fromBlock,
    tokenLogs,
    graduationBlock,
    graduationTimestampMs,
    pairAddress
  };
}

function convertSnapshotLaunch(launch: SnapshotLaunchJson): TokenSnapshot {
  return {
    address: getAddress(launch.token),
    name: launch.name,
    symbol: launch.symbol,
    state: launch.state,
    launchModeId: BigInt(launch.mode ?? 0),
    launchMode: launchModeFromId(launch.mode ?? 0),
    launchSuffix: launch.suffix ?? expectedSuffixForMode(launch.mode ?? 0),
    factory: zeroAddress,
    pair: getAddress(launch.pair),
    creator: getAddress(launch.creator),
    protocolFeeRecipient: zeroAddress,
    router: zeroAddress,
    dexFactory: zeroAddress,
    wrappedNative: zeroAddress,
    metadataURI: launch.metadataURI,
    graduationQuoteReserve: 0n,
    currentPriceQuotePerToken: BigInt(launch.currentPriceQuotePerToken),
    graduationProgressBps: BigInt(launch.graduationProgressBps),
    remainingQuoteCapacity: BigInt(launch.remainingQuoteCapacity),
    pairPreloadedQuote: BigInt(launch.pairPreloadedQuote),
    pairClean: launch.pairClean,
    pairGraduationCompatible: launch.pairGraduationCompatible,
    protocolClaimable: BigInt(launch.protocolClaimable),
    creatorClaimable: BigInt(launch.creatorClaimable),
    creatorFeeSweepReady: false,
    createdAt: 0n,
    lastTradeAt: 0n,
    taxConfig: convertJsonTaxConfig(launch.taxConfig),
    whitelistStatus: BigInt(launch.whitelistStatus ?? 0),
    whitelistSnapshot: launch.whitelistSnapshot
      ? {
          status: BigInt(launch.whitelistSnapshot.status),
          opensAt: BigInt(launch.whitelistSnapshot.opensAt),
          deadline: BigInt(launch.whitelistSnapshot.deadline),
          threshold: BigInt(launch.whitelistSnapshot.threshold),
          slotSize: BigInt(launch.whitelistSnapshot.slotSize),
          seatCount: BigInt(launch.whitelistSnapshot.seatCount),
          seatsFilled: BigInt(launch.whitelistSnapshot.seatsFilled),
          committedTotal: BigInt(launch.whitelistSnapshot.committedTotal),
          tokensPerSeat: BigInt(launch.whitelistSnapshot.tokensPerSeat)
        }
      : null,
    dexTokenReserve: BigInt(launch.dexTokenReserve),
    dexQuoteReserve: BigInt(launch.dexQuoteReserve)
  };
}

function convertApiLaunchSummary(launch: ApiLaunchSummaryJson, graduationQuoteReserve: bigint): TokenSnapshot {
  const target = launch.graduationQuoteReserve ? BigInt(launch.graduationQuoteReserve) : graduationQuoteReserve;
  return {
    address: getAddress(launch.token),
    name: launch.name,
    symbol: launch.symbol,
    state: launch.state,
    launchModeId: BigInt(launch.mode ?? 0),
    launchMode: launch.modeLabel ?? launchModeFromId(launch.mode ?? 0),
    launchSuffix: launch.suffix ?? expectedSuffixForMode(launch.mode ?? 0),
    factory: zeroAddress,
    pair: getAddress(launch.pair),
    creator: launch.creator ? getAddress(launch.creator) : zeroAddress,
    protocolFeeRecipient: zeroAddress,
    router: zeroAddress,
    dexFactory: zeroAddress,
    wrappedNative: zeroAddress,
    metadataURI: launch.metadataURI ?? "",
    graduationQuoteReserve: target,
    currentPriceQuotePerToken: BigInt(launch.currentPriceQuotePerToken),
    graduationProgressBps: BigInt(launch.graduationProgressBps),
    remainingQuoteCapacity: 0n,
    pairPreloadedQuote: BigInt(launch.pairPreloadedQuote),
    pairClean: false,
    pairGraduationCompatible: false,
    protocolClaimable: 0n,
    creatorClaimable: 0n,
    creatorFeeSweepReady: false,
    createdAt: 0n,
    lastTradeAt: 0n,
    taxConfig: convertJsonTaxConfig(launch.taxConfig),
    whitelistStatus: BigInt(launch.whitelistStatus ?? 0),
    whitelistSnapshot: launch.whitelistSnapshot
      ? {
          status: BigInt(launch.whitelistSnapshot.status),
          opensAt: BigInt(launch.whitelistSnapshot.opensAt),
          deadline: BigInt(launch.whitelistSnapshot.deadline),
          threshold: BigInt(launch.whitelistSnapshot.threshold),
          slotSize: BigInt(launch.whitelistSnapshot.slotSize),
          seatCount: BigInt(launch.whitelistSnapshot.seatCount),
          seatsFilled: BigInt(launch.whitelistSnapshot.seatsFilled),
          committedTotal: BigInt(launch.whitelistSnapshot.committedTotal),
          tokensPerSeat: BigInt(launch.whitelistSnapshot.tokensPerSeat)
        }
      : null,
    dexTokenReserve: 0n,
    dexQuoteReserve: 0n
  };
}

function convertSnapshotActivity(activity: SnapshotActivityJson): ActivityFeedItem {
  if (activity.kind === "graduated") {
    return {
      token: getAddress(activity.token),
      txHash: activity.txHash,
      blockNumber: BigInt(activity.blockNumber),
      logIndex: activity.logIndex,
      timestampMs: activity.timestampMs,
      kind: "graduated",
      source: "system",
      phase: "migrating",
      marketAddress: getAddress(activity.marketAddress),
      quoteAmountContributed: BigInt(activity.quoteAmountContributed),
      preloadedQuoteAmount: BigInt(activity.preloadedQuoteAmount),
      tokenAmount: BigInt(activity.tokenAmount),
      liquidityBurned: BigInt(activity.liquidityBurned)
    };
  }

  return {
    token: getAddress(activity.token),
    txHash: activity.txHash,
    blockNumber: BigInt(activity.blockNumber),
    logIndex: activity.logIndex,
    timestampMs: activity.timestampMs,
    kind: "trade",
    source: activity.source,
    phase: activity.phase,
    side: activity.side,
    marketAddress: getAddress(activity.marketAddress),
    netQuote: BigInt(activity.netQuote),
    tokenAmount: BigInt(activity.tokenAmount),
    priceQuotePerToken: tradePrice(BigInt(activity.netQuote), BigInt(activity.tokenAmount))
  };
}

function convertSnapshotCandle(candle: SnapshotCandleJson): CandlePoint {
  return {
    bucketStart: candle.bucketStart,
    open: BigInt(candle.open),
    high: BigInt(candle.high),
    low: BigInt(candle.low),
    close: BigInt(candle.close),
    volumeQuote: BigInt(candle.volumeQuote),
    volumeToken: BigInt(candle.volumeToken),
    trades: candle.trades
  };
}

export async function readIndexedLaunchWorkspace(tokenAddress: string): Promise<{
  recentActivity: ActivityFeedItem[];
  segmentedChart: SegmentedChartSnapshot;
} | null> {
  const address = getAddress(tokenAddress);
  const apiWorkspace = await readApiLaunchWorkspace(address);
  if (apiWorkspace) {
    return apiWorkspace;
  }

  const indexed = await readIndexerSnapshot();
  if (!indexed) return null;

  const match = indexed.launches.find((launch) => launch.token.toLowerCase() === address.toLowerCase());
  if (!match) return null;

  return {
    recentActivity: match.recentActivity.map(convertSnapshotActivity),
    segmentedChart: {
      bondingCandles: match.segmentedChart.bondingCandles.map(convertSnapshotCandle),
      dexCandles: match.segmentedChart.dexCandles.map(convertSnapshotCandle),
      graduationTimestampMs: match.segmentedChart.graduationTimestampMs
    }
  };
}

export async function fetchRecentBondingTrades(tokenAddress: string, lookbackBlocks = 5_000n, limit = 24) {
  const address = getAddress(tokenAddress);
  const client = getPublicClient();
  const latestBlock = await client.getBlockNumber();
  const fromBlock = latestBlock > lookbackBlocks ? latestBlock - lookbackBlocks : 0n;

  const logs = await client.getLogs({
    address,
    fromBlock,
    toBlock: latestBlock
  });

  const trades = await normalizeTradeLogs(client, logs);
  return trades
    .sort((a, b) => {
      if (a.blockNumber > b.blockNumber) return -1;
      if (a.blockNumber < b.blockNumber) return 1;
      return b.logIndex - a.logIndex;
    })
    .slice(0, limit);
}

export async function fetchBondingCandles(tokenAddress: string, lookbackBlocks = 20_000n, timeframe = 5 * 60_000) {
  const address = getAddress(tokenAddress);
  const client = getPublicClient();
  const latestBlock = await client.getBlockNumber();
  const fromBlock = latestBlock > lookbackBlocks ? latestBlock - lookbackBlocks : 0n;

  const logs = await client.getLogs({
    address,
    fromBlock,
    toBlock: latestBlock
  });

  const trades = await normalizeTradeLogs(client, logs);
  const buckets = new Map<number, CandlePoint>();

  for (const trade of trades.sort((a, b) => Number(a.timestampMs - b.timestampMs))) {
    const start = bucketStart(trade.timestampMs, timeframe);
    const existing = buckets.get(start);
    if (!existing) {
      buckets.set(start, {
        bucketStart: start,
        open: trade.priceQuotePerToken,
        high: trade.priceQuotePerToken,
        low: trade.priceQuotePerToken,
        close: trade.priceQuotePerToken,
        volumeQuote: trade.netQuote,
        volumeToken: trade.tokenAmount,
        trades: 1
      });
      continue;
    }

    buckets.set(start, {
      bucketStart: start,
      open: existing.open,
      high: existing.high > trade.priceQuotePerToken ? existing.high : trade.priceQuotePerToken,
      low: existing.low < trade.priceQuotePerToken ? existing.low : trade.priceQuotePerToken,
      close: trade.priceQuotePerToken,
      volumeQuote: existing.volumeQuote + trade.netQuote,
      volumeToken: existing.volumeToken + trade.tokenAmount,
      trades: existing.trades + 1
    });
  }

  return [...buckets.values()].sort((a, b) => a.bucketStart - b.bucketStart);
}

export async function fetchSegmentedChartSnapshot(
  tokenAddress: string,
  lookbackBlocks = 20_000n,
  timeframe = 5 * 60_000
): Promise<SegmentedChartSnapshot> {
  const address = getAddress(tokenAddress);
  const [bondingCandles, tokenSnapshot, graduationContext] = await Promise.all([
    fetchBondingCandles(address, lookbackBlocks, timeframe),
    readToken(address),
    resolveGraduationContext(address, lookbackBlocks)
  ]);

const zeroAddress = "0x0000000000000000000000000000000000000000" as const satisfies `0x${string}`;
  const dexCandles: CandlePoint[] = [];
  const pairAddress = graduationContext.pairAddress ?? tokenSnapshot.pair;

  if ((graduationContext.graduationBlock !== null || tokenSnapshot.state === "DEXOnly") && pairAddress && pairAddress !== zeroAddress) {
    const [token0, token1] = (await Promise.all([
      graduationContext.client.readContract({ address: pairAddress, abi: v2PairAbi, functionName: "token0" }),
      graduationContext.client.readContract({ address: pairAddress, abi: v2PairAbi, functionName: "token1" })
    ])) as [`0x${string}`, `0x${string}`];

    const pairLogs = await graduationContext.client.getLogs({
      address: pairAddress,
      fromBlock:
        graduationContext.graduationBlock && graduationContext.graduationBlock > graduationContext.fromBlock
          ? graduationContext.graduationBlock
          : graduationContext.fromBlock,
      toBlock: graduationContext.latestBlock
    });

    const orderedPairLogs = [...pairLogs].sort(sortLogsAscending);
    const pairBlockTimes = await resolveBlockTimes(graduationContext.client, orderedPairLogs);
    const buckets = new Map<number, CandlePoint>();

    for (const log of orderedPairLogs) {
      try {
        const decoded = decodeEventLog({
          abi: v2PairAbi,
          data: log.data,
          topics: log.topics
        });

        if (decoded.eventName !== "Swap") continue;

        const args = decoded.args as unknown as {
          amount0In: bigint;
          amount1In: bigint;
          amount0Out: bigint;
          amount1Out: bigint;
        };

        const isToken0Launch = getAddress(token0) === address;
        const launchIn = isToken0Launch ? args.amount0In : args.amount1In;
        const launchOut = isToken0Launch ? args.amount0Out : args.amount1Out;
        const quoteIn = isToken0Launch ? args.amount1In : args.amount0In;
        const quoteOut = isToken0Launch ? args.amount1Out : args.amount0Out;

        let netQuote = 0n;
        let tokenAmount = 0n;

        if (launchOut > 0n && quoteIn > 0n) {
          netQuote = quoteIn;
          tokenAmount = launchOut;
        } else if (launchIn > 0n && quoteOut > 0n) {
          netQuote = quoteOut;
          tokenAmount = launchIn;
        }

        if (tokenAmount === 0n) continue;

        const price = tradePrice(netQuote, tokenAmount);
        const timestampMs =
          pairBlockTimes.get((log.blockNumber ?? 0n).toString()) ?? graduationContext.graduationTimestampMs ?? Date.now();
        const start = bucketStart(timestampMs, timeframe);
        const existing = buckets.get(start);

        if (!existing) {
          buckets.set(start, {
            bucketStart: start,
            open: price,
            high: price,
            low: price,
            close: price,
            volumeQuote: netQuote,
            volumeToken: tokenAmount,
            trades: 1
          });
          continue;
        }

        buckets.set(start, {
          bucketStart: start,
          open: existing.open,
          high: existing.high > price ? existing.high : price,
          low: existing.low < price ? existing.low : price,
          close: price,
          volumeQuote: existing.volumeQuote + netQuote,
          volumeToken: existing.volumeToken + tokenAmount,
          trades: existing.trades + 1
        });
      } catch {
        // ignore non-swap logs
      }
    }

    dexCandles.push(...[...buckets.values()].sort((a, b) => a.bucketStart - b.bucketStart));
  }

  return {
    bondingCandles,
    dexCandles,
    graduationTimestampMs: graduationContext.graduationTimestampMs
  };
}

export async function fetchUnifiedActivity(tokenAddress: string, lookbackBlocks = 20_000n, limit = 40) {
  const token = getAddress(tokenAddress);
  const client = getPublicClient();
  const latestBlock = await client.getBlockNumber();
  const fromBlock = latestBlock > lookbackBlocks ? latestBlock - lookbackBlocks : 0n;

  const [tokenLogs, tokenSnapshot] = await Promise.all([
    client.getLogs({
      address: token,
      fromBlock,
      toBlock: latestBlock
    }),
    readToken(token)
  ]);

  const orderedTokenLogs = [...tokenLogs].sort(sortLogsAscending);
  const tokenBlockTimes = await resolveBlockTimes(client, orderedTokenLogs);

  const activities: ActivityFeedItem[] = [];
  let graduationBlock: bigint | null = null;
  let graduationPair: `0x${string}` | null = null;

  for (const log of orderedTokenLogs) {
    try {
      const decoded = decodeEventLog({
        abi: launchTokenAbi,
        data: log.data,
        topics: log.topics
      });

      if (decoded.eventName === "BuyExecuted") {
        const args = decoded.args as unknown as {
          netQuoteIn: bigint;
          tokenOut: bigint;
        };

        activities.push({
          token,
          txHash: log.transactionHash as `0x${string}`,
          blockNumber: log.blockNumber ?? 0n,
          logIndex: Number(log.logIndex ?? 0),
          timestampMs: tokenBlockTimes.get((log.blockNumber ?? 0n).toString()) ?? Date.now(),
          kind: "trade",
          source: "protocol",
          phase: "bonding",
          side: "buy",
          marketAddress: token,
          netQuote: args.netQuoteIn,
          tokenAmount: args.tokenOut,
          priceQuotePerToken: tradePrice(args.netQuoteIn, args.tokenOut)
        });
        continue;
      }

      if (decoded.eventName === "SellExecuted") {
        const args = decoded.args as unknown as {
          netQuoteOut: bigint;
          tokenIn: bigint;
        };

        activities.push({
          token,
          txHash: log.transactionHash as `0x${string}`,
          blockNumber: log.blockNumber ?? 0n,
          logIndex: Number(log.logIndex ?? 0),
          timestampMs: tokenBlockTimes.get((log.blockNumber ?? 0n).toString()) ?? Date.now(),
          kind: "trade",
          source: "protocol",
          phase: "bonding",
          side: "sell",
          marketAddress: token,
          netQuote: args.netQuoteOut,
          tokenAmount: args.tokenIn,
          priceQuotePerToken: tradePrice(args.netQuoteOut, args.tokenIn)
        });
        continue;
      }

      if (decoded.eventName === "Graduated") {
        const args = decoded.args as unknown as {
          pair: `0x${string}`;
          tokenAmount: bigint;
          quoteAmountContributed: bigint;
          preloadedQuoteAmount: bigint;
          liquidityBurned: bigint;
        };

        graduationBlock = log.blockNumber ?? null;
        graduationPair = getAddress(args.pair);
        activities.push({
          token,
          txHash: log.transactionHash as `0x${string}`,
          blockNumber: log.blockNumber ?? 0n,
          logIndex: Number(log.logIndex ?? 0),
          timestampMs: tokenBlockTimes.get((log.blockNumber ?? 0n).toString()) ?? Date.now(),
          kind: "graduated",
          source: "system",
          phase: "migrating",
          marketAddress: graduationPair,
          quoteAmountContributed: args.quoteAmountContributed,
          preloadedQuoteAmount: args.preloadedQuoteAmount,
          tokenAmount: args.tokenAmount,
          liquidityBurned: args.liquidityBurned
        });
      }
    } catch {
      // ignore unrelated logs
    }
  }

  const pairAddress = graduationPair ?? tokenSnapshot.pair;
  const zeroAddress = "0x0000000000000000000000000000000000000000";

  if ((graduationBlock !== null || tokenSnapshot.state === "DEXOnly") && pairAddress && pairAddress !== zeroAddress) {
    const [token0, token1] = (await Promise.all([
      client.readContract({ address: pairAddress, abi: v2PairAbi, functionName: "token0" }),
      client.readContract({ address: pairAddress, abi: v2PairAbi, functionName: "token1" })
    ])) as [`0x${string}`, `0x${string}`];

    const pairLogs = await client.getLogs({
      address: pairAddress,
      fromBlock: graduationBlock && graduationBlock > fromBlock ? graduationBlock : fromBlock,
      toBlock: latestBlock
    });
    const orderedPairLogs = [...pairLogs].sort(sortLogsAscending);
    const pairBlockTimes = await resolveBlockTimes(client, orderedPairLogs);

    for (const log of orderedPairLogs) {
      try {
        const decoded = decodeEventLog({
          abi: v2PairAbi,
          data: log.data,
          topics: log.topics
        });

        if (decoded.eventName !== "Swap") continue;

        const args = decoded.args as unknown as {
          amount0In: bigint;
          amount1In: bigint;
          amount0Out: bigint;
          amount1Out: bigint;
        };

        const isToken0Launch = getAddress(token0) === token;
        const launchIn = isToken0Launch ? args.amount0In : args.amount1In;
        const launchOut = isToken0Launch ? args.amount0Out : args.amount1Out;
        const quoteIn = isToken0Launch ? args.amount1In : args.amount0In;
        const quoteOut = isToken0Launch ? args.amount1Out : args.amount0Out;

        let side: "buy" | "sell" | null = null;
        let netQuote = 0n;
        let tokenAmount = 0n;

        if (launchOut > 0n && quoteIn > 0n) {
          side = "buy";
          netQuote = quoteIn;
          tokenAmount = launchOut;
        } else if (launchIn > 0n && quoteOut > 0n) {
          side = "sell";
          netQuote = quoteOut;
          tokenAmount = launchIn;
        }

        if (!side || tokenAmount === 0n) continue;

        activities.push({
          token,
          txHash: log.transactionHash as `0x${string}`,
          blockNumber: log.blockNumber ?? 0n,
          logIndex: Number(log.logIndex ?? 0),
          timestampMs: pairBlockTimes.get((log.blockNumber ?? 0n).toString()) ?? Date.now(),
          kind: "trade",
          source: "dex",
          phase: "dexOnly",
          side,
          marketAddress: pairAddress,
          netQuote,
          tokenAmount,
          priceQuotePerToken: tradePrice(netQuote, tokenAmount)
        });
      } catch {
        // ignore non-swap logs
      }
    }
  }

  return activities
    .sort((a, b) => {
      if (a.blockNumber > b.blockNumber) return -1;
      if (a.blockNumber < b.blockNumber) return 1;
      return b.logIndex - a.logIndex;
    })
    .slice(0, limit);
}

async function normalizeTradeLogs(client: ReturnType<typeof getPublicClient>, logs: Log[]) {
  const orderedLogs = [...logs].sort(sortLogsAscending);
  const decodedTrades = orderedLogs
    .map((log) => {
      try {
        const decoded = decodeEventLog({
          abi: launchTokenAbi,
          data: log.data,
          topics: log.topics
        });

        if (decoded.eventName === "BuyExecuted") {
          const args = decoded.args as unknown as {
            netQuoteIn: bigint;
            tokenOut: bigint;
          };
          return {
            kind: "buy" as const,
            log,
            netQuote: args.netQuoteIn,
            tokenAmount: args.tokenOut
          };
        }

        if (decoded.eventName === "SellExecuted") {
          const args = decoded.args as unknown as {
            netQuoteOut: bigint;
            tokenIn: bigint;
          };
          return {
            kind: "sell" as const,
            log,
            netQuote: args.netQuoteOut,
            tokenAmount: args.tokenIn
          };
        }
      } catch {
        // ignore non-trade logs
      }

      return null;
    })
    .filter((item): item is NonNullable<typeof item> => item !== null);

  const blockTimes = await resolveBlockTimes(client, decodedTrades.map((trade) => trade.log));

  return decodedTrades.map<TradeFeedItem>((trade) => ({
    token: getAddress(trade.log.address),
    txHash: trade.log.transactionHash as `0x${string}`,
    blockNumber: trade.log.blockNumber ?? 0n,
    logIndex: Number(trade.log.logIndex ?? 0),
    timestampMs: blockTimes.get((trade.log.blockNumber ?? 0n).toString()) ?? Date.now(),
    side: trade.kind,
    netQuote: trade.netQuote,
    tokenAmount: trade.tokenAmount,
    priceQuotePerToken: tradePrice(trade.netQuote, trade.tokenAmount)
  }));
}

export function formatNative(value: bigint) {
  return `${Number(formatEther(value)).toLocaleString(undefined, {
    maximumFractionDigits: 6
  })} ${activeProtocolProfile.nativeSymbol}`;
}

export function formatToken(value: bigint, decimals = 18) {
  return Number(formatUnits(value, decimals)).toLocaleString(undefined, {
    maximumFractionDigits: 4
  });
}

export function formatDateTime(timestampMs: number) {
  return new Date(timestampMs).toLocaleString();
}

declare global {
  interface Window {
    ethereum?: {
      request: (args: { method: string; params?: unknown[] }) => Promise<any>;
    };
  }
}
