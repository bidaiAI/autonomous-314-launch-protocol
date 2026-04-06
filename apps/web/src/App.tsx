import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { formatUnits, getAddress, parseEther } from "viem";
import { getLocale, onLocaleChange, t, ta, tf, toggleLocale, type Locale } from "./i18n";
import {
  applySlippageBps,
  buildInlineMetadataUri,
  buildLaunchMetadata,
  claimCreatorFees,
  claimWhitelistAllocation,
  claimWhitelistRefund,
  claimFactoryProtocolFees,
  claimTokenProtocolFees,
  connectWallet,
  createLaunch,
  downloadLaunchMetadata,
  executeBuy,
  executeSell,
  executeWhitelistCommit,
  fetchSegmentedChartSnapshot,
  fetchUnifiedActivity,
  formatNative,
  formatDateTime,
  formatToken,
  getWalletChainId,
  isWalletOnExpectedChain,
  previewBuy,
  previewSell,
  readFactory,
  readIndexedLaunchWorkspace,
  resolveLaunchMetadata,
  readRecentLaunchSnapshots,
  readToken,
  readWhitelistAccountState,
  switchWalletToExpectedChain,
  sweepAbandonedCreatorFees,
  uploadReferenceMetadata,
  verifyOfficialLaunch
} from "./protocol";
import type { ActivityFeedItem, CandlePoint, FactorySnapshot, LaunchMetadata, ProtocolVerification, TokenSnapshot } from "./types";
import type { LaunchCreationFamily } from "./types";
import { SegmentedPhaseChart } from "./charts";
import { activeProtocolProfile } from "./profiles";

const REPO_URL = "https://github.com/bidaiAI/autonomous-314-launch-protocol";
const BRAND_MARK_URL = "/brand/logo-mark.svg";
const BRAND_FULL_URL = "/brand/logo-full.svg";
const OFFICIAL_FACTORY_ADDRESS = (import.meta.env.VITE_FACTORY_ADDRESS ?? "").trim();
const DEX_SCREENER_CHAIN_ID = "bsc";
const TOKEN_DECIMALS = 10n ** 18n;
const TOTAL_SUPPLY_UNITS = 1_000_000_000n * TOKEN_DECIMALS;
const LP_TOKEN_RESERVE_UNITS = 200_000_000n * TOKEN_DECIMALS;
const SALE_TOKEN_RESERVE_UNITS = TOTAL_SUPPLY_UNITS - LP_TOKEN_RESERVE_UNITS;
const VIRTUAL_QUOTE_DIVISOR = 3n;
const BPS_DENOMINATOR = 10_000n;
const TOTAL_FEE_BPS = 100n;

function useLocale(): Locale {
  return useSyncExternalStore(onLocaleChange, getLocale, getLocale);
}

type BuyPreview = Awaited<ReturnType<typeof previewBuy>>;
type SellPreview = Awaited<ReturnType<typeof previewSell>>;
type AppRoute = { page: "home" } | { page: "create" } | { page: "launch"; token: string } | { page: "creator" };
type DexPairEnrichment = {
  url: string | null;
  priceUsd: number | null;
  marketCapUsd: number | null;
  fdvUsd: number | null;
  liquidityUsd: number | null;
  volume24hUsd: number | null;
  buys24h: number | null;
  sells24h: number | null;
};
type MarketSort = "recent" | "marketCap" | "progress" | "countdown";
type MarketLimit = "10" | "20" | "all";

function parseRoute(pathname: string): AppRoute {
  if (pathname === "/create") return { page: "create" };
  if (pathname === "/creator") return { page: "creator" };
  const launchMatch = pathname.match(/^\/launch\/(0x[a-fA-F0-9]{40})$/);
  if (launchMatch) return { page: "launch", token: launchMatch[1] };
  return { page: "home" };
}

function routeHref(route: AppRoute) {
  if (route.page === "create") return "/create";
  if (route.page === "creator") return "/creator";
  if (route.page === "launch") return `/launch/${route.token}`;
  return "/";
}

function explorerAddressUrl(address: string) {
  if (activeProtocolProfile.chainId === 56) {
    return `https://bscscan.com/address/${address}`;
  }
  if (activeProtocolProfile.chainId === 1) {
    return `https://etherscan.io/address/${address}`;
  }
  return "";
}

function shortAddress(value: string) {
  if (!value) return "—";
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

function formatPercentFromBps(value: bigint) {
  return `${(Number(value) / 100).toFixed(2)}%`;
}

function parsePercentToBps(value: string) {
  const numeric = Number.parseFloat(value || "0");
  if (!Number.isFinite(numeric) || numeric < 0) return 0;
  return Math.max(0, Math.min(5000, Math.round(numeric * 100)));
}

function formatPercentInput(value: string) {
  const numeric = Number.parseFloat(value || "0");
  if (!Number.isFinite(numeric) || numeric < 0) return "0";
  return `${numeric.toFixed(numeric >= 1 ? 2 : 3).replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1")}%`;
}

function quoteMarketCap(totalSupply: bigint, priceQuotePerToken: bigint) {
  if (totalSupply <= 0n || priceQuotePerToken <= 0n) return 0n;
  return (totalSupply * priceQuotePerToken) / 10n ** 18n;
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
      const digits = Math.abs(scaled) >= 100 ? 0 : Math.abs(scaled) >= 10 ? 1 : 2;
      return `${scaled.toFixed(digits).replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1")}${unit.suffix}`;
    }
  }
  return value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2).replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
}

function formatUsdCompact(value: number | null) {
  if (value === null || !Number.isFinite(value) || value <= 0) return "—";
  if (value < 1) {
    return `$${value.toFixed(value >= 0.01 ? 2 : value >= 0.0001 ? 4 : 6).replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1")}`;
  }
  return `$${compactNumber(value)}`;
}

function launchCardFallbackDescription(state: string) {
  if (state === "WhitelistCommit") return t("launchCardWhitelistFallback");
  if (state === "Bonding314") return t("launchCardBondingFallback");
  if (state === "Migrating") return t("launchCardMigratingFallback");
  if (state === "DEXOnly") return t("launchCardDexFallback");
  return t("launchCardDefaultFallback");
}

function formatUsdUnitPrice(value: number | null) {
  if (value === null || !Number.isFinite(value) || value <= 0) return "—";
  const maximumFractionDigits =
    value >= 100 ? 2 :
    value >= 1 ? 4 :
    value >= 0.01 ? 4 :
    value >= 0.0001 ? 6 : 8;
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits
  }).format(value);
}

function formatUsdMicroPrice(value: number | null) {
  if (value === null || !Number.isFinite(value) || value <= 0) return "—";
  if (value >= 0.01) return formatUsdUnitPrice(value);
  const raw = value.toFixed(12).replace(/0+$/, "");
  const [, decimals = ""] = raw.split(".");
  const leadingZeros = decimals.match(/^0*/)?.[0].length ?? 0;
  if (leadingZeros >= 4) {
    const significant = decimals.slice(leadingZeros, leadingZeros + 4) || "0";
    return `$0.0(${leadingZeros})${significant}`;
  }
  return formatUsdUnitPrice(value);
}

