import { resolveExplorerApiUrl } from "./explorer";
import { resolveIndexerProfile } from "./profiles";

const chainId = process.env.INDEXER_CHAIN_ID ? Number(process.env.INDEXER_CHAIN_ID) : 56;
const profile = resolveIndexerProfile(chainId);
if (process.env.INDEXER_CHAIN_ID && profile.chainId !== chainId) {
  throw new Error(`Unsupported INDEXER_CHAIN_ID=${process.env.INDEXER_CHAIN_ID}`);
}
const defaultMaxPostBodyBytes = 2 * 1024 * 1024;
const defaultMaxImageUploadBytes = 8 * 1024 * 1024;
const configuredBscScanApiUrl = process.env.INDEXER_BSCSCAN_API_URL ?? process.env.BSCSCAN_API_URL;
const configuredBaseScanApiUrl = process.env.INDEXER_BASESCAN_API_URL ?? process.env.BASESCAN_API_URL;
const configuredEtherscanApiUrl = process.env.INDEXER_ETHERSCAN_API_URL ?? process.env.ETHERSCAN_API_URL;
const configuredEtherscanApiKey =
  process.env.INDEXER_ETHERSCAN_API_KEY
  ?? process.env.ETHERSCAN_API_KEY
  ?? undefined;
const configuredBscScanApiKey =
  process.env.INDEXER_BSCSCAN_API_KEY
  ?? process.env.BSCSCAN_API_KEY
  ?? undefined;
const configuredBaseScanApiKey =
  process.env.INDEXER_BASESCAN_API_KEY
  ?? process.env.BASESCAN_API_KEY
  ?? undefined;

function parsePositiveIntList(value: string | undefined, fallback: number[]) {
  if (!value) return fallback;
  const parsed = value
    .split(/[,\s]+/)
    .map((entry) => Number(entry.trim()))
    .filter((entry) => Number.isFinite(entry) && entry > 0)
    .map((entry) => Math.floor(entry));

  return parsed.length > 0 ? [...new Set(parsed)].sort((a, b) => a - b) : fallback;
}

function parseOriginList(value: string | undefined, fallback: string[]) {
  if (!value) return fallback;
  const parsed = value
    .split(/[,\s]+/)
    .map((entry) => entry.trim().replace(/\/$/, "").toLowerCase())
    .filter(Boolean);

  return parsed.length > 0 ? [...new Set(parsed)] : fallback;
}

