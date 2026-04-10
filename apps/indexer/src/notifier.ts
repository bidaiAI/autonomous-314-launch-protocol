import { indexerConfig } from "./config";
import { resolveIndexerProfile } from "./profiles";
import { buildIndexerSnapshot } from "./service";
import type { ActivityRecord, LaunchState, LaunchWorkspaceSnapshot, WhitelistSnapshot } from "./schema";
import { createXPost, isXPublishingConfigured } from "./x-publish";
import { formatUnits } from "viem";

type NotificationChannel = "x" | "projectTelegram" | "alertTelegram";
type NotificationKind = "created" | "graduated" | "marketCap";
type TelegramTarget = "project" | "alert";

type LaunchMetadataSummary = {
  image: string | null;
  website: string | null;
  twitter: string | null;
  telegram: string | null;
  discord: string | null;
};

type NotificationEventBase = {
  key: string;
  token: `0x${string}`;
  name: string;
  symbol: string;
  modeLabel: string;
  state: LaunchState;
  pair: `0x${string}`;
  creator: `0x${string}`;
  launchUrl: string;
  explorerTokenUrl: string | null;
  explorerPairUrl: string | null;
  metadata: LaunchMetadataSummary;
  whitelistSnapshot: WhitelistSnapshot | null;
  timestampMs: number;
};

type NotificationEvent =
  | (NotificationEventBase & {
      kind: "created";
      explorerTxUrl: string | null;
      creationTxHash: `0x${string}` | null;
    })
  | (NotificationEventBase & {
      kind: "graduated";
      explorerTxUrl: string | null;
      graduationTxHash: `0x${string}` | null;
      marketCapUsd: number | null;
      currentPriceNative: bigint;
    })
  | (NotificationEventBase & {
      kind: "marketCap";
      thresholdUsd: number;
      marketCapUsd: number;
      currentPriceNative: bigint;
    });

type PendingNotification = {
  event: NotificationEvent;
  deliveredChannels: Set<NotificationChannel>;
  attempts: number;
  nextAttemptAtMs: number;
  lastError: string | null;
  createdAtMs: number;
  lastAttemptAtMs: number | null;
  deliveredAtMs: number | null;
};

type LaunchBaseline = {
  graduated: boolean;
  marketCapUsd: number | null;
  announcedThresholds: Set<number>;
};

export type NotificationWorkerSnapshot = {
  enabled: boolean;
  intervalMs: number;
  xConfigured: boolean;
  projectTelegramConfigured: boolean;
  alertTelegramConfigured: boolean;
  running: boolean;
  baselineInitialized: boolean;
  trackedLaunches: number;
  pendingNotifications: number;
  lastRunStartedAtMs: number | null;
  lastRunFinishedAtMs: number | null;
  lastError: string | null;
  marketCapThresholdsUsd: number[];
  recent: Array<{
    key: string;
    kind: NotificationKind;
    token: `0x${string}`;
    symbol: string;
    attempts: number;
    deliveredChannels: NotificationChannel[];
    deliveredAtMs: number | null;
    lastError: string | null;
  }>;
};

const TOTAL_SUPPLY_FALLBACK = 1_000_000_000n * 10n ** 18n;
const PRICE_CACHE_TTL_MS = 60_000;
const METADATA_CACHE_TTL_MS = 10 * 60_000;
const profile = resolveIndexerProfile(indexerConfig.chainId);
const explorerBaseUrl = profile.viemChain.blockExplorers?.default.url?.replace(/\/$/, "") ?? null;

function nowMs() {
  return Date.now();
}

function backoffMs(attempts: number) {
  if (attempts <= 1) return 15_000;
  if (attempts === 2) return 60_000;
  return Math.min(10 * 60_000, attempts * 60_000);
}

function compactNumber(value: number) {
  if (!Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  const units = [
    { limit: 1e12, suffix: "T" },
    { limit: 1e9, suffix: "B" },
    { limit: 1e6, suffix: "M" },
    { limit: 1e3, suffix: "k" }
  ];
  for (const unit of units) {
    if (abs >= unit.limit) {
      const scaled = value / unit.limit;
      const digits = Math.abs(scaled) >= 100 ? 0 : Math.abs(scaled) >= 10 ? 1 : 1;
      return `${scaled.toFixed(digits).replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1")}${unit.suffix}`;
    }
  }
  return value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2).replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
}