function formatTokenCompact(value: bigint, decimals = 18) {
  const numeric = Number(formatUnits(value, decimals));
  if (!Number.isFinite(numeric)) return "—";
  if (Math.abs(numeric) >= 10000) return compactNumber(numeric);
  return numeric.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

function formatUsdMicroPriceCompact(value: number | null) {
  if (value === null || !Number.isFinite(value) || value <= 0) return "—";
  if (value >= 0.01) return formatUsdUnitPrice(value);
  const raw = value.toFixed(12).replace(/0+$/, "");
  const [, decimals = ""] = raw.split(".");
  const leadingZeros = decimals.match(/^0*/)?.[0].length ?? 0;
  if (leadingZeros >= 4) {
    const significant = decimals.slice(leadingZeros, leadingZeros + 4) || "0";
    return `$0.0(${leadingZeros})${significant}`;
  }
  return formatUsdUnitPrice(value);
}

function formatCountdownLabel(targetMs: number, nowMs: number) {
  const diffMs = Math.max(0, targetMs - nowMs);
  const totalMinutes = Math.ceil(diffMs / 60000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function parseApiNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function formatNativeCompact(value: bigint) {
  const numeric = Number(value) / 1e18;
  if (!Number.isFinite(numeric) || numeric <= 0) return `0 ${activeProtocolProfile.nativeSymbol}`;
  return `${compactNumber(numeric)} ${activeProtocolProfile.nativeSymbol}`;
}

function ceilDiv(value: bigint, divisor: bigint) {
  return (value + divisor - 1n) / divisor;
}

function splitTotalFee(grossAmount: bigint) {
  return (grossAmount * TOTAL_FEE_BPS) / BPS_DENOMINATOR;
}

function estimateFreshLaunchTokenOut(grossQuoteIn: bigint, graduationQuoteReserve: bigint) {
  if (grossQuoteIn <= 0n || graduationQuoteReserve <= 0n) return 0n;

  const virtualQuoteReserve = graduationQuoteReserve / VIRTUAL_QUOTE_DIVISOR;
  if (virtualQuoteReserve <= 0n) return 0n;

  const virtualTokenReserve = (LP_TOKEN_RESERVE_UNITS * virtualQuoteReserve) / graduationQuoteReserve;
  const remainingCapacity = graduationQuoteReserve;

  let usedGross = grossQuoteIn;
  let netQuoteIn = grossQuoteIn - splitTotalFee(grossQuoteIn);

  if (netQuoteIn > remainingCapacity) {
    usedGross = ceilDiv(remainingCapacity * BPS_DENOMINATOR, BPS_DENOMINATOR - TOTAL_FEE_BPS);
    while (usedGross > 0n) {
      const feeCheck = splitTotalFee(usedGross);
      const netCheck = usedGross - feeCheck;
      if (netCheck <= remainingCapacity) {
        netQuoteIn = netCheck;
        break;
      }
      usedGross -= 1n;
    }
  }

  if (netQuoteIn <= 0n) return 0n;
  if (netQuoteIn === graduationQuoteReserve) return SALE_TOKEN_RESERVE_UNITS;

  const effectiveQuoteReserve = virtualQuoteReserve;
  const effectiveTokenReserve = SALE_TOKEN_RESERVE_UNITS + LP_TOKEN_RESERVE_UNITS + virtualTokenReserve;
  const invariant = effectiveQuoteReserve * effectiveTokenReserve;
  const newEffectiveQuoteReserve = effectiveQuoteReserve + netQuoteIn;
  const newEffectiveTokenReserve = invariant / newEffectiveQuoteReserve;

  return effectiveTokenReserve - newEffectiveTokenReserve;
}

function formatQuotePrice(value: bigint) {
  const numeric = Number(value) / 1e18;
  if (!Number.isFinite(numeric) || numeric <= 0) return `0 ${activeProtocolProfile.nativeSymbol}`;
  if (numeric >= 1) {
    return `${numeric.toLocaleString(undefined, { maximumFractionDigits: 4 })} ${activeProtocolProfile.nativeSymbol}`;
  }
  if (numeric >= 0.000001) {
    return `${numeric.toLocaleString(undefined, { maximumSignificantDigits: 6 })} ${activeProtocolProfile.nativeSymbol}`;
  }
  return `${numeric.toExponential(4)} ${activeProtocolProfile.nativeSymbol}`;
}

function activityTone(activity: ActivityFeedItem) {
  if (activity.kind === "graduated") return "system";
  if (activity.source === "dex") return "dex";
  return activity.side === "buy" ? "buy" : "sell";
}

function activityLabel(activity: ActivityFeedItem) {
  if (activity.kind === "graduated") return t("graduated");
  const side = activity.side === "buy" ? t("buyLabel") : t("sellLabel");
  return activity.source === "dex" ? `${side} · ${t("dexSuffix")}` : `${side} · ${t("protocolSuffix")}`;
}

function activityPhaseLabel(activity: ActivityFeedItem) {
  if (activity.phase === "bonding") return t("stateBonding");
  if (activity.phase === "migrating") return t("stateMigrating");
  return t("stateDexOnly");
}

function formatUnixTimestamp(timestamp: bigint) {
  if (timestamp === 0n) return "—";
  return formatDateTime(Number(timestamp) * 1000);
}

function splitAddressLines(value: string) {
  return value
    .split(/\r?\n|,/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function resolvePreviewImage(image: string) {
  if (!image) return "";
  if (image.startsWith("ipfs://")) {
    return `https://ipfs.io/ipfs/${image.replace("ipfs://", "")}`;
  }
  if (image.startsWith("ar://")) {
    return `https://arweave.net/${image.replace("ar://", "")}`;
  }
  if (image.startsWith("http://") || image.startsWith("https://") || image.startsWith("data:")) {
    return image;
  }
  return "";
}

function resolveExternalHref(value?: string) {
  if (!value) return "";
  if (value.startsWith("ipfs://")) {
    return `https://ipfs.io/ipfs/${value.replace("ipfs://", "")}`;
  }
  if (value.startsWith("ar://")) {
    return `https://arweave.net/${value.replace("ar://", "")}`;
  }
  if (value.startsWith("http://") || value.startsWith("https://")) {
    return value;
  }
  return "";
}

const HIDDEN_UNICODE_RE = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g;

function sanitizeUnicodeLabel(value: string, mode: "name" | "symbol" = "name") {
  let next = (value || "").normalize("NFC").replace(HIDDEN_UNICODE_RE, "");
  if (mode === "symbol") {
    next = next.replace(/\s+/g, "");
  } else {
    next = next.replace(/\s+/g, " ").trimStart();
  }
  return next;
}

function launchMetadataLinks(metadata: LaunchMetadata | null) {
  if (!metadata) return [];

  const links = [
    { label: t("website"), href: resolveExternalHref(metadata.website || metadata.external_url) },
    { label: "X", href: resolveExternalHref(metadata.twitter) },
    { label: t("telegram"), href: resolveExternalHref(metadata.telegram) },
    { label: t("discord"), href: resolveExternalHref(metadata.discord) }
  ];

  return links.filter((link) => Boolean(link.href));
}

function launchStateLabel(state: string) {
  if (state === "Created") return t("stateCreated");
  if (state === "WhitelistCommit") return t("stateWhitelist");
  if (state === "Bonding314") return t("stateBonding");
  if (state === "Migrating") return t("stateMigrating");
  if (state === "DEXOnly") return t("stateDexOnly");
  return state;
}

function effectiveLaunchState(
  state: string,
  whitelistStatus: bigint,
  whitelistSnapshot: TokenSnapshot["whitelistSnapshot"],
  nowMs: number
) {
  if (
    state === "WhitelistCommit" &&
    whitelistSnapshot &&
    whitelistStatus !== 3n &&
    nowMs >= Number(whitelistSnapshot.deadline) * 1000
  ) {
    return "Bonding314";
  }
  return state;
}

function launchModeLabel(mode: string) {
  if (mode === "Standard0314") return t("mode0314Title");
  if (mode === "WhitelistB314") return t("modeB314Title");
  if (mode === "WhitelistTaxF314") return t("modeF314Title");
  if (/^Taxed\d+314$/.test(mode)) return t("modeTaxTitle");
  return mode;
}

export function App() {
  const [route, setRoute] = useState<AppRoute>(() => parseRoute(window.location.pathname));
  const [wallet, setWallet] = useState<string>("");
  const [factoryAddress, setFactoryAddress] = useState(OFFICIAL_FACTORY_ADDRESS);
  const [factoryInputMode, setFactoryInputMode] = useState<"official" | "custom">(OFFICIAL_FACTORY_ADDRESS ? "official" : "custom");
  const [showFactorySettings, setShowFactorySettings] = useState(false);
  const [customFactoryInput, setCustomFactoryInput] = useState("");
  const [tokenAddress, setTokenAddress] = useState(import.meta.env.VITE_TOKEN_ADDRESS ?? "");
  const [createName, setCreateName] = useState("Autonomous 314");
  const [createSymbol, setCreateSymbol] = useState("A314");
  const [createMode, setCreateMode] = useState<LaunchCreationFamily>("standard");
  const [createDescription, setCreateDescription] = useState("");
  const [createImageUrl, setCreateImageUrl] = useState("");
  const [createImagePreview, setCreateImagePreview] = useState("");
  const [createImageFileName, setCreateImageFileName] = useState("");
  const [createWebsite, setCreateWebsite] = useState("");
  const [createTwitter, setCreateTwitter] = useState("");
  const [createTelegram, setCreateTelegram] = useState("");
  const [createDiscord, setCreateDiscord] = useState("");
  const [showSocialEditor, setShowSocialEditor] = useState(false);
  const [createFieldHelp, setCreateFieldHelp] = useState<null | string>(null);

  const toggleCreateFieldHelp = (key: string) => {
    setCreateFieldHelp((current) => (current === key ? null : key));
  };

  const renderFieldLabel = (label: string, helpKey?: string, optional = false) => (
    <span className="label-row">
      <span>
        {label}
        {optional ? <em className="field-badge optional">{t("optionalField")}</em> : <em className="field-required-mark">*</em>}
      </span>
      {helpKey ? (
        <button
          type="button"
          className={`field-help-toggle ${createFieldHelp === helpKey ? "active" : ""}`}
          onClick={() => toggleCreateFieldHelp(helpKey)}
          aria-label={t("toggleHelp")}
        >
          <span className="field-help-chevron" aria-hidden="true" />
        </button>
      ) : null}
    </span>
  );
  const renderFieldMethodLabel = (label: string, helpKey?: string) => (
    <span className="label-row">
      <span>{label}</span>
      {helpKey ? (
        <button
          type="button"
          className={`field-help-toggle ${createFieldHelp === helpKey ? "active" : ""}`}
          onClick={() => toggleCreateFieldHelp(helpKey)}
          aria-label={t("toggleHelp")}
        >
          <span className="field-help-chevron" aria-hidden="true" />
        </button>
      ) : null}
    </span>
  );
  const [createMetadataUri, setCreateMetadataUri] = useState("");
  const [createAtomicBuyEnabled, setCreateAtomicBuyEnabled] = useState(true);
  const [createAtomicBuyAmount, setCreateAtomicBuyAmount] = useState("1");
  const [createWhitelistThreshold, setCreateWhitelistThreshold] = useState("4");
  const [createWhitelistSlotSize, setCreateWhitelistSlotSize] = useState("0.2");
  const [createWhitelistScheduleEnabled, setCreateWhitelistScheduleEnabled] = useState(false);
  const [createWhitelistOpensAt, setCreateWhitelistOpensAt] = useState("");
  const [createWhitelistAddresses, setCreateWhitelistAddresses] = useState("");
  const [createTaxBps, setCreateTaxBps] = useState("1");
  const [createTaxBurnShareBps, setCreateTaxBurnShareBps] = useState("5000");
  const [createTaxTreasuryShareBps, setCreateTaxTreasuryShareBps] = useState("5000");
  const [createTaxTreasuryWallet, setCreateTaxTreasuryWallet] = useState(import.meta.env.VITE_DEFAULT_TREASURY ?? "");
  const [nativeUsdPrice, setNativeUsdPrice] = useState<number | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [factorySnapshot, setFactorySnapshot] = useState<FactorySnapshot | null>(null);
  const [recentLaunchSnapshots, setRecentLaunchSnapshots] = useState<TokenSnapshot[]>([]);
  const [tokenSnapshot, setTokenSnapshot] = useState<TokenSnapshot | null>(null);
  const [tokenVerification, setTokenVerification] = useState<ProtocolVerification | null>(null);
  const [dexPairEnrichment, setDexPairEnrichment] = useState<DexPairEnrichment | null>(null);
  const [launchMetadataByToken, setLaunchMetadataByToken] = useState<Partial<Record<string, LaunchMetadata | null>>>({});
  const [marketQuery, setMarketQuery] = useState("");
  const [marketSort, setMarketSort] = useState<MarketSort>("recent");
  const [marketLimit, setMarketLimit] = useState<MarketLimit>("20");
  const [contractSearchInput, setContractSearchInput] = useState("");
  const [recentActivity, setRecentActivity] = useState<ActivityFeedItem[]>([]);
  const [bondingCandles, setBondingCandles] = useState<CandlePoint[]>([]);
  const [dexCandles, setDexCandles] = useState<CandlePoint[]>([]);
  const [graduationTimestampMs, setGraduationTimestampMs] = useState<number | null>(null);
  const [launchInfoTab, setLaunchInfoTab] = useState<"activity" | "details">("activity");
  const [tradeSide, setTradeSide] = useState<"buy" | "sell">("buy");
  const [buyInput, setBuyInput] = useState("1");
  const [sellInput, setSellInput] = useState("1");
  const [slippagePercent, setSlippagePercent] = useState("3");
  const [buyPreviewState, setBuyPreviewState] = useState<BuyPreview | null>(null);
  const [sellPreviewState, setSellPreviewState] = useState<SellPreview | null>(null);
  const [status, setStatus] = useState<string>(() => t("ready"));
  const [showCreateConfirm, setShowCreateConfirm] = useState(false);
  const [copiedLaunchAddress, setCopiedLaunchAddress] = useState<string | null>(null);
  const configuredSocialCount = [createWebsite, createTwitter, createTelegram, createDiscord].filter((value) => value.trim()).length;

  async function handleCopyText(value: string, label: string) {
    try {
      await navigator.clipboard.writeText(value);
      setStatus(tf("statusCopiedAddress", { label }));
    } catch {
      setStatus(tf("statusCopyFailed", { label }));
    }
  }

  async function handleCopyLaunchAddress(address: string) {
    try {
      await navigator.clipboard.writeText(address);
      setCopiedLaunchAddress(address);
      setStatus(tf("statusCopiedAddress", { label: t("copyContract") }));
      window.setTimeout(() => {
        setCopiedLaunchAddress((current) => (current === address ? null : current));
      }, 1600);
    } catch {
      setStatus(tf("statusCopyFailed", { label: t("copyContract") }));
    }
  }
  const [loading, setLoading] = useState(false);
  const [walletChainId, setWalletChainId] = useState<number | null>(null);
  const [walletOnExpectedChain, setWalletOnExpectedChain] = useState(true);
  const [whitelistAccountState, setWhitelistAccountState] = useState<{
    approved: boolean;
    canCommit: boolean;
    canClaimAllocation: boolean;
    canClaimRefund: boolean;
  } | null>(null);
  const workspaceRequestRef = useRef(0);
  const buyPreviewRequestRef = useRef(0);
  const sellPreviewRequestRef = useRef(0);
  const marketBoardRef = useRef<HTMLElement | null>(null);

  const isBonding = tokenSnapshot?.state === "Bonding314";
  const isMigrating = tokenSnapshot?.state === "Migrating";
  const isDexOnly = tokenSnapshot?.state === "DEXOnly";
  const connectedAsCreator =
    wallet && tokenSnapshot ? wallet.toLowerCase() === tokenSnapshot.creator.toLowerCase() : false;
  const connectedAsProtocolRecipient =
    wallet && factorySnapshot ? wallet.toLowerCase() === factorySnapshot.protocolFeeRecipient.toLowerCase() : false;
  const connectedAsTokenProtocolRecipient =
    wallet && tokenSnapshot ? wallet.toLowerCase() === tokenSnapshot.protocolFeeRecipient.toLowerCase() : false;
  const creatorFeeSweepReady = tokenSnapshot?.creatorFeeSweepReady ?? false;
  const tokenOfficial = tokenVerification?.status === "official";
  const canWriteVerifiedLaunch = tokenVerification?.status === "official";
  const isWhitelistCommit = tokenSnapshot?.state === "WhitelistCommit";
  const isWhitelistMode = tokenSnapshot?.launchMode === "WhitelistB314";
  const whitelistSnapshot = tokenSnapshot?.whitelistSnapshot ?? null;
  const whitelistSeatCount = whitelistSnapshot?.seatCount ?? 0n;
  const whitelistSeatsFilled = whitelistSnapshot?.seatsFilled ?? 0n;
  const whitelistSeatsRemaining = whitelistSeatCount > whitelistSeatsFilled ? whitelistSeatCount - whitelistSeatsFilled : 0n;

  const pollutionTone = useMemo(() => {
    if (!tokenSnapshot) return "neutral";
    if (tokenSnapshot.pairClean) return "success";
    if (tokenSnapshot.pairGraduationCompatible) return "warn";
    return "danger";
  }, [tokenSnapshot]);
  const heroMarketCap = tokenSnapshot ? quoteMarketCap(tokenSnapshot.totalSupply, tokenSnapshot.currentPriceQuotePerToken) : 0n;
  const heroRaised = tokenSnapshot
    ? tokenSnapshot.graduationQuoteReserve > tokenSnapshot.remainingQuoteCapacity
      ? tokenSnapshot.graduationQuoteReserve - tokenSnapshot.remainingQuoteCapacity
      : 0n
    : 0n;
  const heroMarketCapUsd = heroMarketCap > 0n && nativeUsdPrice
    ? (Number(heroMarketCap) / 1e18) * nativeUsdPrice
    : null;
  const displayedMarketCapUsd = dexPairEnrichment?.marketCapUsd ?? heroMarketCapUsd;
  const bondingPriceUsd = tokenSnapshot && nativeUsdPrice
    ? (Number(tokenSnapshot.currentPriceQuotePerToken) / 1e18) * nativeUsdPrice
    : null;
  const displayedPriceUsd = dexPairEnrichment?.priceUsd ?? bondingPriceUsd;
  const verificationLabel = tokenVerification
    ? tokenVerification.status === "official"
      ? t("verifiedOfficial")
      : tokenVerification.status === "warning"
        ? t("verifiedSuspicious")
        : t("verifiedForeign")
    : "";

  const verificationTone = useMemo(() => {
    if (!tokenVerification) return "neutral";
    if (tokenVerification.status === "official") return "success";
    if (tokenVerification.status === "warning") return "warn";
    return "danger";
  }, [tokenVerification]);
  const defaultTotalSupply = 1_000_000_000n * 10n ** 18n;
  const trimmedMarketQuery = marketQuery.trim();
  const searchLooksLikeAddress = /^0x[a-fA-F0-9]{40}$/.test(trimmedMarketQuery);
  const filteredLaunchSnapshots = useMemo(() => {
    if (!trimmedMarketQuery) return recentLaunchSnapshots;
    const lower = trimmedMarketQuery.toLowerCase();
    return recentLaunchSnapshots.filter((launch) => {
      const metadata = launchMetadataByToken[launch.address.toLowerCase()] ?? null;
      return (
        launch.address.toLowerCase().includes(lower) ||
        launch.name.toLowerCase().includes(lower) ||
        launch.symbol.toLowerCase().includes(lower) ||
        launch.creator.toLowerCase().includes(lower) ||
        (metadata?.name ?? "").toLowerCase().includes(lower) ||
        (metadata?.symbol ?? "").toLowerCase().includes(lower) ||
        (metadata?.description ?? "").toLowerCase().includes(lower)
      );
    });
  }, [launchMetadataByToken, recentLaunchSnapshots, trimmedMarketQuery]);

  const sortedLaunchSnapshots = useMemo(() => {
    const launches = [...filteredLaunchSnapshots];
    const marketCapOf = (launch: TokenSnapshot) =>
      quoteMarketCap(launch.totalSupply > 0n ? launch.totalSupply : defaultTotalSupply, launch.currentPriceQuotePerToken);
    const countdownTargetMs = (launch: TokenSnapshot) => {
      if (launch.state !== "WhitelistCommit" || !launch.whitelistSnapshot) return Number.POSITIVE_INFINITY;
      const opensAt = Number(launch.whitelistSnapshot.opensAt) * 1000;
      const deadline = Number(launch.whitelistSnapshot.deadline) * 1000;
      return nowMs < opensAt ? opensAt : deadline;
    };

    launches.sort((a, b) => {
      if (marketSort === "marketCap") {
        const diff = marketCapOf(b) - marketCapOf(a);
        if (diff !== 0n) return diff > 0n ? 1 : -1;
      } else if (marketSort === "progress") {
        const diff = Number(b.graduationProgressBps - a.graduationProgressBps);
        if (diff !== 0) return diff;
      } else if (marketSort === "countdown") {
        const diff = countdownTargetMs(a) - countdownTargetMs(b);
        if (diff !== 0) return diff;
      }
      const createdDiff = Number(b.createdAt - a.createdAt);
      if (createdDiff !== 0) return createdDiff;
      return a.address.localeCompare(b.address);
    });

    return launches;
  }, [defaultTotalSupply, filteredLaunchSnapshots, marketSort, nowMs]);

  const visibleLaunchSnapshots = useMemo(() => {
    if (marketLimit === "all") return sortedLaunchSnapshots;
    return sortedLaunchSnapshots.slice(0, Number.parseInt(marketLimit, 10));
  }, [marketLimit, sortedLaunchSnapshots]);

  const creatorLaunches = useMemo(() => {
    if (!wallet) return [];
    return recentLaunchSnapshots.filter(
      (launch) => launch.creator.toLowerCase() === wallet.toLowerCase()
    );
  }, [recentLaunchSnapshots, wallet]);

  const displayedGraduationTarget =
    tokenSnapshot?.graduationQuoteReserve && tokenSnapshot.graduationQuoteReserve > 0n
      ? tokenSnapshot.graduationQuoteReserve
      : factorySnapshot?.graduationQuoteReserve ?? 0n;
  const runtimeChainLabel = activeProtocolProfile.chainLabel;
  const locale = useLocale();
  const walletWrongNetwork = Boolean(wallet) && walletChainId !== null && !walletOnExpectedChain;
  const usingUploadedImage = Boolean(createImagePreview && !createImageUrl.trim());
  const selectedLaunchMetadataState = tokenSnapshot ? launchMetadataByToken[tokenSnapshot.address.toLowerCase()] : undefined;
  const selectedLaunchMetadata = selectedLaunchMetadataState ?? null;
  const selectedLaunchMetadataLoading =
    Boolean(tokenSnapshot?.metadataURI) && selectedLaunchMetadataState === undefined;
  const selectedLaunchHasImage = Boolean(resolvePreviewImage(selectedLaunchMetadata?.image ?? ""));
  const whitelistApproved = whitelistAccountState?.approved ?? false;
  const canCommitWhitelist = whitelistAccountState?.canCommit ?? false;
  const canClaimWhitelistAllocationForWallet = whitelistAccountState?.canClaimAllocation ?? false;
  const canClaimWhitelistRefundForWallet = whitelistAccountState?.canClaimRefund ?? false;
  const parsedWhitelistAddresses = useMemo(() => {
    const unique = new Map<string, `0x${string}`>();
    for (const entry of splitAddressLines(createWhitelistAddresses)) {
      try {
        const normalized = getAddress(entry);
        unique.set(normalized.toLowerCase(), normalized);
      } catch {
        return null;
      }
    }
    return [...unique.values()];
  }, [createWhitelistAddresses]);
  const whitelistThresholdValue = useMemo(() => parseFloat(createWhitelistThreshold || "0"), [createWhitelistThreshold]);
  const whitelistSlotValue = useMemo(() => parseFloat(createWhitelistSlotSize || "0"), [createWhitelistSlotSize]);
  const isWhitelistFamily = createMode === "whitelist" || createMode === "whitelistTaxed";
  const isTaxedFamily = createMode === "taxed" || createMode === "whitelistTaxed";
  const taxRatePercent = Math.max(1, Math.min(9, Number.parseInt(createTaxBps || "1", 10) || 1));
  const burnSharePercent = Math.max(0, Math.min(100, Math.round((Number.parseInt(createTaxBurnShareBps || "0", 10) || 0) / 100)));
  const treasurySharePercent = Math.max(0, 100 - burnSharePercent);
  const whitelistSeatTarget =
    isWhitelistFamily && whitelistThresholdValue > 0 && whitelistSlotValue > 0
      ? Math.round(whitelistThresholdValue / whitelistSlotValue)
      : 0;
  const createWhitelistOpensAtUnix = useMemo(() => {
    if (!createWhitelistScheduleEnabled || !createWhitelistOpensAt.trim()) return 0n;
    const ms = new Date(createWhitelistOpensAt).getTime();
    if (!Number.isFinite(ms) || ms <= 0) return 0n;
    return BigInt(Math.floor(ms / 1000));
  }, [createWhitelistOpensAt, createWhitelistScheduleEnabled]);
  const isDelayedWhitelistOpen = createWhitelistOpensAtUnix > 0n;
  const whitelistLocalTimezone = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone || t('wlLocalTimeFallback'), [locale]);
  const whitelistOpensAtUtcText = useMemo(() => {
    if (!isDelayedWhitelistOpen) return '';
    return new Date(Number(createWhitelistOpensAtUnix) * 1000).toUTCString().replace('GMT', 'UTC');
  }, [createWhitelistOpensAtUnix, isDelayedWhitelistOpen]);
  const whitelistAddressCount = parsedWhitelistAddresses?.length ?? 0;
  const slippageToleranceBps = useMemo(() => parsePercentToBps(slippagePercent), [slippagePercent]);
  const requiresAtomicBuy = createMode === "standard" || createMode === "taxed";
  const requiresWhitelistCommit = createMode === "whitelist" || createMode === "whitelistTaxed";
  const whitelistAddressCountValid =
    !requiresWhitelistCommit || (parsedWhitelistAddresses !== null && whitelistAddressCount >= whitelistSeatTarget && whitelistSeatTarget > 0);
  const officialFactoryAddress = OFFICIAL_FACTORY_ADDRESS.toLowerCase();
  const usingOfficialFactory = Boolean(factoryAddress && officialFactoryAddress && factoryAddress.trim().toLowerCase() === officialFactoryAddress);
  const assumeOfficialFactoryCapabilities = Boolean(officialFactoryAddress && (usingOfficialFactory || factoryAddress.trim().length === 0));
  const factorySupportsWhitelistMode = factorySnapshot?.supportsWhitelistMode ?? assumeOfficialFactoryCapabilities;
  const factorySupportsTaxedMode = factorySnapshot?.supportsTaxedMode ?? assumeOfficialFactoryCapabilities;
  const factorySupportsWhitelistTaxedMode = factorySnapshot?.supportsWhitelistTaxedMode ?? assumeOfficialFactoryCapabilities;
  const customFactorySelected = Boolean(factoryAddress.trim()) && !usingOfficialFactory;
  const factoryPanelExpanded = showFactorySettings;
  const createAtomicBuyPreview = useMemo(() => {
    if (!requiresAtomicBuy || !createAtomicBuyEnabled) return null;
    const trimmed = createAtomicBuyAmount.trim();
    if (!trimmed) return 0n;
    try {
      const grossQuoteIn = parseEther(trimmed);
      const graduationTarget = factorySnapshot?.graduationQuoteReserve ?? parseEther("12");
      return estimateFreshLaunchTokenOut(grossQuoteIn, graduationTarget);
    } catch {
      return null;
    }
  }, [requiresAtomicBuy, createAtomicBuyEnabled, createAtomicBuyAmount, factorySnapshot?.graduationQuoteReserve]);
  const createAtomicBuyPreviewLabel = useMemo(() => (createAtomicBuyPreview === null ? "—" : formatTokenCompact(createAtomicBuyPreview)), [createAtomicBuyPreview]);
  const whitelistModeUnsupported = Boolean(customFactorySelected && factorySnapshot && !factorySupportsWhitelistMode);
  const taxedModeUnsupported = Boolean(customFactorySelected && factorySnapshot && !factorySupportsTaxedMode);
  const whitelistTaxedModeUnsupported = Boolean(customFactorySelected && factorySnapshot && !factorySupportsWhitelistTaxedMode);
  const selectedCreateFee =
    isWhitelistFamily
      ? factorySnapshot?.whitelistCreateFee ?? (usingOfficialFactory ? parseEther('0.03') : 0n)
      : factorySnapshot?.standardCreateFee ?? factorySnapshot?.createFee ?? (usingOfficialFactory ? parseEther('0.01') : 0n);
  const createTreasuryWalletResolved =
    isTaxedFamily
      ? treasurySharePercent === 0
        ? getAddress("0x0000000000000000000000000000000000000000")
        : (() => {
            try {
              return createTaxTreasuryWallet.trim() ? getAddress(createTaxTreasuryWallet.trim()) : "";
            } catch {
              return "";
            }
          })()
      : "";
  const launchFamilies = useMemo(
    () => [
      {
        suffix: "0314",
        title: t("mode0314Title"),
        status: "live" as const,
        eyebrow: t("mode0314Eyebrow"),
        description: t("mode0314Desc"),
        operations: ta("mode0314Points")
      },
      {
        suffix: "b314",
        title: t("modeB314Title"),
        status: "live" as const,
        eyebrow: t("modeB314Eyebrow"),
        description: t("modeB314Desc"),
        operations: ta("modeB314Points")
      },
      {
        suffix: "1314–9314",
        title: t("modeTaxTitle"),
        status: "live" as const,
        eyebrow: t("modeTaxEyebrow"),
        description: t("modeTaxDesc"),
        operations: ta("modeTaxPoints")
      },
      {
        suffix: "f314",
        title: t("modeF314Title"),
        status: "live" as const,
        eyebrow: t("modeF314Eyebrow"),
        description: t("modeF314Desc"),
        operations: ta("modeF314Points")
      }
    ],
    [factorySupportsTaxedMode, factorySupportsWhitelistMode, factorySupportsWhitelistTaxedMode, locale]
  );
  const selectedLaunchFamily = useMemo(() => {
    if (createMode === "whitelist") return launchFamilies[1];
    if (createMode === "taxed") {
      const suffix = `${Math.max(1, Math.min(9, Number.parseInt(createTaxBps || "1", 10)))}314`;
      return {
        ...launchFamilies[2],
        suffix,
        status: factorySupportsTaxedMode ? "live" : "planned"
      } as const;
    }
    if (createMode === "whitelistTaxed") {
      return {
        ...launchFamilies[3],
        status: factorySupportsWhitelistTaxedMode ? "live" : "planned"
      } as const;
    }
    return launchFamilies[0];
  }, [createMode, createTaxBps, factorySupportsTaxedMode, factorySupportsWhitelistTaxedMode]);
  const visibleLaunchFamilies = launchFamilies;
  const sanitizedCreateName = useMemo(() => sanitizeUnicodeLabel(createName, "name").trim(), [createName]);
  const sanitizedCreateSymbol = useMemo(() => sanitizeUnicodeLabel(createSymbol, "symbol").trim(), [createSymbol]);

  useEffect(() => {
    if (createMode === "whitelist" && whitelistModeUnsupported) {
      setCreateMode("standard");
    }
    if (createMode === "taxed" && taxedModeUnsupported) {
      setCreateMode("standard");
    }
    if (createMode === "whitelistTaxed" && whitelistTaxedModeUnsupported) {
      setCreateMode(whitelistModeUnsupported ? "standard" : "whitelist");
    }
  }, [createMode, whitelistModeUnsupported, taxedModeUnsupported, whitelistTaxedModeUnsupported]);

  useEffect(() => {
    if (!usingOfficialFactory && factoryAddress.trim()) {
      setCustomFactoryInput(factoryAddress.trim());
    }
  }, [factoryAddress, usingOfficialFactory]);

  useEffect(() => {
    if (route.page !== "create") return;
    setShowFactorySettings(false);
    if (OFFICIAL_FACTORY_ADDRESS) {
      setFactoryInputMode("official");
      setFactoryAddress(OFFICIAL_FACTORY_ADDRESS);
    }
  }, [route.page]);

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 30000);
    return () => window.clearInterval(timer);
  }, []);

  const launchMetadata = useMemo(
    () =>
      buildLaunchMetadata({
        name: sanitizedCreateName,
        symbol: sanitizedCreateSymbol,
        description: createDescription,
        image: createImageUrl.trim() || createImagePreview || undefined,
        website: createWebsite,
        twitter: createTwitter,
        telegram: createTelegram,
        discord: createDiscord
      }),
    [
      createDescription,
      createDiscord,
      createImagePreview,
      createImageUrl,
      sanitizedCreateName,
      sanitizedCreateSymbol,
      createTelegram,
      createTwitter,
      createWebsite
    ]
  );

  const generatedInlineMetadataUri = useMemo(() => {
    if (!launchMetadata.name || !launchMetadata.symbol || usingUploadedImage) {
      return "";
    }
    return buildInlineMetadataUri(launchMetadata);
  }, [launchMetadata, usingUploadedImage]);

  const resolvedCreateMetadataUri = createMetadataUri.trim() || generatedInlineMetadataUri;
  const metadataUriSizeBytes = useMemo(
    () => (resolvedCreateMetadataUri ? new TextEncoder().encode(resolvedCreateMetadataUri).length : 0),
    [resolvedCreateMetadataUri]
  );
  const hasRequiredCreateIdentity = Boolean(sanitizedCreateName && sanitizedCreateSymbol && launchMetadata.image);
  const canReviewCreate =
    Boolean(wallet) &&
    !walletWrongNetwork &&
    hasRequiredCreateIdentity &&
    (!isTaxedFamily || treasurySharePercent === 0 || Boolean(createTreasuryWalletResolved)) &&
    (!requiresWhitelistCommit || whitelistAddressCountValid);

  function navigate(nextRoute: AppRoute, replace = false) {
    const href = routeHref(nextRoute);
    if (replace) {
      window.history.replaceState(null, "", href);
    } else {
      window.history.pushState(null, "", href);
    }
    setRoute(nextRoute);
  }

  useEffect(() => {
    const onPopState = () => setRoute(parseRoute(window.location.pathname));
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=binancecoin&vs_currencies=usd");
        if (!response.ok) return;
        const json = (await response.json()) as { binancecoin?: { usd?: number } };
        const price = json.binancecoin?.usd;
        if (!cancelled && typeof price === "number" && Number.isFinite(price) && price > 0) {
          setNativeUsdPrice(price);
        }
      } catch {
        if (!cancelled) setNativeUsdPrice(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!factoryAddress) return;
    void (async () => {
      try {
        const { factory, launches } = await readRecentLaunchSnapshots(factoryAddress);
        setFactorySnapshot(factory);
        setRecentLaunchSnapshots(launches);
      } catch {
        // ignore initial bootstrap failure
      }
    })();
  }, [factoryAddress]);

  useEffect(() => {
    if (!searchLooksLikeAddress && route.page === "home") {
      setTokenVerification(null);
    }
  }, [route.page, searchLooksLikeAddress]);

  useEffect(() => {
    if (route.page !== "launch") {
      setTokenVerification(null);
      return;
    }
    const normalized = route.token;
    setTokenAddress(normalized);
    void loadLaunchWorkspace(normalized).then(
      () => setStatus(tf("statusTokenLoadedAddress", { address: normalized })),
      () => setStatus(t("statusTokenLoadFailed"))
    );
  }, [route.page, route.page === "launch" ? route.token : null]);

  useEffect(() => {
    const launchesToResolve = recentLaunchSnapshots.filter((launch) => {
      const key = launch.address.toLowerCase();
      return Boolean(launch.metadataURI) && launchMetadataByToken[key] === undefined;
    });

    if (launchesToResolve.length === 0) return;

    let cancelled = false;

    void Promise.all(
      launchesToResolve.map(async (launch) => [
        launch.address.toLowerCase(),
        await resolveLaunchMetadata(launch.metadataURI)
      ] as const)
    ).then((resolved) => {
      if (cancelled) return;
      setLaunchMetadataByToken((previous) => {
        const next = { ...previous };
        for (const [token, metadata] of resolved) {
          next[token] = metadata;
        }
        return next;
      });
    });

    return () => {
      cancelled = true;
    };
  }, [recentLaunchSnapshots, launchMetadataByToken]);

  useEffect(() => {
    if (!tokenSnapshot?.metadataURI) return;
    const key = tokenSnapshot.address.toLowerCase();
    if (launchMetadataByToken[key] !== undefined) return;

    let cancelled = false;
    void resolveLaunchMetadata(tokenSnapshot.metadataURI).then((metadata) => {
      if (cancelled) return;
      setLaunchMetadataByToken((previous) => ({ ...previous, [key]: metadata }));
    });

    return () => {
      cancelled = true;
    };
  }, [tokenSnapshot, launchMetadataByToken]);

  useEffect(() => {
    if (!tokenSnapshot || !wallet) {
      setWhitelistAccountState(null);
      return;
    }

    let cancelled = false;
    void readWhitelistAccountState(tokenSnapshot.address, wallet)
      .then((state) => {
        if (!cancelled) setWhitelistAccountState(state);
      })
      .catch(() => {
        if (!cancelled) setWhitelistAccountState(null);
      });

    return () => {
      cancelled = true;
    };
  }, [tokenSnapshot, wallet]);

  useEffect(() => {
    if (!tokenSnapshot?.pair || tokenSnapshot.pair === "0x0000000000000000000000000000000000000000" || tokenSnapshot.state !== "DEXOnly") {
      setDexPairEnrichment(null);
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(`https://api.dexscreener.com/latest/dex/pairs/${DEX_SCREENER_CHAIN_ID}/${tokenSnapshot.pair}`);
        if (!response.ok) throw new Error(`Dex pair lookup failed with ${response.status}`);
        const json = (await response.json()) as {
          pairs?: Array<{
            url?: string;
            priceUsd?: string;
            marketCap?: number | string;
            fdv?: number | string;
            liquidity?: { usd?: number | string };
            volume?: { h24?: number | string };
            txns?: { h24?: { buys?: number; sells?: number } };
          }>;
        };
        const pair = json.pairs?.[0];
        if (cancelled) return;
        setDexPairEnrichment(
          pair
            ? {
                url: typeof pair.url === "string" ? pair.url : null,
                priceUsd: parseApiNumber(pair.priceUsd),
                marketCapUsd: parseApiNumber(pair.marketCap),
                fdvUsd: parseApiNumber(pair.fdv),
                liquidityUsd: parseApiNumber(pair.liquidity?.usd),
                volume24hUsd: parseApiNumber(pair.volume?.h24),
                buys24h: typeof pair.txns?.h24?.buys === "number" ? pair.txns.h24.buys : null,
                sells24h: typeof pair.txns?.h24?.sells === "number" ? pair.txns.h24.sells : null
              }
            : null
        );
      } catch {
        if (!cancelled) setDexPairEnrichment(null);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [tokenSnapshot?.pair, tokenSnapshot?.state]);

  async function refreshWalletNetworkStatus() {
    const chainId = await getWalletChainId();
    const onExpectedChain = chainId === null ? true : await isWalletOnExpectedChain();
    setWalletChainId(chainId);
    setWalletOnExpectedChain(onExpectedChain);
    return { chainId, onExpectedChain };
  }

  async function loadLaunchWorkspace(address: string, preferIndexed = true) {
    const requestId = ++workspaceRequestRef.current;
    const [snapshot, indexed, verification] = await Promise.all([
      readToken(address),
      preferIndexed ? readIndexedLaunchWorkspace(address) : Promise.resolve(null),
      factoryAddress
        ? verifyOfficialLaunch(factoryAddress, address).catch(
            (): ProtocolVerification => ({
              status: "error",
              summary: t("verificationUnavailable"),
              checks: {
                factoryMatches: false,
                factoryRegistryRecognizesToken: false,
                tokenModeMatchesFactory: false,
                launchEventFound: false,
                eventMetadataMatchesToken: false,
                protocolRecipientMatches: false,
                routerMatches: false,
                graduationTargetMatches: false,
                pairMatchesDex: false,
                suffixMatchesMode: false
              }
            })
          )
        : Promise.resolve(null)
    ]);
    let activity = indexed?.recentActivity ?? [];
    let chart = indexed?.segmentedChart ?? null;
    const needsLiveActivityFallback =
      activity.length === 0 && (snapshot.state === "Bonding314" || snapshot.state === "DEXOnly" || snapshot.state === "Migrating");
    const needsLiveChartFallback =
      !chart ||
      ((chart.bondingCandles.length === 0 && chart.dexCandles.length === 0) &&
        (snapshot.state === "Bonding314" || snapshot.state === "DEXOnly" || snapshot.state === "Migrating"));

    if (!indexed || needsLiveActivityFallback || needsLiveChartFallback) {
      const [liveActivity, liveChart] = await Promise.all([
        needsLiveActivityFallback || !indexed ? fetchUnifiedActivity(address) : Promise.resolve(activity),
        needsLiveChartFallback || !indexed ? fetchSegmentedChartSnapshot(address) : Promise.resolve(chart!)
      ]);
      activity = liveActivity;
      chart = liveChart;
    }

    if (requestId !== workspaceRequestRef.current) {
      return snapshot;
    }

    setTokenSnapshot(snapshot);
    setTokenVerification(verification);
    setRecentActivity(activity);
    setBondingCandles(chart?.bondingCandles ?? []);
    setDexCandles(chart?.dexCandles ?? []);
    setGraduationTimestampMs(chart?.graduationTimestampMs ?? null);

    return snapshot;
  }

  async function handleConnectWallet() {
    try {
      const { account, chainId, chainMatches } = await connectWallet();
      setWallet(account);
      setWalletChainId(chainId);
      setWalletOnExpectedChain(chainMatches);
      setStatus(
        chainMatches
          ? tf("statusConnected", { account })
          : tf("statusConnectedWrongNetwork", { account, chain: runtimeChainLabel })
      );
    } catch (error) {
      setStatus(error instanceof Error ? error.message : t("statusWalletConnectionFailed"));
    }
  }

  async function handleSwitchNetwork() {
    try {
      setLoading(true);
      await switchWalletToExpectedChain();
      await refreshWalletNetworkStatus();
      setStatus(tf("statusWalletSwitched", { chain: runtimeChainLabel }));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : t("statusNetworkSwitchFailed"));
    } finally {
      setLoading(false);
    }
  }

  async function handleLoadFactory() {
    try {
      setLoading(true);
      const targetFactoryAddress = factoryInputMode === "official" ? OFFICIAL_FACTORY_ADDRESS : customFactoryInput.trim();
      if (!targetFactoryAddress) {
        throw new Error(t("statusFactoryLoadFailed"));
      }
      setFactoryAddress(targetFactoryAddress);
      const { factory, launches } = await readRecentLaunchSnapshots(targetFactoryAddress);
      setFactorySnapshot(factory);
      setRecentLaunchSnapshots(launches);
      setStatus(t("statusFactoryLoaded"));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : t("statusFactoryLoadFailed"));
    } finally {
      setLoading(false);
    }
  }

  async function handleLoadToken() {
    try {
      setLoading(true);
      navigate({ page: "launch", token: tokenAddress });
      setStatus(t("statusTokenLoaded"));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : t("statusTokenLoadFailed"));
    } finally {
      setLoading(false);
    }
  }

  async function handleSelectLaunch(address: string) {
    setTokenAddress(address);
    navigate({ page: "launch", token: address });
    try {
      setStatus(tf("statusTokenLoadedAddress", { address }));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : t("statusTokenLoadFailed"));
    }
  }

  async function handleInspectAndLoadSearchToken() {
    if (!searchLooksLikeAddress) {
      setStatus(t("statusEnterValidToken"));
      return;
    }

    try {
      setLoading(true);
      const verification = await verifyOfficialLaunch(factoryAddress, trimmedMarketQuery);
      if (verification.status === "foreign" || verification.status === "error") {
        setTokenVerification(verification);
        setStatus(verification.summary);
        return;
      }

      await handleSelectLaunch(trimmedMarketQuery);
      setStatus(
        verification.status === "official"
          ? verification.summary
          : tf("statusReadOnlyLoaded", { summary: verification.summary })
      );
    } catch (error) {
      setStatus(error instanceof Error ? error.message : t("statusVerifyFailed"));
    } finally {
      setLoading(false);
    }
  }

  async function handleQuickBuyLaunch(address: string) {
    await handleSelectLaunch(address);
    window.requestAnimationFrame(() => {
      document.getElementById("trade-panel")?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  useEffect(() => {
    if (!tokenAddress || !isBonding) {
      setBuyPreviewState(null);
      return;
    }
    const trimmed = buyInput.trim();
    if (!trimmed || Number(trimmed) <= 0) {
      setBuyPreviewState(null);
      return;
    }
    const requestId = ++buyPreviewRequestRef.current;
    const timer = window.setTimeout(async () => {
      try {
        const preview = await previewBuy(tokenAddress, trimmed);
        if (buyPreviewRequestRef.current === requestId) setBuyPreviewState(preview);
      } catch {
        if (buyPreviewRequestRef.current === requestId) setBuyPreviewState(null);
      }
    }, 220);
    return () => window.clearTimeout(timer);
  }, [buyInput, isBonding, tokenAddress]);

  useEffect(() => {
    if (!tokenAddress || !isBonding) {
      setSellPreviewState(null);
      return;
    }
    const trimmed = sellInput.trim();
    if (!trimmed || Number(trimmed) <= 0) {
      setSellPreviewState(null);
      return;
    }
    const requestId = ++sellPreviewRequestRef.current;
    const timer = window.setTimeout(async () => {
      try {
        const preview = await previewSell(tokenAddress, trimmed);
        if (sellPreviewRequestRef.current === requestId) setSellPreviewState(preview);
      } catch {
        if (sellPreviewRequestRef.current === requestId) setSellPreviewState(null);
      }
    }, 220);
    return () => window.clearTimeout(timer);
  }, [sellInput, isBonding, tokenAddress]);

  async function handlePreviewBuy() {
    try {
      setLoading(true);
      setBuyPreviewState(await previewBuy(tokenAddress, buyInput));
      setStatus(t("statusBuyPreviewUpdated"));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : t("statusBuyPreviewFailed"));
    } finally {
      setLoading(false);
    }
  }

  async function handlePreviewSell() {
    try {
      setLoading(true);
      setSellPreviewState(await previewSell(tokenAddress, sellInput));
      setStatus(t("statusSellPreviewUpdated"));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : t("statusSellPreviewFailed"));
    } finally {
      setLoading(false);
    }
  }

  async function handleMetadataImageUpload(file: File | null) {
    if (!file) {
      setCreateImagePreview("");
      setCreateImageFileName("");
      return;
    }

    const reader = new FileReader();
    const result = await new Promise<string>((resolve, reject) => {
      reader.onerror = () => reject(new Error(t("statusImagePreviewFailed")));
      reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
      reader.readAsDataURL(file);
    });

    setCreateImagePreview(result);
    setCreateImageFileName(file.name);
  }

  function handleUseGeneratedMetadataUri() {
    if (!generatedInlineMetadataUri) {
      setStatus(
        usingUploadedImage
          ? t("statusInlineDisabledWithUpload")
          : t("statusInlineUnavailable")
      );
      return;
    }

    setCreateMetadataUri(generatedInlineMetadataUri);
    setStatus(t("statusInlineCopied"));
  }

  function handleDownloadMetadata() {
    downloadLaunchMetadata(
      launchMetadata,
      `${(createSymbol || createName || "launch").trim().toLowerCase().replace(/[^a-z0-9-_]+/g, "-") || "launch"}-metadata.json`
    );
    setStatus(t("statusMetadataDownloaded"));
  }

  async function handleUploadReferenceMetadata() {
    try {
      setLoading(true);
      const metadataUrl = await uploadReferenceMetadata(launchMetadata);
      setCreateMetadataUri(metadataUrl);
      setStatus(t("statusMetadataUploaded"));
    } catch (error) {
      const message = error instanceof Error ? error.message : t("statusMetadataUploadFailed");
      setStatus(message === "Reference metadata service is not configured." ? t("statusMetadataUploadUnavailable") : message);
    } finally {
      setLoading(false);
    }
  }

  function handleOpenCreateConfirm() {
    if (!wallet) {
      setStatus(t("statusConnectWalletBeforeCreate"));
      void handleConnectWallet();
      return;
    }
    if (!sanitizedCreateName || !sanitizedCreateSymbol) {
      setStatus(t("errorTokenIdentityRequired"));
      return;
    }
    if (!launchMetadata.image) {
      setStatus(t("errorTokenImageRequired"));
      return;
    }
    if (isTaxedFamily && treasurySharePercent > 0 && !createTreasuryWalletResolved) {
      setStatus(t("errorTreasuryRequired"));
      return;
    }
    if (requiresAtomicBuy && createAtomicBuyEnabled) {
      try {
        if (parseEther(createAtomicBuyAmount || "0") <= 0n) {
          setStatus(t("errorAtomicBuyPositive"));
          return;
        }
      } catch {
        setStatus(t("errorAtomicBuyPositive"));
        return;
      }
    }
    setShowCreateConfirm(true);
  }

  async function handleConfirmCreateLaunch() {
    setShowCreateConfirm(false);
    await handleCreateLaunch();
  }

  async function reloadLoadedViews() {
    if (factoryAddress) {
      try {
        const { factory, launches } = await readRecentLaunchSnapshots(factoryAddress);
        setFactorySnapshot(factory);
        setRecentLaunchSnapshots(launches);
      } catch {
        // noop for background refresh
      }
    }

    if (tokenAddress) {
      try {
        await loadLaunchWorkspace(tokenAddress);
      } catch {
        // noop for background refresh
      }
    }
  }

  async function handleCreateLaunch() {
    try {
      setLoading(true);
      const snapshot = await readFactory(factoryAddress);
      setFactorySnapshot(snapshot);
      const modeFee = requiresWhitelistCommit ? snapshot.whitelistCreateFee : snapshot.standardCreateFee;
      const sanitizedName = sanitizeUnicodeLabel(createName, "name").trim();
      const sanitizedSymbol = sanitizeUnicodeLabel(createSymbol, "symbol").trim();
      const finalMetadataUri = createMetadataUri.trim() || generatedInlineMetadataUri;
      if (!sanitizedName || !sanitizedSymbol) {
        throw new Error(t("errorTokenIdentityRequired"));
      }
      if (!launchMetadata.image) {
        throw new Error(t("errorTokenImageRequired"));
      }
      if (!finalMetadataUri) {
        throw new Error(
          usingUploadedImage
            ? t("statusExternalMetadataRequiredUpload")
            : t("statusMetadataUriRequired")
        );
      }
      const whitelistThreshold = requiresWhitelistCommit ? parseEther(createWhitelistThreshold) : undefined;
      const whitelistSlotSize = requiresWhitelistCommit ? parseEther(createWhitelistSlotSize) : undefined;
      const whitelistOpensAt = requiresWhitelistCommit ? createWhitelistOpensAtUnix : undefined;
      const atomicBuyAmount = requiresAtomicBuy && createAtomicBuyEnabled ? parseEther(createAtomicBuyAmount || "0") : 0n;
      const taxBps = isTaxedFamily ? Number.parseInt(createTaxBps || "1", 10) * 100 : undefined;
      const burnShareBps = isTaxedFamily ? Number.parseInt(createTaxBurnShareBps || "0", 10) : undefined;
      const treasuryShareBps = isTaxedFamily ? Number.parseInt(createTaxTreasuryShareBps || "0", 10) : undefined;
      const treasuryWallet =
        isTaxedFamily
          ? treasuryShareBps === 0
            ? getAddress("0x0000000000000000000000000000000000000000")
            : createTaxTreasuryWallet.trim()
              ? getAddress(createTaxTreasuryWallet.trim())
              : undefined
          : undefined;

      if (requiresWhitelistCommit) {
        if (!parsedWhitelistAddresses || whitelistAddressCount < whitelistSeatTarget) {
          throw new Error(t("errorWhitelistCoverage"));
        }
        if (!isDelayedWhitelistOpen && !parsedWhitelistAddresses.some((entry) => entry.toLowerCase() === wallet.toLowerCase())) {
          throw new Error(t("errorWhitelistMustIncludeWallet"));
        }
      }

      if (isTaxedFamily) {
        if (burnShareBps === undefined || treasuryShareBps === undefined || taxBps === undefined) {
          throw new Error(t("errorTaxConfigIncomplete"));
        }
        if (burnShareBps + treasuryShareBps !== 10_000) {
          throw new Error(t("errorTaxSplitInvalid"));
        }
        if (treasuryShareBps > 0 && !treasuryWallet) {
          throw new Error(t("errorTreasuryRequired"));
        }
      }

      if (requiresAtomicBuy && createAtomicBuyEnabled && atomicBuyAmount <= 0n) {
        throw new Error(t("errorAtomicBuyPositive"));
      }
      const expectedSuffix =
        createMode === "whitelist"
          ? "b314"
          : createMode === "whitelistTaxed"
            ? "f314"
            : createMode === "taxed"
              ? `${Math.max(1, Math.min(9, Number.parseInt(createTaxBps || "1", 10)))}314`
              : "0314";
      setStatus(tf("statusMiningVanity", { suffix: expectedSuffix }));

      const { receipt, createdToken, vanity } = await createLaunch(factoryAddress, {
        family: createMode,
        name: createName,
        symbol: createSymbol,
        metadataURI: finalMetadataUri,
        createFee: modeFee,
        atomicQuoteIn: atomicBuyAmount,
        minTokenOut: 0n,
        whitelistThreshold,
        whitelistSlotSize,
        whitelistOpensAt,
        whitelistAddresses: parsedWhitelistAddresses ?? undefined,
        taxBps,
        burnShareBps,
        treasuryShareBps,
        treasuryWallet,
        onVanityProgress: ({ attempts, elapsedMs }) => {
          setStatus(
            tf("statusMiningVanityProgress", {
              suffix: expectedSuffix,
              attempts: attempts.toLocaleString(),
              seconds: (elapsedMs / 1000).toFixed(1)
            })
          );
        }
      });

      if (createdToken) {
        setTokenAddress(createdToken);
        navigate({ page: "launch", token: createdToken });
        setStatus(
          tf("statusCreateConfirmed", {
            token: createdToken,
            suffix: expectedSuffix,
            attempts: vanity.attempts.toLocaleString(),
            seconds: (vanity.elapsedMs / 1000).toFixed(1)
          })
        );
      } else {
        setStatus(
          tf("statusCreateConfirmedPredicted", {
            tx: receipt.transactionHash,
            predicted: vanity.predictedAddress
          })
        );
      }

      const { factory, launches } = await readRecentLaunchSnapshots(factoryAddress);
      setFactorySnapshot(factory);
      setRecentLaunchSnapshots(launches);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : t("statusCreateFailed"));
    } finally {
      setLoading(false);
    }
  }

  async function handleWhitelistCommit() {
    if (!tokenSnapshot?.whitelistSnapshot) return;
    try {
      setLoading(true);
      const receipt = await executeWhitelistCommit(tokenAddress, tokenSnapshot.whitelistSnapshot.slotSize);
      setStatus(tf("statusWhitelistSeatCommitted", { tx: receipt.transactionHash }));
      await loadLaunchWorkspace(tokenAddress, false);
      setTokenSnapshot(await readToken(tokenAddress));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : t("statusWhitelistCommitFailed"));
    } finally {
      setLoading(false);
    }
  }

  async function handleClaimWhitelistAllocation() {
    try {
      setLoading(true);
      const receipt = await claimWhitelistAllocation(tokenAddress);
      setStatus(tf("statusWhitelistAllocationClaimed", { tx: receipt.transactionHash }));
      await loadLaunchWorkspace(tokenAddress, false);
      setTokenSnapshot(await readToken(tokenAddress));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : t("statusWhitelistAllocationClaimFailed"));
    } finally {
      setLoading(false);
    }
  }

  async function handleClaimWhitelistRefund() {
    try {
      setLoading(true);
      const receipt = await claimWhitelistRefund(tokenAddress);
      setStatus(tf("statusWhitelistRefundClaimed", { tx: receipt.transactionHash }));
      await loadLaunchWorkspace(tokenAddress, false);
      setTokenSnapshot(await readToken(tokenAddress));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : t("statusWhitelistRefundClaimFailed"));
    } finally {
      setLoading(false);
    }
  }

  async function handleExecuteBuy() {
    try {
      setLoading(true);
      const preview = await previewBuy(tokenAddress, buyInput);
      setBuyPreviewState(preview);

      const minTokenOut = applySlippageBps(preview.tokenOut, slippageToleranceBps);
      const receipt = await executeBuy(tokenAddress, buyInput, minTokenOut);

      setStatus(tf("statusBuyConfirmed", { tx: receipt.transactionHash }));
      await loadLaunchWorkspace(tokenAddress, false);
      setTokenSnapshot(await readToken(tokenAddress));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : t("statusBuyFailed"));
    } finally {
      setLoading(false);
    }
  }

  async function handleExecuteSell() {
    try {
      setLoading(true);
      const preview = await previewSell(tokenAddress, sellInput);
      setSellPreviewState(preview);

      const minQuoteOut = applySlippageBps(preview.netQuoteOut, slippageToleranceBps);
      const receipt = await executeSell(tokenAddress, sellInput, minQuoteOut);

      setStatus(tf("statusSellConfirmed", { tx: receipt.transactionHash }));
      await loadLaunchWorkspace(tokenAddress, false);
      setTokenSnapshot(await readToken(tokenAddress));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : t("statusSellFailed"));
    } finally {
      setLoading(false);
    }
  }

  async function handleClaimFactoryFees() {
    try {
      setLoading(true);
      const receipt = await claimFactoryProtocolFees(factoryAddress);
      setStatus(tf("statusFactoryFeeClaimConfirmed", { tx: receipt.transactionHash }));
      await reloadLoadedViews();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : t("statusFactoryFeeClaimFailed"));
    } finally {
      setLoading(false);
    }
  }

  async function handleClaimTokenProtocolFees() {
    try {
      setLoading(true);
      const receipt = await claimTokenProtocolFees(tokenAddress);
      setStatus(tf("statusProtocolTokenFeeClaimConfirmed", { tx: receipt.transactionHash }));
      await loadLaunchWorkspace(tokenAddress, false);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : t("statusProtocolTokenFeeClaimFailed"));
    } finally {
      setLoading(false);
    }
  }

  async function handleClaimCreatorFees() {
    try {
      setLoading(true);
      const receipt = await claimCreatorFees(tokenAddress);
      setStatus(tf("statusCreatorFeeClaimConfirmed", { tx: receipt.transactionHash }));
      await loadLaunchWorkspace(tokenAddress, false);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : t("statusCreatorFeeClaimFailed"));
    } finally {
      setLoading(false);
    }
  }

  async function handleSweepCreatorFees() {
    try {
      setLoading(true);
      const receipt = await sweepAbandonedCreatorFees(tokenAddress);
      setStatus(tf("statusCreatorFeeSweepConfirmed", { tx: receipt.transactionHash }));
      await loadLaunchWorkspace(tokenAddress, false);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : t("statusCreatorFeeSweepFailed"));
    } finally {
      setLoading(false);
    }
  }

  const selectedLaunchLinks = launchMetadataLinks(selectedLaunchMetadata);
  const latestLaunch = recentLaunchSnapshots[0] ?? null;

  function handleJumpToLatestLaunches() {
    setMarketSort("recent");
    setMarketLimit("10");
    marketBoardRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  return (
    <main className="app-shell">
      <header className="topbar topbar-compact">
        <div className="brand-lockup">
          <img className="brand-mark" src={BRAND_MARK_URL} alt="Autonomous 314 logo" />
          <div className="brand-copy">
            <div className="brand-row">
              <span className="badge brand-badge">{t('tagline')}</span>
              <span className="section-kicker">{runtimeChainLabel} {t('chainProfile')}</span>
              <a className="repo-link" href={REPO_URL} target="_blank" rel="noreferrer">
                <svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>
                {t('repoLink')}
              </a>
            </div>
            <h1>{t('brand')}</h1>
            <p className="topbar-copy">
              {t('heroSubtitle')} {activeProtocolProfile.dexName}。
            </p>
          </div>
        </div>
        <div className="topbar-actions">
          <nav className="nav-pills">
            <button className={route.page === "home" ? "nav-pill active" : "nav-pill"} onClick={() => navigate({ page: "home" })}>
              {t('navHome')}
            </button>
            <button className={route.page === "create" ? "nav-pill active" : "nav-pill"} onClick={() => navigate({ page: "create" })}>
              {t('navCreate')}
            </button>
            {route.page === "launch" && (
              <button
                className="nav-pill active"
                onClick={() => navigate({ page: "launch", token: route.token })}
              >
                {t('navLaunch')}
              </button>
            )}
            {wallet && (
              <button className={route.page === "creator" ? "nav-pill active" : "nav-pill"} onClick={() => navigate({ page: "creator" })}>
                {t('navCreator')}
              </button>
            )}
          </nav>
          <button className="lang-toggle" onClick={toggleLocale}>{locale === "en" ? t("langToggleZh") : t("langToggleEn")}</button>
          <button className="secondary-button" onClick={handleConnectWallet}>
            {wallet ? shortAddress(wallet) : t('connectWallet')}
          </button>
        </div>
      </header>

      {walletWrongNetwork && (
        <section className="callout danger">
          <strong>{t('wrongNetwork')}</strong>
          <p>
            {t('wrongNetworkDesc')} {runtimeChainLabel} (chainId {activeProtocolProfile.chainId}) {t('beforeWriting')}
          </p>
          <div className="button-row">
            <button onClick={handleSwitchNetwork}>{t('switchNetwork')}</button>
          </div>
        </section>
      )}

      {route.page === "home" && (
        <>
          <section className="home-hero panel">
            <div>
              <span className="section-kicker">{t('homeHeroKicker')}</span>
              <h2>{t('homeHeroTitle')}</h2>
              <p>{t('homeHeroDesc')}</p>
            </div>
            <div className="button-row hero-actions">
              <button onClick={() => navigate({ page: "create" })}>{t('homeCreateBtn')}</button>
              {latestLaunch && (
                <button className="secondary-button" onClick={handleJumpToLatestLaunches}>
                  {t('homeLatestBtn')}
                </button>
              )}
            </div>
          </section>

          <section className="protocol-intro panel">
            <div className="protocol-intro-copy">
              <span className="section-kicker">{t("protocolIntroKicker")}</span>
              <h2>{t("protocolIntroTitle")}</h2>
              <p>{t("protocolIntroDesc")}</p>
            </div>
            <div className="protocol-intro-points">
              <article className="protocol-point">
                <div className="protocol-point-head">
                  <span className="protocol-point-index">01</span>
                  <h3>{t("protocolPointOneTitle")}</h3>
                </div>
                <p>{t("protocolPointOneDesc")}</p>
              </article>
              <article className="protocol-point">
                <div className="protocol-point-head">
                  <span className="protocol-point-index">02</span>
                  <h3>{t("protocolPointTwoTitle")}</h3>
                </div>
                <p>{t("protocolPointTwoDesc")}</p>
              </article>
              <article className="protocol-point">
                <div className="protocol-point-head">
                  <span className="protocol-point-index">03</span>
                  <h3>{t("protocolPointThreeTitle")}</h3>
                </div>
                <p>{t("protocolPointThreeDesc")}</p>
              </article>
            </div>
          </section>

          <section className="protocol-flow-grid">
            <article className="panel protocol-flow-card">
              <span className="section-kicker">{t("protocolFlowKicker")}</span>
              <h3>{t("protocolFlowTitle")}</h3>
              <div className="protocol-flow-steps">
                <div>
                  <strong>{t("protocolFlowStepOneTitle")}</strong>
                  <p>{t("protocolFlowStepOneDesc")}</p>
                </div>
                <div>
                  <strong>{t("protocolFlowStepTwoTitle")}</strong>
                  <p>{t("protocolFlowStepTwoDesc")}</p>
                </div>
                <div>
                  <strong>{t("protocolFlowStepThreeTitle")}</strong>
                  <p>{t("protocolFlowStepThreeDesc")}</p>
                </div>
              </div>
            </article>

            <article className="panel protocol-flow-card">
              <span className="section-kicker">{t("protocolCompareKicker")}</span>
              <h3>{t("protocolCompareTitle")}</h3>
              <ul className="protocol-compare-list">
                <li>{t("protocolCompareOne")}</li>
                <li>{t("protocolCompareTwo")}</li>
                <li>{t("protocolCompareThree")}</li>
                <li>{t("protocolCompareFour")}</li>
              </ul>
            </article>
          </section>

          <section className="protocol-faq-grid">
            <article className="protocol-faq-card panel">
              <span className="section-kicker">{t("protocolFaqKicker")}</span>
              <h3>{t("protocolFaqOneTitle")}</h3>
              <p>{t("protocolFaqOneDesc")}</p>
            </article>
            <article className="protocol-faq-card panel">
              <span className="section-kicker">{t("protocolFaqKicker")}</span>
              <h3>{t("protocolFaqTwoTitle")}</h3>
              <p>{t("protocolFaqTwoDesc")}</p>
            </article>
            <article className="protocol-faq-card panel">
              <span className="section-kicker">{t("protocolFaqKicker")}</span>
              <h3>{t("protocolFaqThreeTitle")}</h3>
              <p>{t("protocolFaqThreeDesc")}</p>
            </article>
          </section>

          <section className="manifesto-grid">
            <article className="manifesto-card">
              <h3>🔗 {t('selfSovereign')}</h3>
              <p>{t('selfSovereignDesc')}</p>
            </article>
            <article className="manifesto-card">
              <h3>🎓 {t('graduation2')}</h3>
              <p>{t('graduation2Desc')}</p>
            </article>
            <article className="manifesto-card">
              <h3>💎 {t('creatorFirst')}</h3>
              <p>{t('creatorFirstDesc')}</p>
            </article>
            <article className="manifesto-card">
              <h3>🔓 {t('openSource')}</h3>
              <p>{t('openSourceDesc')}</p>
            </article>
          </section>

          <section className="market-strip compact">
            <div className="strip-card">
              <span className="metric-label">{t('feeSplit')}</span>
              <strong>{t('economics')}</strong>
            </div>
            <div className="strip-card">
              <span className="metric-label">{t('graduation')}</span>
                <strong>
                  {displayedGraduationTarget > 0n
                    ? tf("graduationWithLpReserve", { target: formatNative(displayedGraduationTarget) })
                    : t("configWithLpReserve")}
                </strong>
            </div>
            <div className="strip-card">
              <span className="metric-label">{t('marketMode')}</span>
              <strong>{t('preGradDesc')}</strong>
            </div>
          </section>

          <section className="origin-grid">
            <article className="origin-card panel">
              <span className="section-kicker">{t("originKicker")}</span>
              <h3>{t("originTitle")}</h3>
              <p>{t("originDesc")}</p>
            </article>
            <article className="origin-card panel">
              <span className="origin-pill">01</span>
              <h3>{t("originTransferTitle")}</h3>
              <p>{t("originTransferDesc")}</p>
            </article>
            <article className="origin-card panel">
              <span className="origin-pill">02</span>
              <h3>{t("originNoSwapTitle")}</h3>
              <p>{t("originNoSwapDesc")}</p>
            </article>
            <article className="origin-card panel">
              <span className="origin-pill">03</span>
              <h3>{t("originCooldownTitle")}</h3>
              <p>{t("originCooldownDesc")}</p>
            </article>
          </section>

          <section className="search-hero">
            <div>
              <span className="section-kicker">{t('contractSearch')}</span>
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.88rem' }}>{t('contractSearchDesc')}</p>
            </div>
            <div className="search-hero-row">
              <label className="field">
                <span>{t('tokenAddress')}</span>
                <input
                  value={contractSearchInput}
                  onChange={(e) => setContractSearchInput(e.target.value)}
                  placeholder={t('contractSearchPlaceholder')}
                />
              </label>
              <button
                onClick={() => {
                  const addr = contractSearchInput.trim();
                  if (addr.match(/^0x[a-fA-F0-9]{40}$/)) {
                    setTokenAddress(addr);
                    navigate({ page: "launch", token: addr });
                    void handleSelectLaunch(addr);
                  }
                }}
                disabled={!contractSearchInput.trim().match(/^0x[a-fA-F0-9]{40}$/)}
              >
                {t('contractSearchBtn')}
              </button>
            </div>
          </section>

          <section className="market-board" ref={marketBoardRef}>
            <div className="section-header">
              <div>
                <span className="section-kicker">{t('marketBoard')}</span>
                <h2>{t('openLaunches')}</h2>
              </div>
              <div className="market-toolbar">
                <label className="field compact-field search-field">
                  <span>{t('searchLaunches')}</span>
                  <input
                    value={marketQuery}
                    onChange={(e) => setMarketQuery(e.target.value)}
                    placeholder={t('searchPlaceholder')}
                  />
                </label>
                {searchLooksLikeAddress ? (
                  <button className="secondary-button" onClick={() => void handleInspectAndLoadSearchToken()} disabled={loading}>
                    {t('verifyLoad')}
                  </button>
                ) : null}
                <div className="market-filter-group">
                  <span className="metric-label">{t("sortBy")}</span>
                  <div className="segmented-filter" role="tablist" aria-label={t("sortBy")}>
                    <button type="button" className={marketSort === "recent" ? "filter-pill active" : "filter-pill"} onClick={() => setMarketSort("recent")}>
                      {t("sortRecent")}
                    </button>
                    <button type="button" className={marketSort === "marketCap" ? "filter-pill active" : "filter-pill"} onClick={() => setMarketSort("marketCap")}>
                      {t("sortMarketCap")}
                    </button>
                    <button type="button" className={marketSort === "progress" ? "filter-pill active" : "filter-pill"} onClick={() => setMarketSort("progress")}>
                      {t("sortProgress")}
                    </button>
                    <button type="button" className={marketSort === "countdown" ? "filter-pill active" : "filter-pill"} onClick={() => setMarketSort("countdown")}>
                      {t("sortCountdown")}
                    </button>
                  </div>
                </div>
                <div className="market-filter-group">
                  <span className="metric-label">{t("showCount")}</span>
                  <div className="segmented-filter segmented-filter-compact" role="tablist" aria-label={t("showCount")}>
                    <button type="button" className={marketLimit === "10" ? "filter-pill active" : "filter-pill"} onClick={() => setMarketLimit("10")}>
                      10
                    </button>
                    <button type="button" className={marketLimit === "20" ? "filter-pill active" : "filter-pill"} onClick={() => setMarketLimit("20")}>
                      20
                    </button>
                    <button type="button" className={marketLimit === "all" ? "filter-pill active" : "filter-pill"} onClick={() => setMarketLimit("all")}>
                      {t("showAll")}
                    </button>
                  </div>
                </div>
                <span className="list-item-meta">
                  {visibleLaunchSnapshots.length} / {filteredLaunchSnapshots.length} / {recentLaunchSnapshots.length} {t('indexedLaunches')}
                </span>
              </div>
            </div>

            {tokenVerification && searchLooksLikeAddress && (
              <div className={`callout ${verificationTone}`}>
                <strong>
                  {tokenVerification.status === "official"
                    ? t('verifiedOfficial')
                    : tokenVerification.status === "warning"
                      ? t('verifiedSuspicious')
                      : t('verifiedForeign')}
                </strong>
                <p>{tokenVerification.summary}</p>
              </div>
            )}

            {filteredLaunchSnapshots.length === 0 ? (
              <div className="empty-state panel">
                {trimmedMarketQuery
                  ? t('noLaunchesMatch')
                  : t('noLaunchesYet')}
              </div>
            ) : (
              <div className="launch-card-grid">
                {visibleLaunchSnapshots.map((launch) => {
                  const metadataState = launchMetadataByToken[launch.address.toLowerCase()];
                  const metadata = metadataState ?? null;
                  const image = resolvePreviewImage(metadata?.image ?? "");
                  const links = launchMetadataLinks(metadata);
                  const isActive = tokenAddress.toLowerCase() === launch.address.toLowerCase();
                  const launchMarketCapQuote = quoteMarketCap(
                    launch.totalSupply > 0n ? launch.totalSupply : defaultTotalSupply,
                    launch.currentPriceQuotePerToken
                  );
                  const launchMarketCapUsd =
                    launchMarketCapQuote > 0n && nativeUsdPrice
                      ? (Number(launchMarketCapQuote) / 1e18) * nativeUsdPrice
                      : null;
                  const launchPriceUsd =
                    nativeUsdPrice ? (Number(launch.currentPriceQuotePerToken) / 1e18) * nativeUsdPrice : null;
                  const displayState = effectiveLaunchState(launch.state, launch.whitelistStatus, launch.whitelistSnapshot, nowMs);
                  const whitelistCountdownPending =
                    displayState === "WhitelistCommit" && launch.whitelistSnapshot
                      ? nowMs < Number(launch.whitelistSnapshot.opensAt) * 1000
                      : false;
                  const whitelistCountdownLabel =
                    displayState === "WhitelistCommit" && launch.whitelistSnapshot
                      ? `${whitelistCountdownPending ? t("whitelistOpensLabel") : t("whitelistEndsLabel")} ${formatCountdownLabel(whitelistCountdownPending ? Number(launch.whitelistSnapshot.opensAt) * 1000 : Number(launch.whitelistSnapshot.deadline) * 1000, nowMs)}`
                      : "";
                  const cardSecondaryMetric =
                    displayState === "WhitelistCommit" && whitelistCountdownLabel
                      ? formatCountdownLabel(
                          whitelistCountdownPending
                            ? Number(launch.whitelistSnapshot!.opensAt) * 1000
                            : Number(launch.whitelistSnapshot!.deadline) * 1000,
                          nowMs
                        )
                      : launchPriceUsd
                        ? formatUsdMicroPriceCompact(launchPriceUsd)
                        : "—";

                  return (
                    <article key={launch.address} className={`launch-card ${isActive ? "active" : ""}`}>
                      <div className="launch-card-media">
                        {image ? (
                          <img src={image} alt={tf("launchCoverAlt", { name: metadata?.name || launch.name })} />
                        ) : (
                          <div className="launch-card-placeholder">{(metadata?.symbol || launch.symbol).slice(0, 6)}</div>
                        )}
                        <span className={`stage-pill ${displayState === "Bonding314" ? "live" : displayState === "DEXOnly" ? "done" : ""}`}>
                          {launchStateLabel(displayState)}
                        </span>
                      </div>
                      <div className="launch-card-body">
                        <div className="launch-card-head">
                          <div className="launch-card-title-wrap">
                            <div className="launch-card-title-row">
                              <h3>{metadata?.name || launch.name}</h3>
                              <strong className="launch-card-market-cap">
                                {launchMarketCapUsd ? formatUsdCompact(launchMarketCapUsd) : t("marketCapUnavailable")}
                              </strong>
                            </div>
                            <div className="launch-card-symbol">
                              {metadata?.symbol || launch.symbol} · {launch.launchSuffix || t("launchSuffixFallback")}
                            </div>
                          </div>
                        </div>
                        <p className="launch-card-description">
                          {metadata?.description || launchCardFallbackDescription(displayState)}
                        </p>
                        <div className="launch-card-stats launch-card-stats-dual">
                          <div>
                            <span className="metric-label">{t("progress")}</span>
                            <strong className="launch-card-metric-value">{formatPercentFromBps(launch.graduationProgressBps)}</strong>
                          </div>
                          <div>
                            <span className="metric-label">{displayState === "WhitelistCommit" ? (whitelistCountdownPending ? t("whitelistOpensLabelShort") : t("whitelistEndsLabelShort")) : t("price")}</span>
                            <strong className="launch-card-metric-value compact">{cardSecondaryMetric}</strong>
                          </div>
                        </div>
                        <div className="metadata-links">
                          {links.length > 0 ? (
                            links.map((link) => (
                              <a key={`${launch.address}-${link.label}`} href={link.href} target="_blank" rel="noreferrer">
                                {link.label}
                              </a>
                            ))
                          ) : (
                            <span>{t('noSocialLinks')}</span>
                          )}
                        </div>
                        <div className="button-row launch-card-actions">
                          <div className="launch-card-primary-actions">
                            <button onClick={() => void handleQuickBuyLaunch(launch.address)}>
                              {t('buyNow')}
                            </button>
                            <button className="secondary-button" onClick={() => void handleSelectLaunch(launch.address)}>
                              {t('openWorkspace')}
                            </button>
                            <span className="launch-card-address">{shortAddress(launch.address)}</span>
                            <button
                              type="button"
                              className="copy-chip launch-card-copy-chip"
                              aria-label={copiedLaunchAddress === launch.address ? t('copied') : t('copyContract')}
                              title={copiedLaunchAddress === launch.address ? t('copied') : t('copyContract')}
                              onClick={() => void handleCopyLaunchAddress(launch.address)}
                            >
                              {copiedLaunchAddress === launch.address ? '✓' : '⧉'}
                            </button>
                          </div>
                        </div>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </section>
        </>
      )}

      {route.page === "create" && (
        <section className={`page-grid create-grid${factoryPanelExpanded ? "" : " create-grid-collapsed"}`}>
          <aside className={`rail create-factory-rail ${factoryPanelExpanded ? "expanded" : "collapsed"}`}>
            <article className={`panel factory-panel ${factoryPanelExpanded ? "expanded" : "collapsed"}`}>
              <div className="section-head compact-head factory-panel-head">
                <div>
                  <h2>{t('factorySettings')}</h2>
                  {factoryPanelExpanded ? <p>{t('factoryAddressNote')}</p> : null}
                </div>
                <button
                  type="button"
                  className="secondary-button factory-toggle"
                  onClick={() => setShowFactorySettings((current) => !current)}
                  aria-expanded={factoryPanelExpanded}
                >
                  {factoryPanelExpanded ? t('hideFactorySettings') : t('showFactorySettings')}
                </button>
              </div>
              {factoryPanelExpanded ? (
                <>
                  <div className="factory-switch" role="tablist" aria-label={t('factorySettings')}>
                    <button
                      type="button"
                      className={factoryInputMode === "official" ? "factory-switch-pill active" : "factory-switch-pill"}
                      onClick={() => {
                        setFactoryInputMode("official");
                        setFactoryAddress(OFFICIAL_FACTORY_ADDRESS);
                      }}
                    >
                      {t("useOfficialFactory")}
                    </button>
                    <button
                      type="button"
                      className={factoryInputMode === "custom" ? "factory-switch-pill active" : "factory-switch-pill"}
                      onClick={() => {
                        setFactoryInputMode("custom");
                        setShowFactorySettings(true);
                        setFactoryAddress(customFactoryInput.trim());
                      }}
                    >
                      {t("useCustomFactory")}
                    </button>
                  </div>
                  <div className="factory-summary">
                    <div>
                      <span>{t('factorySource')}</span>
                      <strong>{factoryInputMode === 'official' ? t('useOfficialFactory') : (customFactoryInput.trim() || t('useCustomFactory'))}</strong>
                    </div>
                    <div>
                      <span>{t('createFeeStandard')}</span>
                      <strong>{formatNative(factorySnapshot?.standardCreateFee ?? parseEther('0.01'))}</strong>
                    </div>
                    <div>
                      <span>{t('createFeeWhitelist')}</span>
                      <strong>{formatNative(factorySnapshot?.whitelistCreateFee ?? parseEther('0.03'))}</strong>
                    </div>
                  </div>
                  <div className="factory-expanded">
                    {factoryInputMode === "official" ? (
                      <label className="field">
                        <span>{t('factoryAddress')}</span>
                        <input value={OFFICIAL_FACTORY_ADDRESS} readOnly />
                      </label>
                    ) : (
                      <label className="field">
                        <span>{t('factoryAddress')}</span>
                        <input
                          value={customFactoryInput}
                          onChange={(e) => {
                            setCustomFactoryInput(e.target.value);
                            setFactoryAddress(e.target.value);
                          }}
                          placeholder="0x..."
                        />
                      </label>
                    )}
                    <div className="button-row">
                      <button onClick={handleLoadFactory}>{t('loadFactoryBtn')}</button>
                      <button
                        className="secondary-button"
                        onClick={handleClaimFactoryFees}
                        disabled={!factorySnapshot || !connectedAsProtocolRecipient || walletWrongNetwork}
                      >
                        {t('claimFactoryFees')}
                      </button>
                    </div>
                    {factorySnapshot && (
                      <>
                        <dl className="data-list compact">
                          <div><dt>{t('graduationTarget')}</dt><dd>{formatNative(factorySnapshot.graduationQuoteReserve)}</dd></div>
                          <div><dt>{t('totalLaunches')}</dt><dd>{factorySnapshot.totalLaunches.toString()}</dd></div>
                          <div><dt>{t('protocolRecipient')}</dt><dd>{shortAddress(factorySnapshot.protocolFeeRecipient)}</dd></div>
                          <div><dt>{t('accruedFees')}</dt><dd>{formatNative(factorySnapshot.accruedProtocolCreateFees)}</dd></div>
                        </dl>
                        <div className="mini-list">
                          <div className="mini-list-title">{t('recentLaunches')}</div>
                          {recentLaunchSnapshots.length === 0 ? (
                            <div className="mini-list-empty">{t('noLaunches')}</div>
                          ) : (
                            recentLaunchSnapshots.slice(0, 8).map((launch) => (
                              <button key={launch.address} className="list-item" onClick={() => void handleSelectLaunch(launch.address)}>
                                <span className="list-item-main">
                                  <strong>{launch.symbol}</strong>
                                  <span>{launchStateLabel(launch.state)} · {formatPercentFromBps(launch.graduationProgressBps)}</span>
                                </span>
                                <span className="list-item-meta">{formatNative(launch.currentPriceQuotePerToken)}</span>
                              </button>
                            ))
                          )}
                        </div>
                      </>
                    )}
                  </div>
                </>
              ) : (
                <div className="factory-collapsed-summary">
                  <div className="factory-collapsed-meta">
                    <span className="section-kicker">{factoryInputMode === 'official' ? t('useOfficialFactory') : t('useCustomFactory')}</span>
                    <strong>{factoryInputMode === 'official' ? t('useOfficialFactory') : t('useCustomFactory')}</strong>
                    <span className="factory-collapsed-address">
                      {shortAddress(factoryInputMode === 'official' ? OFFICIAL_FACTORY_ADDRESS : (customFactoryInput.trim() || OFFICIAL_FACTORY_ADDRESS))}
                    </span>
                  </div>
                  <div className="factory-collapsed-fees">
                    <div>
                      <span>{t('createFeeStandard')}</span>
                      <strong>{formatNative(factorySnapshot?.standardCreateFee ?? parseEther('0.01'))}</strong>
                    </div>
                    <div>
                      <span>{t('createFeeWhitelist')}</span>
                      <strong>{formatNative(factorySnapshot?.whitelistCreateFee ?? parseEther('0.03'))}</strong>
                    </div>
                  </div>
                </div>
              )}
            </article>
          </aside>

          <section className="workspace-main create-workspace-main">
            <article className="panel">
              <div className="create-hero-card">
                <div className="create-hero-top">
                  <div className="create-hero-intro">
                    <span className="section-kicker">{t('createKicker')}</span>
                    <h2>{t('createTitle')}</h2>
                    <p className="topbar-copy">
                      {t('createDesc')}
                    </p>
                  </div>
                  <div className="create-hero-control">
                    <div className="mode-toggle" role="tablist" aria-label={t("launchModeAria")}>
                    <button
                      type="button"
                      className={createMode === "standard" ? "mode-tab active" : "mode-tab"}
                      onClick={() => setCreateMode("standard")}
                    >
                      <span>0314</span>
                      <small>{t('modeStandard')}</small>
                    </button>
                    <button
                      type="button"
                      className={createMode === "whitelist" ? "mode-tab active" : "mode-tab"}
                      onClick={() => setCreateMode("whitelist")}
                      disabled={whitelistModeUnsupported}
                      title={whitelistModeUnsupported ? t("modeWhitelistTooltipLocked") : t("modeWhitelistTooltipLive")}
                    >
                      <span>b314</span>
                      <small>{t('modeWhitelist')}</small>
                    </button>
                    <button
                      type="button"
                      className={createMode === "taxed" ? "mode-tab active" : "mode-tab"}
                      onClick={() => setCreateMode("taxed")}
                      disabled={taxedModeUnsupported}
                      title={taxedModeUnsupported ? t("modeTaxTooltipLocked") : t("modeTaxTooltipLive")}
                    >
                      <span>1314–9314</span>
                      <small>{t('modeTaxed')}</small>
                    </button>
                    <button
                      type="button"
                      className={createMode === "whitelistTaxed" ? "mode-tab active" : "mode-tab"}
                      onClick={() => setCreateMode("whitelistTaxed")}
                      disabled={whitelistTaxedModeUnsupported}
                      title={whitelistTaxedModeUnsupported ? t("modeWhitelistTaxTooltipLocked") : t("modeWhitelistTaxTooltipLive")}
                    >
                      <span>f314</span>
                      <small>{t('modeWhitelistTax')}</small>
                    </button>
                    </div>
                  </div>
                </div>
                <section className="launch-family-strip" aria-label={t("launchFamiliesAria")}>
                  <article
                    key={selectedLaunchFamily.suffix}
                    className="launch-family-card selected"
                  >
                    <div className="launch-family-head">
                      <div>
                        <span className="section-kicker">{selectedLaunchFamily.eyebrow}</span>
                        <h3>{selectedLaunchFamily.title}</h3>
                      </div>
                      <div className="launch-family-badges">
                        <span className="launch-family-suffix">{selectedLaunchFamily.suffix}</span>
                        <span className={`family-state ${selectedLaunchFamily.status}`}>
                          {t("modeLive")}
                        </span>
                      </div>
                    </div>
                    <p>{selectedLaunchFamily.description}</p>
                    <ul className="launch-family-points">
                      {selectedLaunchFamily.operations.map((point: string) => (
                        <li key={`${selectedLaunchFamily.suffix}-${point}`}>{point}</li>
                      ))}
                    </ul>
                  </article>
                </section>
              </div>

              {customFactorySelected && (
                <div className={`callout compact-callout ${whitelistModeUnsupported || taxedModeUnsupported || whitelistTaxedModeUnsupported ? "warn" : "success"}`}>
                  <strong>{t("customFactoryModeNoticeTitle")}</strong>
                  <p>
                    {whitelistModeUnsupported || taxedModeUnsupported || whitelistTaxedModeUnsupported
                      ? t("customFactoryModeNoticeWarn")
                      : t("customFactoryModeNoticeOk")}
                  </p>
                </div>
              )}

              <section className="create-steps-strip">
                <article className="create-step-card">
                  <span className="create-step-index">01</span>
                  <strong>{t("createStepOneTitle")}</strong>
                  <p>{t("createStepOneDesc")}</p>
                </article>
                <article className="create-step-card">
                  <span className="create-step-index">02</span>
                  <strong>{t("createStepTwoTitle")}</strong>
                  <p>{t("createStepTwoDesc")}</p>
                </article>
                <article className="create-step-card">
                  <span className="create-step-index">03</span>
                  <strong>{t("createStepThreeTitle")}</strong>
                  <p>{t("createStepThreeDesc")}</p>
                </article>
              </section>

              <div className="create-layout">
                <div className="create-sections">
                  <section className="create-section identity-section">
                    <div className="create-section-head">
                      <div>
                        <span className="section-kicker">{t("identityKicker")}</span>
                        <h3>{t("identityTitle")}</h3>
                      </div>
                      <div className="section-head-actions">
                        <span className="status-pill success">{selectedLaunchFamily.suffix.toUpperCase()}</span>
                      </div>
                    </div>
                    <div className="metadata-two-column identity-grid">
                      <label className="field prominent-field">
                        {renderFieldLabel(t("tokenName"))}
                        <input value={createName} onChange={(e) => setCreateName(sanitizeUnicodeLabel(e.target.value, "name"))} placeholder={t("tokenNamePlaceholder")} />
                                              </label>
                      <label className="field prominent-field">
                        {renderFieldLabel(t("tokenSymbol"))}
                        <input value={createSymbol} onChange={(e) => setCreateSymbol(sanitizeUnicodeLabel(e.target.value, "symbol"))} placeholder={t("tokenSymbolPlaceholder")} />
                                              </label>
                    </div>
                    <label className="field">
                      {renderFieldLabel(t("description"), "description", true)}
                      {createFieldHelp === "description" ? <small className="field-help-copy">{t("descriptionHelp")}</small> : null}
                      <textarea
                        value={createDescription}
                        onChange={(e) => setCreateDescription(e.target.value)}
                        placeholder={t("descriptionPlaceholder")}
                        rows={4}
                      />
                    </label>
                    {requiresAtomicBuy && (
                      <div className="creator-protection-block">
                        <label className="toggle-row">
                          <input
                            type="checkbox"
                            checked={createAtomicBuyEnabled}
                            onChange={(e) => setCreateAtomicBuyEnabled(e.target.checked)}
                          />
                          <span>{t("creatorProtectionToggle")}</span>
                        </label>
                        <small className="field-note">
                          {createAtomicBuyEnabled ? t("creatorProtectionEnabledNote") : t("creatorProtectionOptionalNote")}
                        </small>
                        {createAtomicBuyEnabled ? (
                          <div className="creator-buy-grid">
                            <label className="field">
                              <span>{`${t("atomicBuyAmount")} (${activeProtocolProfile.nativeSymbol})`}</span>
                              <input
                                value={createAtomicBuyAmount}
                                onChange={(e) => setCreateAtomicBuyAmount(e.target.value)}
                                placeholder="1"
                              />
                            </label>
                            <div className="field creator-estimate-card">
                              <span>{t("creatorEstimateLabel")}</span>
                              <div className="creator-estimate-value">
                                <strong>{createAtomicBuyPreviewLabel}</strong>
                                <small>{t("creatorEstimateHint")}</small>
                              </div>
                            </div>
                          </div>
                        ) : (
                          <div className="callout compact-callout subtle-callout">
                            <p>{t("creatorFlowManualBuyNote")}</p>
                          </div>
                        )}
                      </div>
                    )}
                    {requiresWhitelistCommit && (
                      <div className="callout compact-callout">
                        <strong>{isDelayedWhitelistOpen ? t("summaryScheduledSeat") : t("summaryAtomicSeat")}</strong>
                        <p>{isDelayedWhitelistOpen ? t("creatorFlowScheduledSeatNote") : t("creatorFlowSeatNote")}</p>
                      </div>
                    )}
                  </section>

                  <section className="create-section">
                    <div className="create-section-head">
                      <div>
                        <span className="section-kicker">{t("metadataKicker")}</span>
                        <h3>{t("metadataTitle")}</h3>
                      </div>
                    </div>
                    <div className="field-group-head">
                      <strong>{t("coverImageLabel")} <em className="field-required-mark">*</em></strong>
                      <p>{t("imageEitherOrNote")}</p>
                    </div>
                    <div className="metadata-image-stack">
                      <label className="field">
                        {renderFieldMethodLabel(t("imageUrl"), "image")}
                        {createFieldHelp === "image" ? <small className="field-help-copy">{t("imageHelp")}</small> : null}
                        <input value={createImageUrl} onChange={(e) => setCreateImageUrl(e.target.value)} placeholder={t("imageUrlPlaceholder")} />
                        <small className="field-note">{t("imageUrlOptionalNote")}</small>
                      </label>
                      <div className="metadata-image-divider">
                        <span>{t("imageEitherOrDivider")}</span>
                      </div>
                      <label className="field">
                        {renderFieldMethodLabel(t("uploadImage"), "imageUpload")}
                        {createFieldHelp === "imageUpload" ? <small className="field-help-copy">{t("imageUploadHelp")}</small> : null}
                        <input
                          type="file"
                          accept="image/*"
                          onChange={(e) => {
                            void handleMetadataImageUpload(e.target.files?.[0] ?? null);
                          }}
                        />
                        <small className="field-note">{t("imageUploadOptionalNote")}</small>
                      </label>
                    </div>
                    <div className="social-trigger-card">
                      <div className="social-trigger-head">
                        <div className="social-trigger-copy">
                          <span className="section-kicker">{t("socialLinksLabel")} <em className="field-badge optional">{t("optionalField")}</em></span>
                          <strong>{t("socialLinksTitle")}</strong>
                          <p className="social-trigger-note">{configuredSocialCount > 0 ? tf("socialLinksCount", { count: String(configuredSocialCount) }) : t("socialLinksEmptyHint")}</p>
                        </div>
                        <button type="button" className="secondary-button" onClick={() => setShowSocialEditor((current) => !current)}>
                          {showSocialEditor ? t("hideSocialLinks") : configuredSocialCount > 0 ? t("editSocialLinks") : t("showSocialLinks")}
                        </button>
                      </div>
                    </div>
                    {showSocialEditor && (
                      <div className="social-inline-editor panel subtle-panel">
                        <p className="social-inline-copy">{t("socialLinksDialogDesc")}</p>
                        <div className="metadata-two-column">
                          <label className="field">
                            <span>{t("website")} <em className="field-badge optional">{t("optionalField")}</em></span>
                            <input value={createWebsite} onChange={(e) => setCreateWebsite(e.target.value)} placeholder="https://..." />
                          </label>
                          <label className="field">
                            <span>{t("twitter")} <em className="field-badge optional">{t("optionalField")}</em></span>
                            <input value={createTwitter} onChange={(e) => setCreateTwitter(e.target.value)} placeholder="https://x.com/..." />
                          </label>
                        </div>
                        <div className="metadata-two-column">
                          <label className="field">
                            <span>{t("telegram")} <em className="field-badge optional">{t("optionalField")}</em></span>
                            <input value={createTelegram} onChange={(e) => setCreateTelegram(e.target.value)} placeholder="https://t.me/..." />
                          </label>
                          <label className="field">
                            <span>{t("discord")} <em className="field-badge optional">{t("optionalField")}</em></span>
                            <input value={createDiscord} onChange={(e) => setCreateDiscord(e.target.value)} placeholder="https://discord.gg/..." />
                          </label>
                        </div>
                      </div>
                    )}
                    {createImageFileName && (
                      <div className="callout compact-callout subtle-callout">
                        <p>{t("selectedFile")} {createImageFileName}</p>
                      </div>
                    )}
                    <label className="field">
                      {renderFieldLabel(t("metadataUri"), "metadataUri", true)}
                      {createFieldHelp === "metadataUri" ? <small className="field-help-copy">{t("metadataUriHelp")}</small> : null}
                      <input
                        value={createMetadataUri}
                        onChange={(e) => setCreateMetadataUri(e.target.value)}
                        placeholder={t("metadataUriPlaceholder")}
                      />
                    </label>
                    <div className="button-row">
                      <button className="secondary-button" onClick={() => void handleUploadReferenceMetadata()} type="button">
                        {t("uploadReferenceMetadata")}
                      </button>
                      <button className="secondary-button" onClick={handleUseGeneratedMetadataUri} type="button">
                        {t("useInlineMetadata")}
                      </button>
                      <button className="secondary-button" onClick={handleDownloadMetadata} type="button">
                        {t("downloadMetadata")}
                      </button>
                    </div>
                  </section>

                  {isTaxedFamily && (
                    <section className="create-section">
                      <div className="create-section-head">
                        <div>
                          <span className="section-kicker">{t("taxKicker")}</span>
                          <h3>{t("taxTitle")}</h3>
                        </div>
                        <div className="section-head-actions">
                          <span className="status-pill warn">{createMode === "whitelistTaxed" ? "f314" : `${createTaxBps}314`}</span>
                        </div>
                      </div>
                      <div className="metadata-two-column">
                        <label className="field">
                          {renderFieldLabel(t("taxRate"), "taxRate")}
                          {createFieldHelp === "taxRate" ? <small className="field-help-copy">{t("taxRateHelp")}</small> : null}
                          <select value={createTaxBps} onChange={(e) => setCreateTaxBps(e.target.value)}>
                            <option value="1">1%</option>
                            <option value="2">2%</option>
                            <option value="3">3%</option>
                            <option value="4">4%</option>
                            <option value="5">5%</option>
                            <option value="6">6%</option>
                            <option value="7">7%</option>
                            <option value="8">8%</option>
                            <option value="9">9%</option>
                          </select>
                        </label>
                        <label className="field">
                          {renderFieldLabel(t("treasuryWallet"), "treasuryWallet", treasurySharePercent === 0)}
                          {createFieldHelp === "treasuryWallet" ? <small className="field-help-copy">{t("treasuryWalletHelp")}</small> : null}
                          <input
                            value={createTaxTreasuryWallet}
                            onChange={(e) => setCreateTaxTreasuryWallet(e.target.value)}
                            placeholder={t("treasuryWalletPlaceholder")}
                          />
                        </label>
                      </div>
                      <div className="tax-slider-card">
                        <div className="tax-slider-head">
                          <div>
                            <span className="section-kicker">{t("taxSplitKicker")}</span>
                            <strong>{tf("taxSplitPreview", { tax: taxRatePercent })}</strong>
                          </div>
                          <span className="status-pill warn">{taxRatePercent}%</span>
                        </div>
                        <label className="field">
                          <span>{t("burnShareSlider")}</span>
                          <input
                            type="range"
                            min="0"
                            max="100"
                            step="1"
                            value={burnSharePercent}
                            onChange={(e) => {
                              const burn = Math.max(0, Math.min(100, Number.parseInt(e.target.value || "0", 10) || 0));
                              const treasury = 100 - burn;
                              setCreateTaxBurnShareBps(String(burn * 100));
                              setCreateTaxTreasuryShareBps(String(treasury * 100));
                            }}
                          />
                        </label>
                        <div className="tax-split-grid">
                          <div>
                            <span>{t("burnShare")}</span>
                            <strong>{burnSharePercent}%</strong>
                          </div>
                          <div>
                            <span>{t("treasuryShare")}</span>
                            <strong>{treasurySharePercent}%</strong>
                          </div>
                          <div>
                            <span>{t("burnRateEffective")}</span>
                            <strong>{((taxRatePercent * burnSharePercent) / 100).toFixed(2)}%</strong>
                          </div>
                          <div>
                            <span>{t("treasuryRateEffective")}</span>
                            <strong>{((taxRatePercent * treasurySharePercent) / 100).toFixed(2)}%</strong>
                          </div>
                        </div>
                      </div>
                    </section>
                  )}

                  {requiresWhitelistCommit && (
                    <section className="create-section">
                      <div className="create-section-head">
                        <div>
                          <span className="section-kicker">{t("wlKicker")}</span>
                          <h3>{t("wlTitle")}</h3>
                        </div>
                      </div>
                      <div className="metadata-two-column">
                        <label className="field">
                          {renderFieldLabel(`${t("wlThreshold")} (${activeProtocolProfile.nativeSymbol})`, "wlThreshold")}
                          {createFieldHelp === "wlThreshold" ? <small className="field-help-copy">{t("wlThresholdHelp")}</small> : null}
                          <select value={createWhitelistThreshold} onChange={(e) => setCreateWhitelistThreshold(e.target.value)}>
                            <option value="4">4 BNB</option>
                            <option value="6">6 BNB</option>
                            <option value="8">8 BNB</option>
                          </select>
                        </label>
                        <label className="field">
                          {renderFieldLabel(`${t("wlSlotSize")} (${activeProtocolProfile.nativeSymbol})`, "wlSlotSize")}
                          {createFieldHelp === "wlSlotSize" ? <small className="field-help-copy">{t("wlSlotSizeHelp")}</small> : null}
                          <select value={createWhitelistSlotSize} onChange={(e) => setCreateWhitelistSlotSize(e.target.value)}>
                            <option value="0.1">0.1 BNB</option>
                            <option value="0.2">0.2 BNB</option>
                            <option value="0.5">0.5 BNB</option>
                            <option value="1">1 BNB</option>
                          </select>
                        </label>
                      </div>
                      <label className="checkbox-row">
                        <input
                          type="checkbox"
                          checked={createWhitelistScheduleEnabled}
                          onChange={(e) => {
                            setCreateWhitelistScheduleEnabled(e.target.checked);
                            if (!e.target.checked) {
                              setCreateWhitelistOpensAt("");
                            }
                          }}
                        />
                        <span>{t("wlScheduleToggle")}</span>
                      </label>
                      <label className="field">
                        {renderFieldLabel(t("wlOpenTime"), "wlOpenTime")}
                        {createFieldHelp === "wlOpenTime" ? <small className="field-help-copy">{t("wlOpenTimeHelp")}</small> : null}
                        <input
                          type="datetime-local"
                          value={createWhitelistOpensAt}
                          onChange={(e) => setCreateWhitelistOpensAt(e.target.value)}
                          disabled={!createWhitelistScheduleEnabled}
                        />
                        <small className="field-note">
                          {createWhitelistScheduleEnabled
                            ? tf("wlTimezoneNote", { timezone: whitelistLocalTimezone })
                            : t("wlImmediateToggleNote")}
                        </small>
                        {isDelayedWhitelistOpen ? <small className="field-note">{tf("wlUtcPreview", { utc: whitelistOpensAtUtcText })}</small> : null}
                      </label>
                      <div className="create-summary-grid compact">
                          <div><span>{t("wlSeatTarget")}</span><strong>{whitelistSeatTarget || "—"}</strong></div>
                        <div><span>{t("wlAddressCount")}</span><strong>{whitelistAddressCount}</strong></div>
                        <div><span>{t("wlWindow")}</span><strong>{isDelayedWhitelistOpen ? t("wlScheduled24h") : "24h"}</strong></div>
                      </div>
                      <div className={`callout ${isDelayedWhitelistOpen ? "success" : "warn"} compact-callout`}>
                        <p>{isDelayedWhitelistOpen ? t("wlStartTimeScheduledTitle") : t("wlStartTimeImmediateTitle")}</p>
                      </div>
                      <label className="field">
                        {renderFieldLabel(t("wlAddresses"), "wlAddresses")}
                        {createFieldHelp === "wlAddresses" ? <small className="field-help-copy">{t("wlAddressesHelp")}</small> : null}
                        <textarea
                          value={createWhitelistAddresses}
                          onChange={(e) => setCreateWhitelistAddresses(e.target.value)}
                          placeholder={t("wlAddressesPlaceholder")}
                          rows={7}
                        />
                      </label>
                      <div className={`callout ${whitelistAddressCountValid ? "success" : "warn"} compact-callout`}>
                        <p>{whitelistAddressCountValid ? t("wlCoverageValid") : t("wlCoverageNeed")}</p>
                      </div>
                    </section>
                  )}
                </div>

                <aside className="create-summary-panel">
                  <div className="metadata-preview-card">
                    <div className="metadata-preview-head">
                      <div>
                        <span className="metric-label">{t("previewKicker")}</span>
                        <strong>{createName || t("untitledLaunch")}</strong>
                      </div>
                      <span className="status-pill success">{createSymbol || "TKN"}</span>
                    </div>
                    <div className="metadata-preview-body">
                      <div className="metadata-image-shell">
                        {resolvePreviewImage(launchMetadata.image ?? "") ? (
                          <img
                            className="metadata-image"
                            src={resolvePreviewImage(launchMetadata.image ?? "")}
                            alt={tf("previewAlt", { name: createName || t("launchTitle") })}
                          />
                        ) : (
                          <div className="metadata-image-placeholder">{t("noImageYet")}</div>
                        )}
                      </div>
                      <div className="metadata-preview-copy">
                        <p>{launchMetadata.description || t("previewDescriptionFallback")}</p>
                        <div className="metadata-links">
                          {launchMetadata.website && <span>{t("website")}</span>}
                          {launchMetadata.twitter && <span>X</span>}
                          {launchMetadata.telegram && <span>{t("telegram")}</span>}
                          {launchMetadata.discord && <span>{t("discord")}</span>}
                          {!launchMetadata.website && !launchMetadata.twitter && !launchMetadata.telegram && !launchMetadata.discord && <span>{t("noSocialLinks")}</span>}
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="create-summary-grid">
                    <div><span>{t("summaryMode")}</span><strong>{selectedLaunchFamily.title}</strong></div>
                    <div><span>{t("summaryVanity")}</span><strong>{selectedLaunchFamily.suffix}</strong></div>
                    <div><span>{t("summaryCreatorFlow")}</span><strong>{requiresAtomicBuy ? (createAtomicBuyEnabled ? t("summaryAtomicBuy") : t("summaryManualBuy")) : t("summaryAtomicSeat")}</strong></div>
                    <div><span>{t("summaryFee")}</span><strong>{selectedCreateFee > 0n ? formatNative(selectedCreateFee) : t("loadFactory")}</strong></div>
                    <div><span>{t("summaryGraduation")}</span><strong>{factorySnapshot ? formatNative(factorySnapshot.graduationQuoteReserve) : `12 ${activeProtocolProfile.nativeSymbol}`}</strong></div>
                  </div>

                  <div className="mode-explainer">
                    <div className="mode-explainer-head">
                      <span className="section-kicker">{t("howItWorks")}</span>
                      <strong>{selectedLaunchFamily.title}</strong>
                    </div>
                    <p>{selectedLaunchFamily.description}</p>
                    <ul className="launch-family-points compact">
                      {selectedLaunchFamily.operations.map((point: string) => (
                        <li key={`selected-${point}`}>{point}</li>
                      ))}
                    </ul>
                  </div>

                  <div className="status-hint">
                    {t("onChainNote")}
                  </div>
                  <div className="status-hint">
                    {generatedInlineMetadataUri
                      ? `${t("inlineReady")} (${metadataUriSizeBytes.toLocaleString()} ${t("bytesUnit")}).`
                      : usingUploadedImage
                        ? t("needExternalMetadata")
                        : t("inlineExplain")}
                  </div>
                  <div className="status-hint">
                    {t("vanitySaltNote")} <strong>{selectedLaunchFamily.suffix}</strong>.
                  </div>
                  <div className="status-hint">
                    {t("standardAndTaxedFlow")}
                  </div>
                  <button
                    onClick={!wallet ? () => void handleConnectWallet() : handleOpenCreateConfirm}
                    disabled={loading || (wallet ? !canReviewCreate : false)}
                  >
                    {!wallet
                      ? t("connectWalletBeforeCreate")
                      : createMode === "standard"
                        ? t("createReviewBtn0314")
                        : createMode === "whitelist"
                          ? t("createReviewBtnB314")
                          : createMode === "taxed"
                            ? t("createReviewBtnTax")
                            : t("createReviewBtnF314")}
                  </button>
                </aside>
              </div>
            </article>
          </section>
        </section>
      )}

      {route.page === "launch" && (
        <section className="workspace-grid workspace-grid-launch">
          <aside className="rail">
            <article className="panel launch-support-panel">
              <div className="page-heading compact-heading">
                <div>
                  <span className="section-kicker">{t("launchKicker")}</span>
                  <h2>{t("launchTitle")}</h2>
                </div>
                <button className="secondary-button" onClick={() => navigate({ page: "create" })}>{t("newLaunch")}</button>
              </div>
              <details className="workspace-tools">
                <summary>{t("workspaceTools")}</summary>
                <div className="workspace-tools-body">
                  <label className="field">
                    <span>{t("factoryAddress")}</span>
                    <input value={factoryAddress} onChange={(e) => setFactoryAddress(e.target.value)} placeholder="0x..." />
                  </label>
                  <label className="field">
                    <span>{t("tokenAddress")}</span>
                    <input value={tokenAddress} onChange={(e) => setTokenAddress(e.target.value)} placeholder="0x..." />
                  </label>
                  <div className="button-row">
                    <button onClick={handleLoadFactory}>{t("loadFactoryBtn")}</button>
                    <button className="secondary-button" onClick={handleLoadToken}>{t("verifyLoadBtn")}</button>
                  </div>
                  {factorySnapshot && (
                    <dl className="data-list compact">
                      <div><dt>{t("createFeeStandard")}</dt><dd>{formatNative(factorySnapshot.standardCreateFee)}</dd></div>
                      <div><dt>{t("createFeeWhitelist")}</dt><dd>{formatNative(factorySnapshot.whitelistCreateFee)}</dd></div>
                      <div><dt>{t("graduationTarget")}</dt><dd>{formatNative(factorySnapshot.graduationQuoteReserve)}</dd></div>
                      <div><dt>{t("totalLaunches")}</dt><dd>{factorySnapshot.totalLaunches.toString()}</dd></div>
                      <div><dt>{t("protocolRecipient")}</dt><dd>{shortAddress(factorySnapshot.protocolFeeRecipient)}</dd></div>
                    </dl>
                  )}
                </div>
              </details>
              <div className="mini-list">
                <div className="mini-list-title">{t("recentLaunches")}</div>
                {recentLaunchSnapshots.length === 0 ? (
                  <div className="mini-list-empty">{t("noLaunches")}</div>
                ) : (
                  recentLaunchSnapshots.slice(0, 8).map((launch) => (
                    <button
                      key={launch.address}
                      className={`list-item ${tokenAddress.toLowerCase() === launch.address.toLowerCase() ? "active" : ""}`}
                      onClick={() => void handleSelectLaunch(launch.address)}
                    >
                      <span className="list-item-main">
                        <strong>{launch.symbol}</strong>
                        <span>{launchStateLabel(launch.state)} · {formatPercentFromBps(launch.graduationProgressBps)}</span>
                      </span>
                      <span className="list-item-meta">{formatNative(launch.currentPriceQuotePerToken)}</span>
                    </button>
                  ))
                )}
              </div>
            </article>
          </aside>

          <section className="workspace-main">
            <article className="panel stage-panel">
              <div className="stage-header">
                <div>
                  <span className="section-kicker">{t("selectedLaunch")}</span>
                  {tokenSnapshot ? null : <h2>{t("loadWorkspace")}</h2>}
                </div>
                <span className={`stage-pill ${isBonding ? "live" : isMigrating ? "warn" : isDexOnly ? "done" : ""}`}>
                  {tokenSnapshot ? launchStateLabel(tokenSnapshot.state) : t("noSelection")}
                </span>
              </div>

              {tokenSnapshot ? (
                <>
                  <div className="launch-hero compact">
                    <div className="launch-hero-primary">
                      <div className="launch-hero-head">
                        <div className="launch-hero-title-wrap">
                          {selectedLaunchHasImage ? (
                            <div className="launch-mini-art">
                              <img src={resolvePreviewImage(selectedLaunchMetadata?.image ?? "")!} alt={tf("launchCoverAlt", { name: selectedLaunchMetadata?.name || tokenSnapshot.name })} />
                            </div>
                          ) : null}
                          <div>
                            <span className="section-kicker">{t("launchOverview")}</span>
                            <h3>{selectedLaunchMetadata?.name || tokenSnapshot.name}</h3>
                            <div className="launch-card-symbol">{selectedLaunchMetadata?.symbol || tokenSnapshot.symbol}</div>
                          </div>
                        </div>
                      </div>
                      <p>
                        {selectedLaunchMetadata?.description ||
                          (selectedLaunchMetadataLoading
                            ? t("resolvingMetadata")
                            : t("noMetadata"))}
                      </p>
                      <div className="metadata-links">
                        {selectedLaunchLinks.length > 0 ? (
                          selectedLaunchLinks.map((link) => (
                            <a key={`${tokenSnapshot.address}-${link.label}`} href={link.href} target="_blank" rel="noreferrer">
                              {link.label}
                            </a>
                          ))
                        ) : (
                          <span>{t("noSocialLinks")}</span>
                        )}
                      </div>
                    </div>

                    <div className="launch-hero-side">
                      <div className="launch-meta-strip">
                        <span className="status-pill">{tokenSnapshot.launchSuffix}</span>
                        <span className="status-pill">{launchModeLabel(tokenSnapshot.launchMode)}</span>
                        <span className="status-pill">{shortAddress(tokenSnapshot.creator)}</span>
                      </div>
                      <dl className="launch-hero-summary">
                        <div>
                          <dt>{t("creator")}</dt>
                          <dd>{shortAddress(tokenSnapshot.creator)}</dd>
                        </div>
                        <div>
                          <dt>{t("tokenAddressLabel")}</dt>
                          <dd>{shortAddress(tokenSnapshot.address)}</dd>
                        </div>
                        <div>
                          <dt>{t("mode")}</dt>
                          <dd>{launchModeLabel(tokenSnapshot.launchMode)}</dd>
                        </div>
                        <div>
                          <dt>{t("suffix")}</dt>
                          <dd>{tokenSnapshot.launchSuffix}</dd>
                        </div>
                      </dl>
                      <div className="launch-utility-row">
                        <button type="button" className="copy-chip" onClick={() => void handleCopyText(tokenSnapshot.address, t("tokenAddressLabel"))}>
                          {t("copyContract")}
                        </button>
                        <button type="button" className="copy-chip" onClick={() => void handleCopyText(tokenSnapshot.creator, t("creator"))}>
                          {t("copyCreator")}
                        </button>
                        {explorerAddressUrl(tokenSnapshot.address) ? (
                          <a className="copy-chip inline-link chip-link" href={explorerAddressUrl(tokenSnapshot.address)} target="_blank" rel="noreferrer">
                            {t("viewOnExplorer")}
                          </a>
                        ) : null}
                      </div>
                    </div>
                  </div>

                  <div className="launch-status-band">
                    <div className="launch-status-card primary">
                      <span className="metric-label">{t("statusMessage")}</span>
                      <strong>{launchStateLabel(tokenSnapshot.state)}</strong>
                      <div className="metric-subtle">{launchModeLabel(tokenSnapshot.launchMode)} · {tokenSnapshot.launchSuffix}</div>
                    </div>
                    <div className="launch-status-card">
                      <span className="metric-label">{t("graduationProgress")}</span>
                      <strong>{formatPercentFromBps(tokenSnapshot.graduationProgressBps)}</strong>
                      <div className="metric-subtle">{tf("raisedAgainstTarget", { raised: formatNativeCompact(heroRaised), target: formatNativeCompact(tokenSnapshot.graduationQuoteReserve) })}</div>
                    </div>
                    <div className="launch-status-card">
                      <span className="metric-label">{t("raisedLabel")}</span>
                      <strong>{formatNativeCompact(heroRaised)}</strong>
                      <div className="metric-subtle">{t("bondingActions")}</div>
                    </div>
                    <div className="launch-status-card">
                      <span className="metric-label">{t("remainingCapacity")}</span>
                      <strong>{formatNativeCompact(tokenSnapshot.remainingQuoteCapacity)}</strong>
                      <div className="metric-subtle">{t("graduationTarget")}</div>
                    </div>
                  </div>

                  <article className="subpanel chart-hero-panel">
                    <div className="subpanel-header">
                      <h3>{t("priceTrajectory")}</h3>
                      <span className="list-item-meta">
                        {t("marketCap")}: {displayedMarketCapUsd ? formatUsdCompact(displayedMarketCapUsd) : t("marketCapUnavailable")}
                      </span>
                    </div>
                    {bondingCandles.length > 0 || dexCandles.length > 0 ? (
                      <SegmentedPhaseChart bondingCandles={bondingCandles} dexCandles={dexCandles} graduationTimestampMs={graduationTimestampMs} />
                    ) : (
                      <div className="empty-state">{t("noChartData")}</div>
                    )}
                  </article>

                  <div className="headline-metrics">
                    <div>
                      <span className="metric-label">{t("currentPrice")}</span>
                      <strong>{displayedPriceUsd ? formatUsdMicroPrice(displayedPriceUsd) : t("usdUnavailable")}</strong>
                      <div className="metric-subtle">{t("priceUsdUnitNotice")}</div>
                    </div>
                    <div>
                      <span className="metric-label">{t("marketCapShort")}</span>
                      <strong>{displayedMarketCapUsd ? formatUsdCompact(displayedMarketCapUsd) : t("marketCapUnavailable")}</strong>
                      <div className="metric-subtle">{t("marketCapQuoteNotice")}</div>
                    </div>
                    <div>
                      <span className="metric-label">{t("raisedLabel")}</span>
                      <strong>{formatNativeCompact(heroRaised)}</strong>
                      <div className="metric-subtle">{tf("raisedAgainstTarget", { raised: formatNativeCompact(heroRaised), target: formatNativeCompact(tokenSnapshot.graduationQuoteReserve) })}</div>
                    </div>
                    <div>
                      <span className="metric-label">{t("remainingCapacity")}</span>
                      <strong>{formatNativeCompact(tokenSnapshot.remainingQuoteCapacity)}</strong>
                      <div className="metric-subtle">{t("graduationTarget")}</div>
                    </div>
                  </div>

                  {dexPairEnrichment && (
                    <div className="dex-metrics-strip">
                      <div className="dex-metric-card">
                        <span className="metric-label">{t("liquidity")}</span>
                        <strong>{formatUsdCompact(dexPairEnrichment.liquidityUsd)}</strong>
                      </div>
                      <div className="dex-metric-card">
                        <span className="metric-label">{t("volume24h")}</span>
                        <strong>{formatUsdCompact(dexPairEnrichment.volume24hUsd)}</strong>
                      </div>
                      <div className="dex-metric-card">
                        <span className="metric-label">{t("txns24h")}</span>
                        <strong>
                          {dexPairEnrichment.buys24h !== null || dexPairEnrichment.sells24h !== null
                            ? `${dexPairEnrichment.buys24h ?? 0}/${dexPairEnrichment.sells24h ?? 0}`
                            : "—"}
                        </strong>
                        <div className="metric-subtle">{t("buysSellsShort")}</div>
                      </div>
                      <div className="dex-metric-card">
                        <span className="metric-label">{t("fdv")}</span>
                        <strong>{formatUsdCompact(dexPairEnrichment.fdvUsd)}</strong>
                        {dexPairEnrichment.url ? (
                          <a className="inline-link" href={dexPairEnrichment.url} target="_blank" rel="noreferrer">
                            {t("viewOnDex")}
                          </a>
                        ) : null}
                      </div>
                    </div>
                  )}

                  <div className="progress-shell" aria-hidden="true">
                    <div className="progress-fill" style={{ width: `${Math.min(100, Number(tokenSnapshot.graduationProgressBps) / 100)}%` }} />
                  </div>

                  <div className="lifecycle-row">
                    <div className={`lifecycle-step ${tokenSnapshot.state === "Created" ? "current" : "done"}`}>{t("stateCreated")}</div>
                    <div className={`lifecycle-step ${isWhitelistCommit ? "current" : tokenSnapshot.whitelistStatus > 0n ? "done" : ""}`}>{t("stateWhitelist")}</div>
                    <div className={`lifecycle-step ${isBonding ? "current" : isMigrating || isDexOnly ? "done" : ""}`}>{t("stateBonding")}</div>
                    <div className={`lifecycle-step ${isMigrating ? "current" : isDexOnly ? "done" : ""}`}>{t("stateMigrating")}</div>
                    <div className={`lifecycle-step ${isDexOnly ? "current" : ""}`}>{t("stateDexOnly")}</div>
                  </div>

                  {tokenVerification && tokenVerification.status !== "official" && (
                    <div className={`callout compact-callout ${verificationTone}`}>
                      <strong>{verificationLabel}</strong>
                      <p>{tokenVerification.summary}</p>
                      <details className="verification-details">
                        <summary>{t("verificationDetails")}</summary>
                        <dl className="data-list compact">
                          <div><dt>{t("factoryMatch")}</dt><dd>{String(tokenVerification.checks.factoryMatches)}</dd></div>
                          <div><dt>{t("factoryRegistry")}</dt><dd>{String(tokenVerification.checks.factoryRegistryRecognizesToken)}</dd></div>
                          <div><dt>{t("modeMatch")}</dt><dd>{String(tokenVerification.checks.tokenModeMatchesFactory)}</dd></div>
                          <div><dt>{t("launchEventFound")}</dt><dd>{String(tokenVerification.checks.launchEventFound)}</dd></div>
                          <div><dt>{t("eventMetadata")}</dt><dd>{String(tokenVerification.checks.eventMetadataMatchesToken)}</dd></div>
                          <div><dt>{t("protocolRecipientMatch")}</dt><dd>{String(tokenVerification.checks.protocolRecipientMatches)}</dd></div>
                          <div><dt>{t("routerMatch")}</dt><dd>{String(tokenVerification.checks.routerMatches)}</dd></div>
                          <div><dt>{t("gradTargetMatch")}</dt><dd>{String(tokenVerification.checks.graduationTargetMatches)}</dd></div>
                          <div><dt>{t("pairMatch")}</dt><dd>{String(tokenVerification.checks.pairMatchesDex)}</dd></div>
                          <div><dt>{t("suffixMode")}</dt><dd>{String(tokenVerification.checks.suffixMatchesMode)}</dd></div>
                        </dl>
                      </details>
                    </div>
                  )}

                  <div className={`callout ${pollutionTone}`}>
                    <strong>{t("gradCompatibility")}</strong>
                    <p>
                      {tokenSnapshot.pairClean
                        ? t("gradClean")
                        : tokenSnapshot.pairGraduationCompatible
                          ? t("gradPreloaded")
                          : t("gradBlocked")}
                    </p>
                  </div>

                  {creatorFeeSweepReady && isBonding && (
                    <div className="callout warn">
                      <strong>{t("abandonedSweep")}</strong>
                      <p>{t("abandonedSweepDesc")}</p>
                    </div>
                  )}

                  <div className="content-tabs">
                    <button
                      type="button"
                      className={`content-tab ${launchInfoTab === "activity" ? "active" : ""}`}
                      onClick={() => setLaunchInfoTab("activity")}
                    >
                      {t("recentActivity")}
                    </button>
                    <button
                      type="button"
                      className={`content-tab ${launchInfoTab === "details" ? "active" : ""}`}
                      onClick={() => setLaunchInfoTab("details")}
                    >
                      {t("detailsTab")}
                    </button>
                  </div>

                  {launchInfoTab === "activity" ? (
                    <div className="history-grid single-column-activity">
                      <article className="subpanel">
                        <div className="subpanel-header">
                          <h3>{t("recentActivity")}</h3>
                          <span className="list-item-meta">{recentActivity.length} {t("events")}</span>
                        </div>
                        {recentActivity.length === 0 ? (
                          <div className="empty-state">{t("noActivity")}</div>
                        ) : (
                          <div className="trade-list">
                            {recentActivity.map((activity) => (
                              <div
                                key={`${activity.txHash}-${activity.blockNumber.toString()}-${activity.logIndex}`}
                                className={`trade-row ${activityTone(activity)}`}
                              >
                                <div className="trade-row-main">
                                  <div className="trade-row-head">
                                    <strong>{activityLabel(activity)}</strong>
                                    <div className="trade-badges">
                                      <span className="trade-badge">{activityPhaseLabel(activity)}</span>
                                      <span className="trade-badge subtle">{shortAddress(activity.txHash)}</span>
                                    </div>
                                  </div>
                                  <div className="trade-meta">{formatDateTime(activity.timestampMs)}</div>
                                </div>
                                <div className="trade-row-value">
                                  {activity.kind === "graduated" ? (
                                    <>
                                      <strong>{formatNative(activity.quoteAmountContributed)}</strong>
                                      <div className="trade-meta">
                                        {t("lpSeed")} · {formatToken(activity.tokenAmount)} {t("tokenUnit")}
                                      </div>
                                      <div className="trade-meta">
                                        {shortAddress(activity.marketAddress)}
                                        {activity.preloadedQuoteAmount > 0n ? ` · + ${formatNative(activity.preloadedQuoteAmount)} ${t("preload")}` : ""}
                                      </div>
                                    </>
                                  ) : (
                                    <>
                                      <strong>{formatNative(activity.netQuote)}</strong>
                                      <div className="trade-meta">{formatToken(activity.tokenAmount)} {t("tokenUnit")}</div>
                                      <div className="trade-meta">{formatNative(activity.priceQuotePerToken)}</div>
                                    </>
                                  )}
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </article>
                    </div>
                  ) : (
                    <div className="detail-grid">
                      <dl className="data-list">
                        <div><dt>{t("tokenAddressLabel")}</dt><dd>{tokenSnapshot.address}</dd></div>
                        <div><dt>{t("mode")}</dt><dd>{launchModeLabel(tokenSnapshot.launchMode)}</dd></div>
                        <div><dt>{t("suffix")}</dt><dd>{tokenSnapshot.launchSuffix}</dd></div>
                        <div><dt>{t("metadataUriLabel")}</dt><dd>{tokenSnapshot.metadataURI}</dd></div>
                        <div><dt>{t("gradTarget")}</dt><dd>{formatNative(tokenSnapshot.graduationQuoteReserve)}</dd></div>
                        <div><dt>{t("pair")}</dt><dd>{tokenSnapshot.pair}</dd></div>
                        <div><dt>{t("pairClean")}</dt><dd>{String(tokenSnapshot.pairClean)}</dd></div>
                        <div><dt>{t("gradCompatible")}</dt><dd>{String(tokenSnapshot.pairGraduationCompatible)}</dd></div>
                        <div><dt>{t("preloadedQuote")}</dt><dd>{formatNative(tokenSnapshot.pairPreloadedQuote)}</dd></div>
                        {tokenSnapshot.whitelistSnapshot && (
                          <>
                            <div><dt>{t("wlThresholdLabel")}</dt><dd>{formatNative(tokenSnapshot.whitelistSnapshot.threshold)}</dd></div>
                            <div><dt>{t("wlSeatSizeLabel")}</dt><dd>{formatNative(tokenSnapshot.whitelistSnapshot.slotSize)}</dd></div>
                            <div><dt>{t("wlSeats")}</dt><dd>{tokenSnapshot.whitelistSnapshot.seatCount.toString()}</dd></div>
                            <div><dt>{t("wlFilled")}</dt><dd>{tokenSnapshot.whitelistSnapshot.seatsFilled.toString()}</dd></div>
                          </>
                        )}
                        {tokenSnapshot.taxConfig && (
                          <>
                            <div><dt>{t("taxActive")}</dt><dd>{String(tokenSnapshot.taxConfig.active)}</dd></div>
                            <div><dt>{t("configuredTax")}</dt><dd>{formatPercentFromBps(tokenSnapshot.taxConfig.configuredTaxBps)}</dd></div>
                            <div><dt>{t("burnShareLabel")}</dt><dd>{formatPercentFromBps(tokenSnapshot.taxConfig.burnBps)}</dd></div>
                            <div><dt>{t("treasuryShareLabel")}</dt><dd>{formatPercentFromBps(tokenSnapshot.taxConfig.treasuryBps)}</dd></div>
                            <div><dt>{t("treasuryWalletLabel")}</dt><dd className="address-value"><span className="mono-address">{tokenSnapshot.taxConfig.wallet}</span><button type="button" className="copy-chip" onClick={() => void handleCopyText(tokenSnapshot.taxConfig!.wallet, t("treasuryWalletLabel"))}>{t("copyAddress")}</button></dd></div>
                          </>
                        )}
                      </dl>

                      <dl className="data-list">
                        <div><dt>{t("protocolClaimable")}</dt><dd>{formatNative(tokenSnapshot.protocolClaimable)}</dd></div>
                        <div><dt>{t("creatorClaimable")}</dt><dd>{formatNative(tokenSnapshot.creatorClaimable)}</dd></div>
                        <div><dt>{t("tokenProtocolRecipient")}</dt><dd className="address-value"><span className="mono-address">{tokenSnapshot.protocolFeeRecipient}</span><button type="button" className="copy-chip" onClick={() => void handleCopyText(tokenSnapshot.protocolFeeRecipient, t("tokenProtocolRecipient"))}>{t("copyAddress")}</button></dd></div>
                        <div><dt>{t("creatorFeeSweepReady")}</dt><dd>{creatorFeeSweepReady ? t("yes") : t("no")}</dd></div>
                        <div><dt>{t("createdAt")}</dt><dd>{formatUnixTimestamp(tokenSnapshot.createdAt)}</dd></div>
                        <div><dt>{t("lastTradeAt")}</dt><dd>{formatUnixTimestamp(tokenSnapshot.lastTradeAt)}</dd></div>
                        <div><dt>{t("dexTokenReserve")}</dt><dd>{formatToken(tokenSnapshot.dexTokenReserve)}</dd></div>
                        <div><dt>{t("dexQuoteReserve")}</dt><dd>{formatNative(tokenSnapshot.dexQuoteReserve)}</dd></div>
                        <div><dt>{t("connectedAsCreator")}</dt><dd>{connectedAsCreator ? t("yes") : t("no")}</dd></div>
                        <div><dt>{t("statusMessage")}</dt><dd>{status}</dd></div>
                      </dl>
                    </div>
                  )}
                </>
              ) : (
                <div className="empty-state">{t("loadWorkspace")}</div>
              )}
            </article>
          </section>

          <aside className="actions-rail">
            <article className="panel" id="trade-panel">
              {isWhitelistCommit && whitelistSnapshot ? (
                <>
                  <h2>{t("wlCommitTitle")}</h2>
                  <div className="trade-contract-bar">
                    <div>
                      <span className="metric-label">{t("tokenAddressLabel")}</span>
                      <strong>{shortAddress(tokenSnapshot?.address || tokenAddress)}</strong>
                    </div>
                    <button
                      type="button"
                      className="copy-chip"
                      onClick={() => void handleCopyText(tokenSnapshot?.address || tokenAddress, t("tokenAddressLabel"))}
                    >
                      {t("copyContract")}
                    </button>
                  </div>
                  <div className="trade-estimate-card whitelist-estimate-card">
                    <span className="metric-label">{t("wlSeatSummaryLabel")}</span>
                    <strong>{formatNative(whitelistSnapshot.slotSize)}</strong>
                    <div className="metric-subtle">{whitelistApproved ? t("wlApproved") : t("wlNotApproved")}</div>
                  </div>
                  <div className="create-summary-grid compact whitelist-summary-grid">
                    <div><span>{t("mode")}</span><strong>{tokenSnapshot?.launchSuffix || "b314"}</strong></div>
                    <div><span>{t("wlFilledShort")}</span><strong>{whitelistSeatsFilled.toString()}</strong></div>
                    <div><span>{t("wlRemainingShort")}</span><strong>{whitelistSeatsRemaining.toString()}</strong></div>
                    <div><span>{t("wlSeatSizeShort")}</span><strong>{formatNative(whitelistSnapshot.slotSize)}</strong></div>
                  </div>
                  <div className="trade-hint-card">
                    <strong>{t("wlDirectTransferTitle")}</strong>
                    <p>{tf("wlDirectTransferBody", { amount: formatNative(whitelistSnapshot.slotSize) })}</p>
                  </div>
                  <div className="button-row stacked">
                    <button onClick={handleWhitelistCommit} disabled={!canCommitWhitelist || walletWrongNetwork || !canWriteVerifiedLaunch}>
                      {t("commitSeat")}
                    </button>
                  </div>
                  <details className="trade-advanced">
                    <summary>{t("advancedWhitelistActions")}</summary>
                    <div className="trade-advanced-body">
                      <div className={`callout ${whitelistApproved ? "success" : "warn"} compact-callout`}>
                        <strong>{whitelistApproved ? t("wlApproved") : t("wlNotApproved")}</strong>
                        <p>{t("wlCommitExplain")}</p>
                      </div>
                      <div className="button-row stacked compact-actions">
                        <button
                          className="secondary-button"
                          onClick={handleClaimWhitelistAllocation}
                          disabled={!canClaimWhitelistAllocationForWallet || walletWrongNetwork || !canWriteVerifiedLaunch}
                        >
                          {t("claimAllocation")}
                        </button>
                        <button
                          className="secondary-button"
                          onClick={handleClaimWhitelistRefund}
                          disabled={!canClaimWhitelistRefundForWallet || walletWrongNetwork || !canWriteVerifiedLaunch}
                        >
                          {t("claimRefund")}
                        </button>
                      </div>
                    </div>
                  </details>
                </>
              ) : (
                <>
                  <h2>{t("bondingActions")}</h2>
                  <div className="trade-contract-bar">
                    <div>
                      <span className="metric-label">{t("tokenAddressLabel")}</span>
                      <strong>{shortAddress(tokenSnapshot?.address || tokenAddress)}</strong>
                    </div>
                    <button
                      type="button"
                      className="copy-chip"
                      onClick={() => void handleCopyText(tokenSnapshot?.address || tokenAddress, t("tokenAddressLabel"))}
                    >
                      {t("copyContract")}
                    </button>
                  </div>
                  <div className="trade-side-tabs">
                    <button
                      type="button"
                      className={`trade-side-tab ${tradeSide === "buy" ? "active" : ""}`}
                      onClick={() => setTradeSide("buy")}
                    >
                      {t("tradeModeBuy")}
                    </button>
                    <button
                      type="button"
                      className={`trade-side-tab ${tradeSide === "sell" ? "active" : ""}`}
                      onClick={() => setTradeSide("sell")}
                    >
                      {t("tradeModeSell")}
                    </button>
                  </div>
                  {tradeSide === "buy" ? (
                    <>
                      <div className="trade-hint-card">
                        <strong>{t("directTransferBuyTitle")}</strong>
                        <p>{t("directTransferBuyBody")}</p>
                      </div>
                      <label className="field">
                        <span>{`${t("buyAmount")} (${activeProtocolProfile.nativeSymbol})`}</span>
                        <input value={buyInput} inputMode="decimal" onChange={(e) => setBuyInput(e.target.value)} />
                        <small className="field-note">
                          {buyPreviewState
                            ? tf("estimatedTokenOut", { amount: formatToken(buyPreviewState.tokenOut) })
                            : t("marketPreviewPending")}
                        </small>
                      </label>
                      <div className="quick-amount-row">
                        {[0.1, 0.5, 1, 3].map((amount) => (
                          <button
                            type="button"
                            key={`buy-${amount}`}
                            className="quick-amount-chip"
                            onClick={() => setBuyInput(String(amount))}
                          >
                            {amount} {activeProtocolProfile.nativeSymbol}
                          </button>
                        ))}
                      </div>
                      <div className="trade-estimate-card">
                        <span className="metric-label">{t("estimatedReceiveLabel")}</span>
                        <strong>{buyPreviewState ? formatToken(buyPreviewState.tokenOut) : "—"}</strong>
                        <div className="metric-subtle">
                          {buyPreviewState
                            ? tf("buyMinOutInline", { amount: formatToken(applySlippageBps(buyPreviewState.tokenOut, slippageToleranceBps)) })
                            : t("marketPreviewPending")}
                        </div>
                      </div>
                    </>
                  ) : (
                    <>
                      <label className="field">
                        <span>{t("sellAmount")}</span>
                        <input value={sellInput} onChange={(e) => setSellInput(e.target.value)} />
                      </label>
                      <div className="trade-estimate-card">
                        <span className="metric-label">{t("estimatedReceiveLabel")}</span>
                        <strong>{sellPreviewState ? formatNative(sellPreviewState.netQuoteOut) : "—"}</strong>
                        <div className="metric-subtle">
                          {sellPreviewState
                            ? tf("sellMinOutInline", { amount: formatNative(applySlippageBps(sellPreviewState.netQuoteOut, slippageToleranceBps)) })
                            : t("marketPreviewPending")}
                        </div>
                      </div>
                    </>
                  )}
                  <div className="button-row stacked">
                    {tradeSide === "buy" ? (
                      <button onClick={handleExecuteBuy} disabled={!isBonding || walletWrongNetwork || !canWriteVerifiedLaunch}>{t("executeBuy")}</button>
                    ) : (
                      <button onClick={handleExecuteSell} disabled={!isBonding || walletWrongNetwork || !canWriteVerifiedLaunch}>{t("executeSell")}</button>
                    )}
                  </div>
                  <details className="trade-advanced">
                    <summary>{t("advancedTradeSettings")}</summary>
                    <div className="trade-advanced-body">
                      <label className="field">
                        <span>{t("slippage")}</span>
                        <input value={slippagePercent} inputMode="decimal" onChange={(e) => setSlippagePercent(e.target.value)} />
                        <small className="field-note">{tf("slippageHint", { percent: formatPercentInput(slippagePercent), bps: slippageToleranceBps.toString() })}</small>
                      </label>
                      <div className="button-row stacked compact-actions">
                        {tradeSide === "buy" ? (
                          <button className="secondary-button" onClick={handlePreviewBuy} disabled={!tokenAddress || !isBonding || !canWriteVerifiedLaunch}>{t("previewBuy")}</button>
                        ) : (
                          <button className="secondary-button" onClick={handlePreviewSell} disabled={!tokenAddress || !isBonding || !canWriteVerifiedLaunch}>{t("previewSell")}</button>
                        )}
                      </div>
                      {tradeSide === "buy" && buyPreviewState && (
                        <dl className="data-list compact">
                          <div><dt>{t("buyTokenOut")}</dt><dd>{formatToken(buyPreviewState.tokenOut)}</dd></div>
                          <div><dt>{t("buyFee")}</dt><dd>{formatNative(buyPreviewState.feeAmount)}</dd></div>
                          <div><dt>{t("buyRefund")}</dt><dd>{formatNative(buyPreviewState.refundAmount)}</dd></div>
                          <div><dt>{t("buyMinOut")}</dt><dd>{formatToken(applySlippageBps(buyPreviewState.tokenOut, slippageToleranceBps))}</dd></div>
                        </dl>
                      )}

                      {tradeSide === "sell" && sellPreviewState && (
                        <dl className="data-list compact">
                          <div><dt>{t("sellGrossOut")}</dt><dd>{formatNative(sellPreviewState.grossQuoteOut)}</dd></div>
                          <div><dt>{t("sellNetOut")}</dt><dd>{formatNative(sellPreviewState.netQuoteOut)}</dd></div>
                          <div><dt>{t("sellFee")}</dt><dd>{formatNative(sellPreviewState.totalFee)}</dd></div>
                          <div><dt>{t("sellMinOut")}</dt><dd>{formatNative(applySlippageBps(sellPreviewState.netQuoteOut, slippageToleranceBps))}</dd></div>
                        </dl>
                      )}
                    </div>
                  </details>
                </>
              )}
            </article>

            <article className="panel">
              <h2>{t('claimsTitle')}</h2>
              <div className="button-row stacked">
                <button
                  className="secondary-button"
                  onClick={handleClaimTokenProtocolFees}
                  disabled={!tokenSnapshot || !connectedAsTokenProtocolRecipient || walletWrongNetwork || !canWriteVerifiedLaunch}
                >
                  {t('claimTokenProtocol')}
                </button>
                <button className="secondary-button" onClick={handleClaimCreatorFees} disabled={!isDexOnly || !connectedAsCreator || walletWrongNetwork || !canWriteVerifiedLaunch}>
                  {t('claimCreatorFees')}
                </button>
                <button className="secondary-button" onClick={handleSweepCreatorFees} disabled={!tokenSnapshot || !creatorFeeSweepReady || walletWrongNetwork || !canWriteVerifiedLaunch}>
                  {t('sweepCreatorFees')}
                </button>
              </div>
              <ul className="compact-list">
                <li>{t('claimsNote1')}</li>
                <li>{t('claimsNote2')}</li>
                <li>{t('claimsNote3')}</li>
                <li>{t('claimsNote4')}</li>
                <li>{t('claimsNote5')}</li>
              </ul>
              <div className="status-hint">
                {t('factoryClaimNote')}
              </div>
            </article>
          </aside>
        </section>
      )}

      {route.page === "creator" && (
        <section className="creator-grid">
          <aside className="creator-summary panel">
            <span className="section-kicker">{t('creatorDashKicker')}</span>
            <h2>{t('creatorDashTitle')}</h2>
            <p>{t('creatorDashDesc')}</p>

            {wallet ? (
              <>
                <div className="creator-stat-grid">
                  <div>
                    <span className="metric-label">{t('totalLaunches')}</span>
                    <strong>{creatorLaunches.length}</strong>
                  </div>
                  <div>
                    <span className="metric-label">{t('totalClaimable')}</span>
                    <strong>
                      {creatorLaunches.length > 0
                        ? formatNative(creatorLaunches.reduce((sum: bigint, l: TokenSnapshot) => sum + l.creatorClaimable, 0n))
                        : "0"}
                    </strong>
                  </div>
                </div>
                <div className="button-row stacked">
                  <button className="secondary-button" onClick={handleLoadFactory}>{t('loadFactoryBtn')}</button>
                </div>
              </>
            ) : (
              <div className="empty-state" style={{ marginTop: 16 }}>{t('connectToView')}</div>
            )}
          </aside>

          <section className="workspace-main">
            {!wallet ? (
              <div className="empty-state panel">{t('connectToView')}</div>
            ) : creatorLaunches.length === 0 ? (
              <div className="empty-state panel">{t('noCreatorLaunches')}</div>
            ) : (
              <div className="creator-token-list">
                {creatorLaunches.map((launch) => {
                  const meta = launchMetadataByToken[launch.address.toLowerCase()] ?? null;
                  return (
                    <article key={launch.address} className="creator-token-card">
                      <div className="creator-token-info">
                        <strong>{meta?.name || launch.name} ({meta?.symbol || launch.symbol})</strong>
                        <div className="token-meta">
                          <span className={`mode-suffix-badge ${launch.launchSuffix?.startsWith('b') || launch.launchSuffix?.startsWith('f') ? 'whitelist' : launch.launchSuffix?.match(/^[1-9]/) ? 'taxed' : 'standard'}`}>
                            {launch.launchSuffix || "0314"}
                          </span>
                          <span className={`stage-pill ${launch.state === 'Bonding314' ? 'live' : launch.state === 'DEXOnly' ? 'done' : ''}`}>
                            {launchStateLabel(launch.state)}
                          </span>
                          <span>{formatPercentFromBps(launch.graduationProgressBps)} {t('progress').toLowerCase()}</span>
                        </div>
                        <div className="token-meta">
                          <span>{t('currentPrice')}: {formatNative(launch.currentPriceQuotePerToken)}</span>
                          <span>{t('creatorClaimable')}: {formatNative(launch.creatorClaimable)}</span>
                        </div>
                      </div>
                      <div className="creator-token-actions">
                        <button
                          className="secondary-button"
                          onClick={() => {
                            setTokenAddress(launch.address);
                            navigate({ page: "launch", token: launch.address });
                            void handleSelectLaunch(launch.address);
                          }}
                        >
                          {t('viewLaunch')}
                        </button>
                        <button
                          onClick={() => {
                            setTokenAddress(launch.address);
                            void handleClaimCreatorFees();
                          }}
                          disabled={launch.state !== "DEXOnly" || launch.creatorClaimable === 0n || walletWrongNetwork}
                        >
                          {t('claimBtn')}
                        </button>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </section>
        </section>
      )}

      <footer className="app-footer">
        <div className="footer-brand">
          <img className="footer-brand-mark" src={BRAND_FULL_URL} alt="Autonomous 314" />
          <span>Autonomous 314 Protocol · {t('openSource')}</span>
        </div>
        <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
          <a href={REPO_URL} target="_blank" rel="noreferrer">{t('repoLink')}</a>
          <button className="lang-toggle" onClick={toggleLocale}>{locale === "en" ? t("footerLangZh") : t("footerLangEn")}</button>
        </div>
      </footer>


      {showCreateConfirm && (
        <div className="modal-overlay" onClick={() => setShowCreateConfirm(false)}>
          <div className="confirm-dialog panel" onClick={(event) => event.stopPropagation()}>
            <div className="confirm-dialog-head">
              <div>
                <span className="section-kicker">{t("createConfirmKicker")}</span>
                <h3>{t("createConfirmTitle")}</h3>
              </div>
              <span className="status-pill warn">{selectedLaunchFamily.suffix}</span>
            </div>
            <p className="confirm-dialog-copy">{t("createConfirmDesc")}</p>

            <div className="create-summary-grid confirm-grid">
              <div><span>{t("summaryMode")}</span><strong>{selectedLaunchFamily.title}</strong></div>
              <div><span>{t("summaryVanity")}</span><strong>{selectedLaunchFamily.suffix}</strong></div>
              <div><span>{t("summaryFee")}</span><strong>{selectedCreateFee > 0n ? formatNative(selectedCreateFee) : t("loadFactory")}</strong></div>
              <div><span>{t("summaryCreatorFlow")}</span><strong>{requiresAtomicBuy ? (createAtomicBuyEnabled ? t("summaryAtomicBuy") : t("summaryManualBuy")) : isDelayedWhitelistOpen ? t("summaryScheduledSeat") : t("summaryAtomicSeat")}</strong></div>
              <div><span>{t("createConfirmCreator")}</span><strong>{wallet ? shortAddress(wallet) : t("connectWallet")}</strong></div>
              <div><span>{t("summaryGraduation")}</span><strong>{factorySnapshot ? formatNative(factorySnapshot.graduationQuoteReserve) : `12 ${activeProtocolProfile.nativeSymbol}`}</strong></div>
            </div>

            <div className="confirm-section">
              <span className="section-kicker">{t("createConfirmTokenKicker")}</span>
              <div className="confirm-token-grid">
                <div><span>{t("tokenName")}</span><strong>{createName || "—"}</strong></div>
                <div><span>{t("tokenSymbol")}</span><strong>{createSymbol || "—"}</strong></div>
                <div className="confirm-span-two"><span>{t("metadataUri")}</span><strong className="mono-address">{createMetadataUri.trim() || generatedInlineMetadataUri || "—"}</strong></div>
              </div>
            </div>

            {requiresAtomicBuy && createAtomicBuyEnabled && (
              <div className="confirm-section">
                <span className="section-kicker">{t("createConfirmCreatorActionKicker")}</span>
                <div className="confirm-token-grid">
                  <div><span>{t("atomicBuyAmount")}</span><strong>{createAtomicBuyAmount || "0"} {activeProtocolProfile.nativeSymbol}</strong></div>
                  <div><span>{t("creatorEstimateLabel")}</span><strong>{createAtomicBuyPreviewLabel}</strong></div>
                </div>
              </div>
            )}

            {requiresWhitelistCommit && (
              <div className="confirm-section">
                <span className="section-kicker">{t("wlKicker")}</span>
                <div className="confirm-token-grid">
                  <div><span>{t("wlThreshold")}</span><strong>{createWhitelistThreshold} {activeProtocolProfile.nativeSymbol}</strong></div>
                  <div><span>{t("wlSlotSize")}</span><strong>{createWhitelistSlotSize} {activeProtocolProfile.nativeSymbol}</strong></div>
                  <div><span>{t("wlSeatTarget")}</span><strong>{whitelistSeatTarget || "—"}</strong></div>
                  <div><span>{t("wlAddressCount")}</span><strong>{whitelistAddressCount}</strong></div>
                  <div><span>{t("wlOpenTime")}</span><strong>{isDelayedWhitelistOpen ? createWhitelistOpensAt : t("wlStartsImmediately")}</strong></div>
                  <div><span>{t("wlTimezoneLabel")}</span><strong>{isDelayedWhitelistOpen ? whitelistLocalTimezone : t("wlImmediateLabel")}</strong></div>
                  {isDelayedWhitelistOpen ? (
                    <div className="confirm-span-two"><span>{t("wlUtcPreviewLabel")}</span><strong>{whitelistOpensAtUtcText}</strong></div>
                  ) : null}
                </div>
              </div>
            )}

            {isTaxedFamily && (
              <div className="confirm-section">
                <span className="section-kicker">{t("taxKicker")}</span>
                <div className="confirm-token-grid">
                  <div><span>{t("taxRate")}</span><strong>{taxRatePercent}%</strong></div>
                  <div><span>{t("burnShare")}</span><strong>{burnSharePercent}%</strong></div>
                  <div><span>{t("treasuryShare")}</span><strong>{treasurySharePercent}%</strong></div>
                  <div className="confirm-span-two"><span>{t("treasuryWalletLabel")}</span><strong className="mono-address">{createTreasuryWalletResolved || "—"}</strong></div>
                </div>
              </div>
            )}

            <div className="callout warn compact-callout">
              <strong>{t("createConfirmNoteTitle")}</strong>
              <p>{t("createConfirmNoteDesc")}</p>
            </div>

            <div className="button-row confirm-actions">
              <button type="button" className="secondary-button" onClick={() => setShowCreateConfirm(false)}>
                {t("cancel")}
              </button>
              <button type="button" onClick={() => void handleConfirmCreateLaunch()} disabled={loading}>
                {loading ? t("loading") : t("createConfirmProceed")}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