export const indexerConfig = {
  chainId,
  chain: profile.chainLabel,
  nativeSymbol: profile.nativeSymbol,
  wrappedNativeSymbol: profile.wrappedNativeSymbol,
  dexName: profile.dexName,
  rpcUrl: process.env.INDEXER_RPC_URL ?? profile.defaultRpcUrl,
  factoryAddress: process.env.INDEXER_FACTORY_ADDRESS as `0x${string}` | undefined,
  fromBlock: process.env.INDEXER_FROM_BLOCK ? BigInt(process.env.INDEXER_FROM_BLOCK) : undefined,
  toBlock: process.env.INDEXER_TO_BLOCK ? BigInt(process.env.INDEXER_TO_BLOCK) : undefined,
  lookbackBlocks: process.env.INDEXER_LOOKBACK_BLOCKS ? BigInt(process.env.INDEXER_LOOKBACK_BLOCKS) : 50_000n,
  logBatchBlocks: process.env.INDEXER_LOG_BATCH_BLOCKS ? BigInt(process.env.INDEXER_LOG_BATCH_BLOCKS) : 2_000n,
  launchLimit: process.env.INDEXER_LAUNCH_LIMIT ? Number(process.env.INDEXER_LAUNCH_LIMIT) : 25,
  activityLimitPerLaunch: process.env.INDEXER_ACTIVITY_LIMIT ? Number(process.env.INDEXER_ACTIVITY_LIMIT) : 40,
  outputPath: process.env.INDEXER_OUTPUT_PATH ?? "../web/public/data/indexer-snapshot.json",
  autoVerifyEnabled: process.env.INDEXER_AUTO_VERIFY_ENABLED !== "0",
  autoVerifyIntervalMs: process.env.INDEXER_AUTO_VERIFY_INTERVAL_MS ? Number(process.env.INDEXER_AUTO_VERIFY_INTERVAL_MS) : 60_000,
  autoVerifyMinConfirmations: process.env.INDEXER_AUTO_VERIFY_MIN_CONFIRMATIONS ? Number(process.env.INDEXER_AUTO_VERIFY_MIN_CONFIRMATIONS) : 2,
  autoVerifyMaxTargetsPerRun: process.env.INDEXER_AUTO_VERIFY_MAX_TARGETS_PER_RUN ? Number(process.env.INDEXER_AUTO_VERIFY_MAX_TARGETS_PER_RUN) : 6,
  autoVerifyBootstrapOfficial: process.env.INDEXER_AUTO_VERIFY_BOOTSTRAP_OFFICIAL !== "0",
  sourcifyServerUrl: (process.env.INDEXER_SOURCIFY_SERVER_URL ?? "https://sourcify.dev/server").replace(/\/$/, ""),
  etherscanApiUrl: resolveExplorerApiUrl({
    chainId,
    bscScanApiUrl: configuredBscScanApiUrl,
    baseScanApiUrl: configuredBaseScanApiUrl,
    etherscanApiUrl: configuredEtherscanApiUrl,
    defaultApiUrl: profile.explorerApiUrl,
    preferMultichainApi: Boolean(configuredEtherscanApiKey),
    hasBscScanApiKey: Boolean(configuredBscScanApiKey),
    hasBaseScanApiKey: Boolean(configuredBaseScanApiKey),
    hasEtherscanApiKey: Boolean(configuredEtherscanApiKey)
  }),
  etherscanApiKey: (
    configuredEtherscanApiKey
    ?? configuredBscScanApiKey
    ?? configuredBaseScanApiKey
  ) || undefined,
  xClientId: process.env.INDEXER_X_CLIENT_ID ?? process.env.X_CLIENT_ID ?? undefined,
  xClientSecret: process.env.INDEXER_X_CLIENT_SECRET ?? process.env.X_CLIENT_SECRET ?? undefined,
  xCallbackUrl: process.env.INDEXER_X_CALLBACK_URL ?? process.env.X_CALLBACK_URL ?? undefined,
  xScopes: (process.env.INDEXER_X_SCOPES ?? process.env.X_SCOPES ?? "tweet.read tweet.write users.read offline.access")
    .split(/[,\s]+/)
    .map((value) => value.trim())
    .filter(Boolean),
  xAccountAccessToken:
    process.env.INDEXER_X_ACCOUNT_ACCESS_TOKEN
    ?? process.env.X_ACCOUNT_ACCESS_TOKEN
    ?? undefined,
  xAccountRefreshToken:
    process.env.INDEXER_X_ACCOUNT_REFRESH_TOKEN
    ?? process.env.X_ACCOUNT_REFRESH_TOKEN
    ?? undefined,
  xPostSharedSecret:
    process.env.INDEXER_X_POST_SHARED_SECRET
    ?? process.env.X_POST_SHARED_SECRET
    ?? undefined,
  metadataPostSharedSecret:
    process.env.INDEXER_METADATA_POST_SHARED_SECRET
    ?? process.env.INDEXER_X_POST_SHARED_SECRET
    ?? process.env.X_POST_SHARED_SECRET
    ?? undefined,
  metadataPublicOrigins: parseOriginList(
    process.env.INDEXER_METADATA_PUBLIC_ORIGINS,
    [
      (process.env.INDEXER_SOCIAL_NOTIFY_BASE_URL ?? "https://auto314.cc").replace(/\/$/, ""),
      "http://localhost:5173",
      "http://127.0.0.1:5173"
    ]
  ),
  publicBaseUrl: (process.env.INDEXER_PUBLIC_BASE_URL ?? process.env.INDEXER_SOCIAL_NOTIFY_BASE_URL ?? "https://auto314.cc").replace(/\/$/, ""),
  maxPostBodyBytes: (() => {
    const parsed = process.env.INDEXER_MAX_POST_BODY_BYTES ? Number(process.env.INDEXER_MAX_POST_BODY_BYTES) : NaN;
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : defaultMaxPostBodyBytes;
  })(),
  maxImageUploadBytes: (() => {
    const parsed = process.env.INDEXER_MAX_IMAGE_UPLOAD_BYTES ? Number(process.env.INDEXER_MAX_IMAGE_UPLOAD_BYTES) : NaN;
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : defaultMaxImageUploadBytes;
  })(),
  socialNotifyEnabled: process.env.INDEXER_SOCIAL_NOTIFY_ENABLED === "1",
  socialNotifyIntervalMs: process.env.INDEXER_SOCIAL_NOTIFY_INTERVAL_MS ? Number(process.env.INDEXER_SOCIAL_NOTIFY_INTERVAL_MS) : 60_000,
  socialNotifyBaseUrl: (process.env.INDEXER_SOCIAL_NOTIFY_BASE_URL ?? "https://auto314.cc").replace(/\/$/, ""),
  socialNotifyXEnabled: process.env.INDEXER_SOCIAL_NOTIFY_X_ENABLED !== "0",
  socialNotifyProjectTelegramEnabled:
    (process.env.INDEXER_SOCIAL_NOTIFY_PROJECT_TELEGRAM_ENABLED
      ?? process.env.INDEXER_SOCIAL_NOTIFY_TELEGRAM_ENABLED
      ?? "1") !== "0",
  socialNotifyAlertTelegramEnabled:
    (process.env.INDEXER_SOCIAL_NOTIFY_ALERT_TELEGRAM_ENABLED ?? "1") !== "0",
  socialNotifyMarketCapThresholdsUsd: parsePositiveIntList(
    process.env.INDEXER_SOCIAL_NOTIFY_MARKET_CAP_THRESHOLDS_USD,
    [100_000, 500_000, 1_000_000]
  ),
  nativeUsdPriceApiUrl:
    process.env.INDEXER_NATIVE_USD_PRICE_API_URL
    ?? profile.nativeUsdPriceApiUrl,
  projectTelegramBotToken:
    process.env.INDEXER_TELEGRAM_PROJECT_BOT_TOKEN
    ?? process.env.INDEXER_TELEGRAM_BOT_TOKEN
    ?? process.env.TELEGRAM_BOT_TOKEN
    ?? undefined,
  projectTelegramChatId:
    process.env.INDEXER_TELEGRAM_PROJECT_CHAT_ID
    ?? process.env.INDEXER_TELEGRAM_CHAT_ID
    ?? process.env.TELEGRAM_CHAT_ID
    ?? undefined,
  projectTelegramMessageThreadId:
    process.env.INDEXER_TELEGRAM_PROJECT_MESSAGE_THREAD_ID
    ?? process.env.INDEXER_TELEGRAM_MESSAGE_THREAD_ID
    ?? process.env.TELEGRAM_MESSAGE_THREAD_ID
    ?? undefined,
  alertTelegramBotToken:
    process.env.INDEXER_TELEGRAM_ALERT_BOT_TOKEN
    ?? undefined,
  alertTelegramChatId:
    process.env.INDEXER_TELEGRAM_ALERT_CHAT_ID
    ?? undefined,
  alertTelegramMessageThreadId:
    process.env.INDEXER_TELEGRAM_ALERT_MESSAGE_THREAD_ID
    ?? undefined,
  notes: [
    "Pre-graduation prices come from LaunchToken events, not external DEX candles.",
    "Index trades into OHLCV buckets before and after graduation using one canonical timeline.",
    "Graduation is a state transition, so one tx can both finish the curve and seed the canonical V2 pair.",
    "Prefer bounded snapshots and token-scoped API routes to keep server costs predictable."
  ]
} as const;