function shortAddress(value: string) {
  return value.length <= 12 ? value : `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function formatNativeAmount(value: string | null | undefined) {
  if (!value || value === "0") return null;
  const numeric = Number(formatUnits(BigInt(value), 18));
  if (!Number.isFinite(numeric)) return null;
  const formatted =
    numeric >= 100
      ? numeric.toFixed(0)
      : numeric >= 1
        ? numeric.toFixed(2).replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1")
        : numeric.toFixed(4).replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
  return `${formatted} ${profile.nativeSymbol}`;
}

function quoteMarketCap(totalSupply: bigint, priceQuotePerToken: bigint) {
  if (totalSupply <= 0n || priceQuotePerToken <= 0n) return 0n;
  return (totalSupply * priceQuotePerToken) / 10n ** 18n;
}

function launchMarketCapUsd(launch: LaunchWorkspaceSnapshot, nativeUsdPrice: number | null) {
  if (nativeUsdPrice === null || !Number.isFinite(nativeUsdPrice) || nativeUsdPrice <= 0) {
    return null;
  }
  const totalSupply = launch.totalSupply ? BigInt(launch.totalSupply) : TOTAL_SUPPLY_FALLBACK;
  const marketCapNative = quoteMarketCap(totalSupply, BigInt(launch.currentPriceQuotePerToken));
  if (marketCapNative <= 0n) return null;
  return (Number(marketCapNative) / 1e18) * nativeUsdPrice;
}

function buildLaunchUrl(token: `0x${string}`) {
  return `${indexerConfig.socialNotifyBaseUrl}/c/${indexerConfig.chainId}/launch/${token}`;
}

function buildExplorerUrl(kind: "token" | "address" | "tx", value: string) {
  if (!explorerBaseUrl) return null;
  if (kind === "tx") return `${explorerBaseUrl}/tx/${value}`;
  if (kind === "address") return `${explorerBaseUrl}/address/${value}`;
  return `${explorerBaseUrl}/token/${value}`;
}

function parseUnixSeconds(value: string | null | undefined) {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed * 1000 : null;
}

function formatUtc(valueMs: number | null) {
  if (!valueMs) return null;
  const value = new Date(valueMs);
  const year = value.getUTCFullYear();
  const month = `${value.getUTCMonth() + 1}`.padStart(2, "0");
  const day = `${value.getUTCDate()}`.padStart(2, "0");
  const hours = `${value.getUTCHours()}`.padStart(2, "0");
  const minutes = `${value.getUTCMinutes()}`.padStart(2, "0");
  return `${year}-${month}-${day} ${hours}:${minutes} UTC`;
}

function normalizeUrl(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function safeJson(response: Response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function isXChannelConfigured() {
  return (
    indexerConfig.socialNotifyXEnabled
    && isXPublishingConfigured({
      clientId: indexerConfig.xClientId,
      clientSecret: indexerConfig.xClientSecret,
      accessToken: indexerConfig.xAccountAccessToken,
      refreshToken: indexerConfig.xAccountRefreshToken
    })
  );
}

function isProjectTelegramConfigured() {
  return (
    indexerConfig.socialNotifyProjectTelegramEnabled
    && Boolean(indexerConfig.projectTelegramBotToken)
    && Boolean(indexerConfig.projectTelegramChatId)
  );
}

function isAlertTelegramConfigured() {
  return (
    indexerConfig.socialNotifyAlertTelegramEnabled
    && Boolean(indexerConfig.alertTelegramBotToken)
    && Boolean(indexerConfig.alertTelegramChatId)
  );
}

function channelsForEvent(event: NotificationEvent): NotificationChannel[] {
  if (event.kind === "created") {
    return isAlertTelegramConfigured() ? ["alertTelegram"] : [];
  }

  const channels: NotificationChannel[] = [];
  if (isXChannelConfigured()) channels.push("x");
  if (isProjectTelegramConfigured()) channels.push("projectTelegram");
  return channels;
}

function latestGraduationActivity(launch: LaunchWorkspaceSnapshot) {
  return launch.recentActivity.find((activity): activity is Extract<ActivityRecord, { kind: "graduated" }> => activity.kind === "graduated") ?? null;
}

function latestActivityTxHash(launch: LaunchWorkspaceSnapshot) {
  return launch.recentActivity[0]?.txHash ?? null;
}

function formatWhitelistSummary(whitelistSnapshot: WhitelistSnapshot | null) {
  if (!whitelistSnapshot) return [];
  const lines: string[] = [];
  if (whitelistSnapshot.seatCount !== "0") {
    lines.push(`Seats: ${whitelistSnapshot.seatCount}`);
  }
  if (whitelistSnapshot.seatsFilled !== "0") {
    lines.push(`Filled: ${whitelistSnapshot.seatsFilled}`);
  }
  if (whitelistSnapshot.slotSize !== "0") {
    lines.push(`Slot size: ${formatNativeAmount(whitelistSnapshot.slotSize) ?? whitelistSnapshot.slotSize}`);
  }
  const opensAt = formatUtc(parseUnixSeconds(whitelistSnapshot.opensAt));
  if (opensAt) {
    lines.push(`Opens: ${opensAt}`);
  }
  const deadline = formatUtc(parseUnixSeconds(whitelistSnapshot.deadline));
  if (deadline) {
    lines.push(`Deadline: ${deadline}`);
  }
  if (whitelistSnapshot.threshold !== "0") {
    lines.push(`Threshold: ${formatNativeAmount(whitelistSnapshot.threshold) ?? whitelistSnapshot.threshold}`);
  }
  return lines;
}

function notificationChainTag() {
  if (indexerConfig.chainId === 56) return "BSC";
  if (indexerConfig.chainId === 8453) return "Base";
  return profile.chainLabel;
}

function emptyMetadataSummary(): LaunchMetadataSummary {
  return {
    image: null,
    website: null,
    twitter: null,
    telegram: null,
    discord: null
  };
}

function parseMetadataPayload(payload: unknown): LaunchMetadataSummary {
  if (!payload || typeof payload !== "object") {
    return emptyMetadataSummary();
  }
  const candidate = payload as Record<string, unknown>;
  return {
    image: normalizeUrl(candidate.image),
    website: normalizeUrl(candidate.website) ?? normalizeUrl(candidate.external_url),
    twitter: normalizeUrl(candidate.twitter),
    telegram: normalizeUrl(candidate.telegram),
    discord: normalizeUrl(candidate.discord)
  };
}

function decodeDataUriJson(value: string) {
  const match = value.match(/^data:application\/json[^,]*,(.*)$/i);
  if (!match) return null;
  try {
    return JSON.parse(decodeURIComponent(match[1] ?? ""));
  } catch {
    return null;
  }
}

function baseEvent(
  launch: LaunchWorkspaceSnapshot,
  metadata: LaunchMetadataSummary,
  timestampMs: number
): NotificationEventBase {
  return {
    key: "",
    token: launch.token,
    name: launch.name,
    symbol: launch.symbol,
    modeLabel: launch.modeLabel,
    state: launch.state,
    pair: launch.pair,
    creator: launch.creator,
    launchUrl: buildLaunchUrl(launch.token),
    explorerTokenUrl: buildExplorerUrl("token", launch.token),
    explorerPairUrl:
      launch.pair && launch.pair !== "0x0000000000000000000000000000000000000000"
        ? buildExplorerUrl("address", launch.pair)
        : null,
    metadata,
    whitelistSnapshot: launch.whitelistSnapshot,
    timestampMs
  };
}

function telegramTargetConfig(target: TelegramTarget) {
  if (target === "project") {
    return {
      botToken: indexerConfig.projectTelegramBotToken,
      chatId: indexerConfig.projectTelegramChatId,
      messageThreadId: indexerConfig.projectTelegramMessageThreadId
    };
  }

  return {
    botToken: indexerConfig.alertTelegramBotToken,
    chatId: indexerConfig.alertTelegramChatId,
    messageThreadId: indexerConfig.alertTelegramMessageThreadId
  };
}

async function sendTelegramMessage(target: TelegramTarget, text: string) {
  const config = telegramTargetConfig(target);
  if (!config.botToken || !config.chatId) {
    throw new Error(`Telegram target '${target}' is not configured.`);
  }

  const response = await fetch(`https://api.telegram.org/bot${config.botToken}/sendMessage`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      chat_id: config.chatId,
      text,
      disable_web_page_preview: false,
      ...(config.messageThreadId
        ? {
            message_thread_id: Number(config.messageThreadId)
          }
        : {})
    })
  });

  const body = await safeJson(response);
  if (!response.ok || body?.ok === false) {
    throw new Error(body?.description || `Telegram sendMessage failed with ${response.status}.`);
  }
}

