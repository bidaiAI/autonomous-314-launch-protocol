export type LaunchState = "Created" | "Bonding314" | "Migrating" | "DEXOnly" | "WhitelistCommit";
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

export type TaxConfigSnapshot = {
  enabled: boolean;
  taxBps: string;
  burnShareBps: string;
  treasuryShareBps: string;
  treasuryWallet: `0x${string}` | null;
  active: boolean;
} | null;

export type WhitelistSnapshot = {
  status: string;
  opensAt: string;
  deadline: string;
  threshold: string;
  slotSize: string;
  seatCount: string;
  seatsFilled: string;
  committedTotal: string;
  tokensPerSeat: string;
} | null;

export type LaunchSnapshot = {
  token: `0x${string}`;
  creator: `0x${string}`;
  state: LaunchState;
  pair: `0x${string}` | null;
  curveQuoteReserve: string;
  saleTokenReserve: string;
  lpTokenReserve: string;
  protocolFeeVault: string;
  creatorFeeVault: string;
  graduationProgressBps: number;
  priceQuotePerToken: string;
  updatedAtBlock: bigint;
};

export type TradeRecord = {
  kind: "trade";
  token: `0x${string}`;
  marketAddress: `0x${string}`;
  actor: `0x${string}` | null;
  txHash: `0x${string}`;
  blockNumber: bigint;
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
};

export type ActivityRecord =
  | TradeRecord
  | {
      token: `0x${string}`;
      marketAddress: `0x${string}`;
      txHash: `0x${string}`;
      blockNumber: bigint;
      logIndex: number;
      timestampMs: number;
      source: "system";
      phase: "migrating";
      kind: "graduated";
      quoteAmountContributed: string;
      preloadedQuoteAmount: string;
      tokenAmount: string;
      liquidityBurned: string;
    };

export type CandleBucket = {
  token: `0x${string}`;
  timeframe: "1m" | "5m" | "15m" | "1h" | "4h" | "1d";
  bucketStart: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volumeQuote: string;
  volumeToken: string;
  trades: number;
};

export type SegmentedChartSnapshot = {
  bondingCandles: CandleBucket[];
  dexCandles: CandleBucket[];
  graduationTimestampMs: number | null;
};

export type LaunchWorkspaceSnapshot = {
  token: `0x${string}`;
  creator: `0x${string}`;
  name: string;
  symbol: string;
  totalSupply: string;
  mode: number;
  modeLabel: LaunchMode;
  suffix: string;
  metadataURI: string;
  state: LaunchState;
  pair: `0x${string}`;
  graduationQuoteReserve: string;
  currentPriceQuotePerToken: string;
  graduationProgressBps: number;
  remainingQuoteCapacity: string;
  pairPreloadedQuote: string;
  pairClean: boolean;
  pairGraduationCompatible: boolean;
  protocolFeeAccrued: string;
  creatorFeeAccrued: string;
  protocolClaimable: string;
  creatorClaimable: string;
  whitelistStatus: string;
  whitelistSnapshot: WhitelistSnapshot;
  taxConfig: TaxConfigSnapshot;
  dexTokenReserve: string;
  dexQuoteReserve: string;
  recentActivity: ActivityRecord[];
  segmentedChart: SegmentedChartSnapshot;
};

export type IndexerSnapshot = {
  generatedAtMs: number;
  chainId: number;
  chain: string;
  nativeSymbol: string;
  wrappedNativeSymbol: string;
  dexName: string;
  factory: `0x${string}`;
  fromBlock: string;
  toBlock: string;
  launchCount: number;
  launches: LaunchWorkspaceSnapshot[];
};
