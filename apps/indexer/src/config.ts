import { resolveIndexerProfile } from "./profiles";

const chainId = process.env.INDEXER_CHAIN_ID ? Number(process.env.INDEXER_CHAIN_ID) : 56;
const profile = resolveIndexerProfile(chainId);

export const indexerConfig = {
  chainId,
  chain: profile.chainLabel,
  nativeSymbol: profile.nativeSymbol,
  wrappedNativeSymbol: profile.wrappedNativeSymbol,
  dexName: profile.dexName,
  rpcUrl: process.env.INDEXER_RPC_URL ?? profile.defaultRpcUrl,
  factoryAddress: process.env.INDEXER_FACTORY_ADDRESS as `0x${string}` | undefined,
  fromBlock: process.env.INDEXER_FROM_BLOCK ? BigInt(process.env.INDEXER_FROM_BLOCK) : undefined,
  lookbackBlocks: process.env.INDEXER_LOOKBACK_BLOCKS ? BigInt(process.env.INDEXER_LOOKBACK_BLOCKS) : 50_000n,
  launchLimit: process.env.INDEXER_LAUNCH_LIMIT ? Number(process.env.INDEXER_LAUNCH_LIMIT) : 25,
  activityLimitPerLaunch: process.env.INDEXER_ACTIVITY_LIMIT ? Number(process.env.INDEXER_ACTIVITY_LIMIT) : 40,
  outputPath: process.env.INDEXER_OUTPUT_PATH ?? "../web/public/data/indexer-snapshot.json",
  notes: [
    "Pre-graduation prices come from LaunchToken events, not external DEX candles.",
    "Index trades into OHLCV buckets before and after graduation using one canonical timeline.",
    "Graduation is a state transition, so one tx can both finish the curve and seed the canonical V2 pair.",
    "Prefer bounded snapshots and token-scoped API routes to keep server costs predictable."
  ]
} as const;