function isLaunchGraduated(launch: LaunchWorkspaceSnapshot) {
  return launch.state === "DEXOnly" || latestGraduationActivity(launch) !== null;
}

function formatXNotification(event: NotificationEvent) {
  if (event.kind === "created") {
    const whitelistBits = formatWhitelistSummary(event.whitelistSnapshot);
    return [
      "New launch on Autonomous 314",
      "",
      `[${notificationChainTag()}] $${event.symbol} (${event.modeLabel})`,
      `Contract: ${shortAddress(event.token)}`,
      ...(whitelistBits.length > 0 ? [whitelistBits[0]!] : []),
      `App: ${event.launchUrl}`
    ].join("\n");
  }

  if (event.kind === "graduated") {
    return [
      "Graduated on Autonomous 314",
      "",
      `[${notificationChainTag()}] $${event.symbol} just moved from bonding to ${profile.dexName}.`,
      ...(event.marketCapUsd ? [`MCap: ~$${compactNumber(event.marketCapUsd)}`] : []),
      `Contract: ${shortAddress(event.token)}`,
      `App: ${event.launchUrl}`
    ].join("\n");
  }

  return [
    "Market cap alert on Autonomous 314",
    "",
    `[${notificationChainTag()}] $${event.symbol} just crossed $${compactNumber(event.thresholdUsd)}.`,
    `Now: ~$${compactNumber(event.marketCapUsd)}`,
    `Contract: ${shortAddress(event.token)}`,
    `App: ${event.launchUrl}`
  ].join("\n");
}

