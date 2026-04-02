export type FactorySnapshot = {
  address: `0x${string}`;
  router: `0x${string}`;
  protocolFeeRecipient: `0x${string}`;
  createFee: bigint;
  graduationQuoteReserve: bigint;
  totalLaunches: bigint;
  accruedProtocolCreateFees: bigint;
  recentLaunches: `0x${string}`[];
};

export type TokenSnapshot = {
  address: `0x${string}`;
  name: string;
  symbol: string;
  state: string;
  pair: `0x${string}`;
  creator: `0x${string}`;
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
  dexTokenReserve: bigint;
  dexQuoteReserve: bigint;
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
