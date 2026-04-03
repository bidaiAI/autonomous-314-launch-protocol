export type FactorySnapshot = {
  address: `0x${string}`;
  router: `0x${string}`;
  protocolFeeRecipient: `0x${string}`;
  standardDeployer: `0x${string}`;
  whitelistDeployer: `0x${string}`;
  taxedDeployer: `0x${string}`;
  whitelistTaxedDeployer: `0x${string}`;
  createFee: bigint;
  standardCreateFee: bigint;
  whitelistCreateFee: bigint;
  supportsWhitelistMode: boolean;
  supportsTaxedMode: boolean;
  supportsWhitelistTaxedMode: boolean;
  graduationQuoteReserve: bigint;
  totalLaunches: bigint;
  accruedProtocolCreateFees: bigint;
  recentLaunches: `0x${string}`[];
};

export type LaunchMode =
  | "Unregistered"
  | "Standard0314"
  | "WhitelistB314"
  | "Taxed1314"
  | "Taxed2314"
  | "Taxed3314"
  | "Taxed4314"
  | "Taxed5314"
  | "Taxed6314"
  | "Taxed7314"
  | "Taxed8314"
  | "Taxed9314"
  | "WhitelistTaxF314";

export type LaunchCreationFamily = "standard" | "whitelist" | "taxed" | "whitelistTaxed";

export type TaxConfig = {
  enabled: boolean;
  configuredTaxBps: bigint;
  burnBps: bigint;
  treasuryBps: bigint;
  wallet: `0x${string}`;
  active: boolean;
};

export type WhitelistSnapshot = {
  status: bigint;
  deadline: bigint;
  threshold: bigint;
  slotSize: bigint;
  seatCount: bigint;
  seatsFilled: bigint;
  committedTotal: bigint;
  tokensPerSeat: bigint;
  whitelistCount: bigint;
};

export type TokenSnapshot = {
  address: `0x${string}`;
  name: string;
  symbol: string;
  state: string;
  launchModeId: bigint;
  launchMode: LaunchMode;
  launchSuffix: string;
  factory: `0x${string}`;
  pair: `0x${string}`;
  creator: `0x${string}`;
  protocolFeeRecipient: `0x${string}`;
  router: `0x${string}`;
  dexFactory: `0x${string}`;
  wrappedNative: `0x${string}`;
  metadataURI: string;
  graduationQuoteReserve: bigint;
  currentPriceQuotePerToken: bigint;
  graduationProgressBps: bigint;
  remainingQuoteCapacity: bigint;
  pairPreloadedQuote: bigint;
  pairClean: boolean;
  pairGraduationCompatible: boolean;
  protocolClaimable: bigint;
  creatorClaimable: bigint;
  creatorFeeSweepReady: boolean;
  createdAt: bigint;
  lastTradeAt: bigint;
  taxConfig: TaxConfig | null;
  whitelistStatus: bigint;
  whitelistSnapshot: WhitelistSnapshot | null;
  dexTokenReserve: bigint;
  dexQuoteReserve: bigint;
};

export type ProtocolVerification = {
  status: "official" | "warning" | "foreign" | "error";
  summary: string;
  checks: {
    factoryMatches: boolean;
    factoryRegistryRecognizesToken: boolean;
    tokenModeMatchesFactory: boolean;
    launchEventFound: boolean;
    eventMetadataMatchesToken: boolean;
    protocolRecipientMatches: boolean;
    routerMatches: boolean;
    graduationTargetMatches: boolean;
    pairMatchesDex: boolean;
    suffixMatchesMode: boolean;
  };
};

export type TradeFeedItem = {
  token: `0x${string}`;
  txHash: `0x${string}`;
  blockNumber: bigint;
  logIndex: number;
  timestampMs: number;
  side: "buy" | "sell";
  netQuote: bigint;
  tokenAmount: bigint;
  priceQuotePerToken: bigint;
};

export type ActivityFeedItem =
  | {
      token: `0x${string}`;
      txHash: `0x${string}`;
      blockNumber: bigint;
      logIndex: number;
      timestampMs: number;
      kind: "trade";
      source: "protocol" | "dex";
      phase: "bonding" | "dexOnly";
      side: "buy" | "sell";
      marketAddress: `0x${string}`;
      netQuote: bigint;
      tokenAmount: bigint;
      priceQuotePerToken: bigint;
    }
  | {
      token: `0x${string}`;
      txHash: `0x${string}`;
      blockNumber: bigint;
      logIndex: number;
      timestampMs: number;
      kind: "graduated";
      source: "system";
      phase: "migrating";
      marketAddress: `0x${string}`;
      quoteAmountContributed: bigint;
      preloadedQuoteAmount: bigint;
      tokenAmount: bigint;
      liquidityBurned: bigint;
    };

export type CandlePoint = {
  bucketStart: number;
  open: bigint;
  high: bigint;
  low: bigint;
  close: bigint;
  volumeQuote: bigint;
  volumeToken: bigint;
  trades: number;
};

export type SegmentedChartSnapshot = {
  bondingCandles: CandlePoint[];
  dexCandles: CandlePoint[];
  graduationTimestampMs: number | null;
};

export type LaunchMetadata = {
  version: "autonomous314/v1";
  name: string;
  symbol: string;
  description?: string;
  image?: string;
  external_url?: string;
  website?: string;
  twitter?: string;
  telegram?: string;
  discord?: string;
};