function formatTelegramNotification(event: NotificationEvent) {
  if (event.kind === "created") {
    return [
      "🆕 New launch on Autonomous 314",
      "",
      `Chain: ${profile.chainLabel}`,
      `${event.name} ($${event.symbol})`,
      `Mode: ${event.modeLabel}`,
      `Creator: ${event.creator}`,
      `Contract: ${event.token}`,
      ...formatWhitelistSummary(event.whitelistSnapshot),
      `App: ${event.launchUrl}`,
      ...(event.explorerTokenUrl ? [`Explorer: ${event.explorerTokenUrl}`] : []),
      ...(event.metadata.website ? [`Website: ${event.metadata.website}`] : []),
      ...(event.metadata.twitter ? [`X: ${event.metadata.twitter}`] : []),
      ...(event.metadata.telegram ? [`Telegram: ${event.metadata.telegram}`] : []),
      ...(event.metadata.discord ? [`Discord: ${event.metadata.discord}`] : []),
      ...(event.metadata.image ? [`Media: ${event.metadata.image}`] : [])
    ].join("\n");
  }

  if (event.kind === "graduated") {
    return [
      "🎓 Graduation on Autonomous 314",
      "",
      `Chain: ${profile.chainLabel}`,
      `${event.name} ($${event.symbol})`,
      `${event.modeLabel} → ${profile.dexName}`,
      ...(event.marketCapUsd ? [`Market cap: ~$${compactNumber(event.marketCapUsd)}`] : []),
      `Creator: ${event.creator}`,
      `Contract: ${event.token}`,
      ...(event.pair && event.pair !== "0x0000000000000000000000000000000000000000" ? [`Pair: ${event.pair}`] : []),
      `App: ${event.launchUrl}`,
      ...(event.explorerTokenUrl ? [`Explorer: ${event.explorerTokenUrl}`] : []),
      ...(event.explorerTxUrl ? [`Tx: ${event.explorerTxUrl}`] : []),
      ...(event.metadata.website ? [`Website: ${event.metadata.website}`] : []),
      ...(event.metadata.twitter ? [`X: ${event.metadata.twitter}`] : []),
      ...(event.metadata.telegram ? [`Telegram: ${event.metadata.telegram}`] : []),
      ...(event.metadata.discord ? [`Discord: ${event.metadata.discord}`] : []),
      ...(event.metadata.image ? [`Media: ${event.metadata.image}`] : [])
    ].join("\n");
  }

  return [
    "📈 Market cap alert on Autonomous 314",
    "",
    `Chain: ${profile.chainLabel}`,
    `${event.name} ($${event.symbol}) crossed $${compactNumber(event.thresholdUsd)}.`,
    `Now: ~$${compactNumber(event.marketCapUsd)}`,
    `Creator: ${event.creator}`,
    `State: ${event.state}`,
    `Contract: ${event.token}`,
    `App: ${event.launchUrl}`,
    ...(event.explorerTokenUrl ? [`Explorer: ${event.explorerTokenUrl}`] : []),
    ...(event.metadata.website ? [`Website: ${event.metadata.website}`] : []),
    ...(event.metadata.twitter ? [`X: ${event.metadata.twitter}`] : []),
    ...(event.metadata.telegram ? [`Telegram: ${event.metadata.telegram}`] : []),
    ...(event.metadata.discord ? [`Discord: ${event.metadata.discord}`] : []),
    ...(event.metadata.image ? [`Media: ${event.metadata.image}`] : [])
  ].join("\n");
}

export function formatXNotificationForTest(event: NotificationEvent) {
  return formatXNotification(event);
}

export function formatTelegramNotificationForTest(event: NotificationEvent) {
  return formatTelegramNotification(event);
}

export function launchMarketCapUsdForTest(launch: LaunchWorkspaceSnapshot, nativeUsdPrice: number | null) {
  return launchMarketCapUsd(launch, nativeUsdPrice);
}

async function buildCreatedEvent(
  launch: LaunchWorkspaceSnapshot,
  metadata: LaunchMetadataSummary
): Promise<NotificationEvent> {
  const txHash = latestActivityTxHash(launch);
  const event = {
    ...baseEvent(launch, metadata, nowMs()),
    key: `created:${launch.token}`,
    kind: "created" as const,
    explorerTxUrl: txHash ? buildExplorerUrl("tx", txHash) : null,
    creationTxHash: txHash
  };
  return event;
}

async function buildGraduationEvent(
  launch: LaunchWorkspaceSnapshot,
  metadata: LaunchMetadataSummary,
  marketCapUsd: number | null
): Promise<NotificationEvent | null> {
  const graduation = latestGraduationActivity(launch);
  if (!graduation && launch.state !== "DEXOnly") return null;

  return {
    ...baseEvent(launch, metadata, graduation?.timestampMs ?? nowMs()),
    key: `graduation:${launch.token}:${graduation?.txHash ?? "state"}`,
    kind: "graduated",
    explorerTxUrl: graduation?.txHash ? buildExplorerUrl("tx", graduation.txHash) : null,
    graduationTxHash: graduation?.txHash ?? null,
    marketCapUsd,
    currentPriceNative: BigInt(launch.currentPriceQuotePerToken)
  };
}

async function buildMarketCapEvent(
  launch: LaunchWorkspaceSnapshot,
  metadata: LaunchMetadataSummary,
  thresholdUsd: number,
  marketCapUsd: number
): Promise<NotificationEvent> {
  return {
    ...baseEvent(launch, metadata, nowMs()),
    key: `market-cap:${launch.token}:${thresholdUsd}`,
    kind: "marketCap",
    thresholdUsd,
    marketCapUsd,
    currentPriceNative: BigInt(launch.currentPriceQuotePerToken)
  };
}

export async function detectEventsForTest(
  trackedLaunches: Map<string, LaunchBaseline>,
  launches: LaunchWorkspaceSnapshot[],
  nativeUsdPrice: number | null,
  metadataFor: (launch: LaunchWorkspaceSnapshot) => Promise<LaunchMetadataSummary> = async () => emptyMetadataSummary(),
  emitCreateForNew = true
) {
  return detectEvents(trackedLaunches, launches, nativeUsdPrice, metadataFor, emitCreateForNew);
}

async function detectEvents(
  trackedLaunches: Map<string, LaunchBaseline>,
  launches: LaunchWorkspaceSnapshot[],
  nativeUsdPrice: number | null,
  metadataFor: (launch: LaunchWorkspaceSnapshot) => Promise<LaunchMetadataSummary>,
  emitCreateForNew: boolean
) {
  const events: NotificationEvent[] = [];

  for (const launch of launches) {
    const key = launch.token.toLowerCase();
    const currentMarketCapUsd = launchMarketCapUsd(launch, nativeUsdPrice);
    const graduated = isLaunchGraduated(launch);
    const existing = trackedLaunches.get(key);

    if (!existing) {
      trackedLaunches.set(key, {
        graduated,
        marketCapUsd: currentMarketCapUsd,
        announcedThresholds: new Set(
          currentMarketCapUsd === null
            ? []
            : indexerConfig.socialNotifyMarketCapThresholdsUsd.filter((threshold) => currentMarketCapUsd >= threshold)
        )
      });

      if (emitCreateForNew) {
        events.push(await buildCreatedEvent(launch, await metadataFor(launch)));
      }
      continue;
    }

    if (!existing.graduated && graduated) {
      const event = await buildGraduationEvent(launch, await metadataFor(launch), currentMarketCapUsd);
      if (event) events.push(event);
    }

    if (existing.marketCapUsd !== null && currentMarketCapUsd !== null) {
      for (const threshold of indexerConfig.socialNotifyMarketCapThresholdsUsd) {
        if (existing.announcedThresholds.has(threshold)) continue;
        if (existing.marketCapUsd < threshold && currentMarketCapUsd >= threshold) {
          existing.announcedThresholds.add(threshold);
          events.push(await buildMarketCapEvent(launch, await metadataFor(launch), threshold, currentMarketCapUsd));
        }
      }
    } else if (currentMarketCapUsd !== null) {
      for (const threshold of indexerConfig.socialNotifyMarketCapThresholdsUsd) {
        if (currentMarketCapUsd >= threshold) {
          existing.announcedThresholds.add(threshold);
        }
      }
    }

    existing.graduated = graduated;
    existing.marketCapUsd = currentMarketCapUsd;
  }

  return events;
}

class NotificationWorker {
  private readonly trackedLaunches = new Map<string, LaunchBaseline>();
  private readonly pendingNotifications = new Map<string, PendingNotification>();
  private readonly metadataCache = new Map<string, { fetchedAtMs: number; value: LaunchMetadataSummary }>();
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private baselineInitialized = false;
  private lastRunStartedAtMs: number | null = null;
  private lastRunFinishedAtMs: number | null = null;
  private lastError: string | null = null;
  private priceCache: { value: number | null; fetchedAtMs: number } | null = null;

  start() {
    if (!indexerConfig.socialNotifyEnabled || this.timer) return;
    void this.runOnce();
    this.timer = setInterval(() => {
      void this.runOnce();
    }, indexerConfig.socialNotifyIntervalMs);
    this.timer.unref();
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  getSnapshot(): NotificationWorkerSnapshot {
    const recent = [...this.pendingNotifications.values()]
      .sort((a, b) => (b.deliveredAtMs ?? b.lastAttemptAtMs ?? b.createdAtMs) - (a.deliveredAtMs ?? a.lastAttemptAtMs ?? a.createdAtMs))
      .slice(0, 12)
      .map((entry) => ({
        key: entry.event.key,
        kind: entry.event.kind,
        token: entry.event.token,
        symbol: entry.event.symbol,
        attempts: entry.attempts,
        deliveredChannels: [...entry.deliveredChannels.values()],
        deliveredAtMs: entry.deliveredAtMs,
        lastError: entry.lastError
      }));

    return {
      enabled: indexerConfig.socialNotifyEnabled,
      intervalMs: indexerConfig.socialNotifyIntervalMs,
      xConfigured: isXChannelConfigured(),
      projectTelegramConfigured: isProjectTelegramConfigured(),
      alertTelegramConfigured: isAlertTelegramConfigured(),
      running: this.running,
      baselineInitialized: this.baselineInitialized,
      trackedLaunches: this.trackedLaunches.size,
      pendingNotifications: [...this.pendingNotifications.values()].filter((entry) => entry.deliveredAtMs === null).length,
      lastRunStartedAtMs: this.lastRunStartedAtMs,
      lastRunFinishedAtMs: this.lastRunFinishedAtMs,
      lastError: this.lastError,
      marketCapThresholdsUsd: indexerConfig.socialNotifyMarketCapThresholdsUsd,
      recent
    };
  }

  async runOnce() {
    if (!indexerConfig.socialNotifyEnabled || this.running) return;
    this.running = true;
    this.lastRunStartedAtMs = nowMs();
    this.lastError = null;

    try {
      const nativeUsdPrice = await this.fetchNativeUsdPrice();
      const snapshot = await buildIndexerSnapshot();

      if (!this.baselineInitialized) {
        await detectEvents(this.trackedLaunches, snapshot.launches, nativeUsdPrice, (launch) => this.metadataFor(launch), false);
        this.baselineInitialized = true;
        await this.processPendingNotifications();
        return;
      }

      for (const event of await detectEvents(this.trackedLaunches, snapshot.launches, nativeUsdPrice, (launch) => this.metadataFor(launch), true)) {
        if (!this.pendingNotifications.has(event.key)) {
          this.pendingNotifications.set(event.key, {
            event,
            deliveredChannels: new Set<NotificationChannel>(),
            attempts: 0,
            nextAttemptAtMs: nowMs(),
            lastError: null,
            createdAtMs: nowMs(),
            lastAttemptAtMs: null,
            deliveredAtMs: null
          });
        }
      }

      await this.processPendingNotifications();
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      console.error("[notifier] run failed", error);
    } finally {
      this.lastRunFinishedAtMs = nowMs();
      this.running = false;
    }
  }

  private async fetchNativeUsdPrice() {
    if (this.priceCache && nowMs() - this.priceCache.fetchedAtMs < PRICE_CACHE_TTL_MS) {
      return this.priceCache.value;
    }

    try {
      const response = await fetch(indexerConfig.nativeUsdPriceApiUrl);
      const body = await safeJson(response);
      const price =
        typeof body?.binancecoin?.usd === "number"
          ? body.binancecoin.usd
          : typeof body?.ethereum?.usd === "number"
            ? body.ethereum.usd
            : null;

      this.priceCache = {
        value: price,
        fetchedAtMs: nowMs()
      };
      return price;
    } catch {
      return this.priceCache?.value ?? null;
    }
  }

  private async metadataFor(launch: LaunchWorkspaceSnapshot) {
    const key = launch.token.toLowerCase();
    const cached = this.metadataCache.get(key);
    if (cached && nowMs() - cached.fetchedAtMs < METADATA_CACHE_TTL_MS) {
      return cached.value;
    }

    let value = emptyMetadataSummary();

    try {
      if (launch.metadataURI.startsWith("data:application/json")) {
        value = parseMetadataPayload(decodeDataUriJson(launch.metadataURI));
      } else if (/^https?:\/\//i.test(launch.metadataURI)) {
        const response = await fetch(launch.metadataURI);
        value = parseMetadataPayload(await safeJson(response));
      }
    } catch {
      value = emptyMetadataSummary();
    }

    this.metadataCache.set(key, {
      fetchedAtMs: nowMs(),
      value
    });
    return value;
  }

  private async processPendingNotifications() {
    const due = [...this.pendingNotifications.values()]
      .filter((entry) => entry.deliveredAtMs === null && entry.nextAttemptAtMs <= nowMs())
      .sort((a, b) => a.createdAtMs - b.createdAtMs)
      .slice(0, 12);

    for (const entry of due) {
      await this.processPendingNotification(entry);
    }
  }

  private async processPendingNotification(entry: PendingNotification) {
    const channels = channelsForEvent(entry.event);
    if (channels.length === 0) {
      entry.lastError = "No configured delivery channels for this event.";
      entry.nextAttemptAtMs = nowMs() + backoffMs(Math.max(entry.attempts, 1));
      return;
    }

    entry.attempts += 1;
    entry.lastAttemptAtMs = nowMs();
    entry.lastError = null;

    try {
      for (const channel of channels) {
        if (entry.deliveredChannels.has(channel)) continue;
        if (channel === "x") {
          await createXPost({
            clientId: indexerConfig.xClientId,
            clientSecret: indexerConfig.xClientSecret,
            accessToken: indexerConfig.xAccountAccessToken,
            refreshToken: indexerConfig.xAccountRefreshToken
          }, {
            text: formatXNotification(entry.event)
          });
        } else if (channel === "projectTelegram") {
          await sendTelegramMessage("project", formatTelegramNotification(entry.event));
        } else {
          await sendTelegramMessage("alert", formatTelegramNotification(entry.event));
        }
        entry.deliveredChannels.add(channel);
      }

      entry.deliveredAtMs = nowMs();
      entry.nextAttemptAtMs = Number.MAX_SAFE_INTEGER;
    } catch (error) {
      entry.lastError = error instanceof Error ? error.message : String(error);
      entry.nextAttemptAtMs = nowMs() + backoffMs(entry.attempts);
      console.error("[notifier] delivery failed", {
        key: entry.event.key,
        error: entry.lastError
      });
    }
  }
}

const notificationWorker = new NotificationWorker();

export function startNotificationWorker() {
  notificationWorker.start();
}

export function stopNotificationWorker() {
  notificationWorker.stop();
}

export function getNotificationWorkerSnapshot() {
  return notificationWorker.getSnapshot();
}
