import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { getAddress, parseEther } from "viem";
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
  verifyOfficialLaunch
} from "./protocol";
import type { ActivityFeedItem, CandlePoint, FactorySnapshot, LaunchMetadata, ProtocolVerification, TokenSnapshot } from "./types";
import type { LaunchCreationFamily } from "./types";
import { SegmentedPhaseChart } from "./charts";
import { activeProtocolProfile } from "./profiles";

const REPO_URL = "https://github.com/autonomous314/launch-protocol";

function useLocale(): Locale {
  return useSyncExternalStore(onLocaleChange, getLocale, getLocale);
}

type BuyPreview = Awaited<ReturnType<typeof previewBuy>>;
type SellPreview = Awaited<ReturnType<typeof previewSell>>;
type AppRoute = { page: "home" } | { page: "create" } | { page: "launch"; token: string } | { page: "creator" };

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

function shortAddress(value: string) {
  if (!value) return "—";
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

function formatPercentFromBps(value: bigint) {
  return `${(Number(value) / 100).toFixed(2)}%`;
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

export function App() {
  const [route, setRoute] = useState<AppRoute>(() => parseRoute(window.location.pathname));
  const [wallet, setWallet] = useState<string>("");
  const [factoryAddress, setFactoryAddress] = useState(import.meta.env.VITE_FACTORY_ADDRESS ?? "");
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
  const [createMetadataUri, setCreateMetadataUri] = useState("");
  const [createAtomicBuyAmount, setCreateAtomicBuyAmount] = useState("1");
  const [createWhitelistThreshold, setCreateWhitelistThreshold] = useState("4");
  const [createWhitelistSlotSize, setCreateWhitelistSlotSize] = useState("0.2");
  const [createWhitelistAddresses, setCreateWhitelistAddresses] = useState("");
  const [createTaxBps, setCreateTaxBps] = useState("1");
  const [createTaxBurnShareBps, setCreateTaxBurnShareBps] = useState("5000");
  const [createTaxTreasuryShareBps, setCreateTaxTreasuryShareBps] = useState("5000");
  const [createTaxTreasuryWallet, setCreateTaxTreasuryWallet] = useState(import.meta.env.VITE_DEFAULT_TREASURY ?? "");
  const [factorySnapshot, setFactorySnapshot] = useState<FactorySnapshot | null>(null);
  const [recentLaunchSnapshots, setRecentLaunchSnapshots] = useState<TokenSnapshot[]>([]);
  const [tokenSnapshot, setTokenSnapshot] = useState<TokenSnapshot | null>(null);
  const [tokenVerification, setTokenVerification] = useState<ProtocolVerification | null>(null);
  const [launchMetadataByToken, setLaunchMetadataByToken] = useState<Partial<Record<string, LaunchMetadata | null>>>({});
  const [marketQuery, setMarketQuery] = useState("");
  const [contractSearchInput, setContractSearchInput] = useState("");
  const [recentActivity, setRecentActivity] = useState<ActivityFeedItem[]>([]);
  const [bondingCandles, setBondingCandles] = useState<CandlePoint[]>([]);
  const [dexCandles, setDexCandles] = useState<CandlePoint[]>([]);
  const [graduationTimestampMs, setGraduationTimestampMs] = useState<number | null>(null);
  const [buyInput, setBuyInput] = useState("1");
  const [sellInput, setSellInput] = useState("1");
  const [slippageBps, setSlippageBps] = useState("300");
  const [buyPreviewState, setBuyPreviewState] = useState<BuyPreview | null>(null);
  const [sellPreviewState, setSellPreviewState] = useState<SellPreview | null>(null);
  const [status, setStatus] = useState<string>(() => t("ready"));
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
  const verificationTone = useMemo(() => {
    if (!tokenVerification) return "neutral";
    if (tokenVerification.status === "official") return "success";
    if (tokenVerification.status === "warning") return "warn";
    return "danger";
  }, [tokenVerification]);
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
  const whitelistSeatTarget =
    isWhitelistFamily && whitelistThresholdValue > 0 && whitelistSlotValue > 0
      ? Math.round(whitelistThresholdValue / whitelistSlotValue)
      : 0;
  const whitelistAddressCount = parsedWhitelistAddresses?.length ?? 0;
  const requiresAtomicBuy = createMode === "standard" || createMode === "taxed";
  const requiresWhitelistCommit = createMode === "whitelist" || createMode === "whitelistTaxed";
  const whitelistAddressCountValid =
    !requiresWhitelistCommit || (parsedWhitelistAddresses !== null && whitelistAddressCount >= whitelistSeatTarget && whitelistSeatTarget > 0);
  const factorySupportsWhitelistMode = factorySnapshot?.supportsWhitelistMode ?? false;
  const factorySupportsTaxedMode = factorySnapshot?.supportsTaxedMode ?? false;
  const factorySupportsWhitelistTaxedMode = factorySnapshot?.supportsWhitelistTaxedMode ?? false;
  const selectedCreateFee =
    isWhitelistFamily
      ? factorySnapshot?.whitelistCreateFee ?? 0n
      : factorySnapshot?.standardCreateFee ?? factorySnapshot?.createFee ?? 0n;
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
        status: "factory" as const,
        eyebrow: t("modeB314Eyebrow"),
        description: t("modeB314Desc"),
        operations: ta("modeB314Points")
      },
      {
        suffix: "1314–9314",
        title: t("modeTaxTitle"),
        status: "planned" as const,
        eyebrow: t("modeTaxEyebrow"),
        description: t("modeTaxDesc"),
        operations: ta("modeTaxPoints")
      },
      {
        suffix: "f314",
        title: t("modeF314Title"),
        status: "planned" as const,
        eyebrow: t("modeF314Eyebrow"),
        description: t("modeF314Desc"),
        operations: ta("modeF314Points")
      }
    ],
    [locale]
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
  const visibleLaunchFamilies = launchFamilies.map((family) =>
    family.suffix === "b314"
      ? {
          ...family,
          status: factorySupportsWhitelistMode ? "live" : "factory"
        }
      : family.suffix === "1314–9314"
        ? {
            ...family,
            status: factorySupportsTaxedMode ? "live" : "planned"
          }
        : family.suffix === "f314"
          ? {
              ...family,
              status: factorySupportsWhitelistTaxedMode ? "live" : "planned"
            }
          : family
  );

  useEffect(() => {
    if (createMode === "whitelist" && !factorySupportsWhitelistMode) {
      setCreateMode("standard");
    }
    if (createMode === "taxed" && !factorySupportsTaxedMode) {
      setCreateMode("standard");
    }
    if (createMode === "whitelistTaxed" && !factorySupportsWhitelistTaxedMode) {
      setCreateMode(factorySupportsWhitelistMode ? "whitelist" : "standard");
    }
  }, [createMode, factorySupportsWhitelistMode, factorySupportsTaxedMode, factorySupportsWhitelistTaxedMode]);

  const launchMetadata = useMemo(
    () =>
      buildLaunchMetadata({
        name: createName,
        symbol: createSymbol,
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
      createName,
      createSymbol,
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
    const [activity, chart] = indexed
      ? [indexed.recentActivity, indexed.segmentedChart]
      : await Promise.all([fetchUnifiedActivity(address), fetchSegmentedChartSnapshot(address)]);

    if (requestId !== workspaceRequestRef.current) {
      return snapshot;
    }

    setTokenSnapshot(snapshot);
    setTokenVerification(verification);
    setRecentActivity(activity);
    setBondingCandles(chart.bondingCandles);
    setDexCandles(chart.dexCandles);
    setGraduationTimestampMs(chart.graduationTimestampMs);

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
      const { factory, launches } = await readRecentLaunchSnapshots(factoryAddress);
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
      const finalMetadataUri = createMetadataUri.trim() || generatedInlineMetadataUri;
      if (!finalMetadataUri) {
        throw new Error(
          usingUploadedImage
            ? t("statusExternalMetadataRequiredUpload")
            : t("statusMetadataUriRequired")
        );
      }
      const whitelistThreshold = requiresWhitelistCommit ? parseEther(createWhitelistThreshold) : undefined;
      const whitelistSlotSize = requiresWhitelistCommit ? parseEther(createWhitelistSlotSize) : undefined;
      const atomicBuyAmount = requiresAtomicBuy ? parseEther(createAtomicBuyAmount || "0") : 0n;
      const taxBps = isTaxedFamily ? Number.parseInt(createTaxBps || "1", 10) * 100 : undefined;
      const burnShareBps = isTaxedFamily ? Number.parseInt(createTaxBurnShareBps || "0", 10) : undefined;
      const treasuryShareBps = isTaxedFamily ? Number.parseInt(createTaxTreasuryShareBps || "0", 10) : undefined;
      const treasuryWallet =
        isTaxedFamily
          ? treasuryShareBps === 0
            ? getAddress("0x0000000000000000000000000000000000000000")
            : getAddress(createTaxTreasuryWallet || snapshot.protocolFeeRecipient)
          : undefined;

      if (requiresWhitelistCommit) {
        if (!parsedWhitelistAddresses || whitelistAddressCount < whitelistSeatTarget) {
          throw new Error(t("errorWhitelistCoverage"));
        }
        if (!parsedWhitelistAddresses.some((entry) => entry.toLowerCase() === wallet.toLowerCase())) {
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

      if (requiresAtomicBuy && atomicBuyAmount <= 0n) {
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

      const minTokenOut = applySlippageBps(preview.tokenOut, Number(slippageBps || "0"));
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

      const minQuoteOut = applySlippageBps(preview.netQuoteOut, Number(slippageBps || "0"));
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

  return (
    <main className="app-shell">
      <header className="topbar topbar-compact">
        <div>
          <div className="brand-row">
            <span className="badge">{t('tagline')}</span>
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
                <button className="secondary-button" onClick={() => void handleSelectLaunch(latestLaunch.address)}>
                  {t('homeLatestBtn')}
                </button>
              )}
            </div>
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

          <section className="market-board">
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
                <span className="list-item-meta">
                  {filteredLaunchSnapshots.length} / {recentLaunchSnapshots.length} {t('indexedLaunches')}
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
                {filteredLaunchSnapshots.map((launch) => {
                  const metadataState = launchMetadataByToken[launch.address.toLowerCase()];
                  const metadata = metadataState ?? null;
                  const image = resolvePreviewImage(metadata?.image ?? "");
                  const links = launchMetadataLinks(metadata);
                  const isActive = tokenAddress.toLowerCase() === launch.address.toLowerCase();

                  return (
                    <article key={launch.address} className={`launch-card ${isActive ? "active" : ""}`}>
                      <div className="launch-card-media">
                        {image ? (
                          <img src={image} alt={tf("launchCoverAlt", { name: metadata?.name || launch.name })} />
                        ) : (
                          <div className="launch-card-placeholder">{(metadata?.symbol || launch.symbol).slice(0, 6)}</div>
                        )}
                        <span className={`stage-pill ${launch.state === "Bonding314" ? "live" : launch.state === "DEXOnly" ? "done" : ""}`}>
                          {launchStateLabel(launch.state)}
                        </span>
                      </div>
                      <div className="launch-card-body">
                          <div className="launch-card-head">
                            <div>
                              <h3>{metadata?.name || launch.name}</h3>
                              <div className="launch-card-symbol">
                                {metadata?.symbol || launch.symbol} · {launch.launchSuffix || t("launchSuffixFallback")}
                              </div>
                            </div>
                            <div className="launch-card-price">{formatNative(launch.currentPriceQuotePerToken)}</div>
                          </div>
                        <p className="launch-card-description">
                          {metadata?.description ||
                            t("metadataPendingDesc")}
                        </p>
                        <div className="launch-card-stats">
                          <div>
                            <span className="metric-label">{t("progress")}</span>
                            <strong>{formatPercentFromBps(launch.graduationProgressBps)}</strong>
                          </div>
                          <div>
                            <span className="metric-label">{t("price")}</span>
                            <strong>{formatNative(launch.currentPriceQuotePerToken)}</strong>
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
                          <button onClick={() => void handleQuickBuyLaunch(launch.address)}>
                            {t('buyNow')}
                          </button>
                          <button className="secondary-button" onClick={() => void handleSelectLaunch(launch.address)}>
                            {t('openWorkspace')}
                          </button>
                          <span className="list-item-meta">{shortAddress(launch.address)}</span>
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
        <section className="page-grid create-grid">
          <aside className="rail">
            <article className="panel">
              <h2>{t('factoryAddress')}</h2>
              <label className="field">
                <span>{t('factoryAddress')}</span>
                <input value={factoryAddress} onChange={(e) => setFactoryAddress(e.target.value)} placeholder="0x..." />
              </label>
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
                    <div><dt>{t('createFeeStandard')}</dt><dd>{formatNative(factorySnapshot.standardCreateFee)}</dd></div>
                    <div><dt>{t('createFeeWhitelist')}</dt><dd>{formatNative(factorySnapshot.whitelistCreateFee)}</dd></div>
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
            </article>
          </aside>

          <section className="workspace-main">
            <article className="panel">
              <div className="create-hero-card">
                <div>
                  <span className="section-kicker">{t('createKicker')}</span>
                  <h2>{t('createTitle')}</h2>
                  <p className="topbar-copy">
                    {t('createDesc')}
                  </p>
                </div>
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
                    disabled={!factorySupportsWhitelistMode}
                    title={
                      factorySupportsWhitelistMode
                        ? t("modeWhitelistTooltipLive")
                        : t("modeWhitelistTooltipLocked")
                    }
                  >
                    <span>b314</span>
                    <small>{factorySupportsWhitelistMode ? t('modeWhitelist') : t('modeComingNext')}</small>
                  </button>
                  <button
                    type="button"
                    className={createMode === "taxed" ? "mode-tab active" : "mode-tab"}
                    onClick={() => setCreateMode("taxed")}
                    disabled={!factorySupportsTaxedMode}
                    title={factorySupportsTaxedMode ? t("modeTaxTooltipLive") : t("modeTaxTooltipLocked")}
                  >
                    <span>1314–9314</span>
                    <small>{factorySupportsTaxedMode ? t('modeTaxed') : t('modeComingNext')}</small>
                  </button>
                  <button
                    type="button"
                    className={createMode === "whitelistTaxed" ? "mode-tab active" : "mode-tab"}
                    onClick={() => setCreateMode("whitelistTaxed")}
                    disabled={!factorySupportsWhitelistTaxedMode}
                    title={
                      factorySupportsWhitelistTaxedMode
                        ? t("modeWhitelistTaxTooltipLive")
                        : t("modeWhitelistTaxTooltipLocked")
                    }
                  >
                    <span>f314</span>
                    <small>{factorySupportsWhitelistTaxedMode ? t('modeWhitelistTax') : t('modeComingNext')}</small>
                  </button>
                </div>
              </div>

              <section className="launch-family-strip" aria-label={t("launchFamiliesAria")}>
                {visibleLaunchFamilies.map((family) => {
                  const isSelected = family.suffix === selectedLaunchFamily.suffix;
                  return (
                    <article
                      key={family.suffix}
                      className={`launch-family-card ${isSelected ? "selected" : ""} ${family.status === "planned" ? "planned" : ""}`}
                    >
                      <div className="launch-family-head">
                        <div>
                          <span className="section-kicker">{family.eyebrow}</span>
                          <h3>{family.title}</h3>
                        </div>
                        <div className="launch-family-badges">
                          <span className="launch-family-suffix">{family.suffix}</span>
                          <span className={`family-state ${family.status}`}>
                            {family.status === "live" ? t("modeLive") : family.status === "factory" ? t("modeFactory") : t("modePlanned")}
                          </span>
                        </div>
                      </div>
                      <p>{family.description}</p>
                      <ul className="launch-family-points">
                        {family.operations.map((point: string) => (
                          <li key={`${family.suffix}-${point}`}>{point}</li>
                        ))}
                      </ul>
                    </article>
                  );
                })}
              </section>

              <div className="create-layout">
                <div className="create-sections">
                  <section className="create-section">
                    <div className="create-section-head">
                      <div>
                        <span className="section-kicker">{t("identityKicker")}</span>
                        <h3>{t("identityTitle")}</h3>
                      </div>
                      <span className="status-pill success">{selectedLaunchFamily.suffix.toUpperCase()}</span>
                    </div>
                    <div className="metadata-two-column">
                      <label className="field">
                        <span>{t("tokenName")}</span>
                        <input value={createName} onChange={(e) => setCreateName(e.target.value)} placeholder={t("tokenNamePlaceholder")} />
                      </label>
                      <label className="field">
                        <span>{t("tokenSymbol")}</span>
                        <input value={createSymbol} onChange={(e) => setCreateSymbol(e.target.value)} placeholder={t("tokenSymbolPlaceholder")} />
                      </label>
                    </div>
                    <label className="field">
                      <span>{t("description")}</span>
                      <textarea
                        value={createDescription}
                        onChange={(e) => setCreateDescription(e.target.value)}
                        placeholder={t("descriptionPlaceholder")}
                        rows={4}
                      />
                    </label>
                    {requiresAtomicBuy && (
                      <div className="metadata-two-column">
                        <label className="field">
                          <span>{`${t("atomicBuyAmount")} (${activeProtocolProfile.nativeSymbol})`}</span>
                          <input
                            value={createAtomicBuyAmount}
                            onChange={(e) => setCreateAtomicBuyAmount(e.target.value)}
                            placeholder="1"
                          />
                        </label>
                        <label className="field">
                          <span>{t("creatorFlowLabel")}</span>
                          <input value={t("creatorFlowAtomicBuy")} readOnly />
                        </label>
                      </div>
                    )}
                    {requiresWhitelistCommit && (
                      <div className="callout compact-callout">
                        <strong>{t("summaryAtomicSeat")}</strong>
                        <p>{t("creatorFlowSeatNote")}</p>
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
                    <div className="metadata-two-column">
                      <label className="field">
                        <span>{t("imageUrl")}</span>
                        <input value={createImageUrl} onChange={(e) => setCreateImageUrl(e.target.value)} placeholder={t("imageUrlPlaceholder")} />
                      </label>
                      <label className="field">
                        <span>{t("uploadImage")}</span>
                        <input
                          type="file"
                          accept="image/*"
                          onChange={(e) => {
                            void handleMetadataImageUpload(e.target.files?.[0] ?? null);
                          }}
                        />
                      </label>
                    </div>
                    <div className="metadata-two-column">
                      <label className="field">
                        <span>{t("website")}</span>
                        <input value={createWebsite} onChange={(e) => setCreateWebsite(e.target.value)} placeholder="https://..." />
                      </label>
                      <label className="field">
                        <span>{t("twitter")}</span>
                        <input value={createTwitter} onChange={(e) => setCreateTwitter(e.target.value)} placeholder="https://x.com/..." />
                      </label>
                    </div>
                    <div className="metadata-two-column">
                      <label className="field">
                        <span>{t("telegram")}</span>
                        <input value={createTelegram} onChange={(e) => setCreateTelegram(e.target.value)} placeholder="https://t.me/..." />
                      </label>
                      <label className="field">
                        <span>{t("discord")}</span>
                        <input value={createDiscord} onChange={(e) => setCreateDiscord(e.target.value)} placeholder="https://discord.gg/..." />
                      </label>
                    </div>
                    <div className="callout warn compact-callout">
                      <strong>{t("localUploadNote")}</strong>
                      <p>
                        {t("localUploadExplain")}
                      </p>
                      {createImageFileName && <p>{t("selectedFile")} {createImageFileName}</p>}
                    </div>
                    <label className="field">
                      <span>{t("metadataUri")}</span>
                      <input
                        value={createMetadataUri}
                        onChange={(e) => setCreateMetadataUri(e.target.value)}
                        placeholder={t("metadataUriPlaceholder")}
                      />
                    </label>
                    <div className="button-row">
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
                        <span className="status-pill warn">{createMode === "whitelistTaxed" ? "f314" : `${createTaxBps}314`}</span>
                      </div>
                      <div className="metadata-two-column">
                        <label className="field">
                          <span>{t("taxRate")}</span>
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
                          <span>{t("treasuryWallet")}</span>
                          <input
                            value={createTaxTreasuryWallet}
                            onChange={(e) => setCreateTaxTreasuryWallet(e.target.value)}
                            placeholder={t("treasuryWalletPlaceholder")}
                          />
                        </label>
                      </div>
                      <div className="metadata-two-column">
                        <label className="field">
                          <span>{t("burnShare")}</span>
                          <input value={createTaxBurnShareBps} onChange={(e) => setCreateTaxBurnShareBps(e.target.value)} placeholder="5000" />
                        </label>
                        <label className="field">
                          <span>{t("treasuryShare")}</span>
                          <input
                            value={createTaxTreasuryShareBps}
                            onChange={(e) => setCreateTaxTreasuryShareBps(e.target.value)}
                            placeholder="5000"
                          />
                        </label>
                      </div>
                      <div className="callout compact-callout">
                        <strong>{t("taxOnlyPostGrad")}</strong>
                        <p>{t("taxWalletTransferFree")}</p>
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
                          <span>{`${t("wlThreshold")} (${activeProtocolProfile.nativeSymbol})`}</span>
                          <select value={createWhitelistThreshold} onChange={(e) => setCreateWhitelistThreshold(e.target.value)}>
                            <option value="4">4 BNB</option>
                            <option value="6">6 BNB</option>
                            <option value="8">8 BNB</option>
                          </select>
                        </label>
                        <label className="field">
                          <span>{`${t("wlSlotSize")} (${activeProtocolProfile.nativeSymbol})`}</span>
                          <select value={createWhitelistSlotSize} onChange={(e) => setCreateWhitelistSlotSize(e.target.value)}>
                            <option value="0.1">0.1 BNB</option>
                            <option value="0.2">0.2 BNB</option>
                            <option value="0.5">0.5 BNB</option>
                            <option value="1">1 BNB</option>
                          </select>
                        </label>
                      </div>
                      <div className="create-summary-grid compact">
                          <div><span>{t("wlSeatTarget")}</span><strong>{whitelistSeatTarget || "—"}</strong></div>
                        <div><span>{t("wlAddressCount")}</span><strong>{whitelistAddressCount}</strong></div>
                        <div><span>{t("wlWindow")}</span><strong>24h</strong></div>
                      </div>
                      <label className="field">
                        <span>{t("wlAddresses")}</span>
                        <textarea
                          value={createWhitelistAddresses}
                          onChange={(e) => setCreateWhitelistAddresses(e.target.value)}
                          placeholder={t("wlAddressesPlaceholder")}
                          rows={7}
                        />
                      </label>
                      <div className={`callout ${whitelistAddressCountValid ? "success" : "warn"} compact-callout`}>
                        <strong>{whitelistAddressCountValid ? t("wlCoverageValid") : t("wlCoverageNeed")}</strong>
                        <p>{t("wlExplain")}</p>
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
                    <div><span>{t("summaryCreatorFlow")}</span><strong>{requiresAtomicBuy ? t("summaryAtomicBuy") : t("summaryAtomicSeat")}</strong></div>
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
                  <button onClick={handleCreateLaunch} disabled={walletWrongNetwork || (requiresWhitelistCommit && !whitelistAddressCountValid)}>
                    {createMode === "standard"
                      ? t("createBtn0314")
                      : createMode === "whitelist"
                        ? t("createBtnB314")
                        : createMode === "taxed"
                          ? t("createBtnTax")
                          : t("createBtnF314")}
                  </button>
                </aside>
              </div>
            </article>
          </section>
        </section>
      )}

      {route.page === "launch" && (
        <section className="workspace-grid">
          <aside className="rail">
            <article className="panel">
              <div className="page-heading compact-heading">
                <div>
                  <span className="section-kicker">{t("launchKicker")}</span>
                  <h2>{t("launchTitle")}</h2>
                </div>
                <button className="secondary-button" onClick={() => navigate({ page: "create" })}>{t("newLaunch")}</button>
              </div>
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
                  <h2>{tokenSnapshot ? `${tokenSnapshot.name} (${tokenSnapshot.symbol})` : t("loadWorkspace")}</h2>
                </div>
                <span className={`stage-pill ${isBonding ? "live" : isMigrating ? "warn" : isDexOnly ? "done" : ""}`}>
                  {tokenSnapshot ? launchStateLabel(tokenSnapshot.state) : t("noSelection")}
                </span>
              </div>

              {tokenSnapshot ? (
                <>
                  <div className="launch-hero">
                    <div className="launch-hero-media">
                      {resolvePreviewImage(selectedLaunchMetadata?.image ?? "") ? (
                        <img src={resolvePreviewImage(selectedLaunchMetadata?.image ?? "")} alt={tf("launchCoverAlt", { name: selectedLaunchMetadata?.name || tokenSnapshot.name })} />
                      ) : (
                        <div className="launch-card-placeholder large">{tokenSnapshot.symbol.slice(0, 8)}</div>
                      )}
                    </div>
                    <div className="launch-hero-copy">
                      <div className="launch-hero-head">
                        <div>
                          <span className="section-kicker">{t("launchOverview")}</span>
                          <h3>{selectedLaunchMetadata?.name || tokenSnapshot.name}</h3>
                          <div className="launch-card-symbol">{selectedLaunchMetadata?.symbol || tokenSnapshot.symbol}</div>
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
                  </div>

                  <div className="headline-metrics">
                    <div>
                      <span className="metric-label">Current price</span>
                      <strong>{formatNative(tokenSnapshot.currentPriceQuotePerToken)}</strong>
                    </div>
                    <div>
                      <span className="metric-label">Graduation progress</span>
                      <strong>{formatPercentFromBps(tokenSnapshot.graduationProgressBps)}</strong>
                    </div>
                    <div>
                      <span className="metric-label">Remaining capacity</span>
                      <strong>{formatNative(tokenSnapshot.remainingQuoteCapacity)}</strong>
                    </div>
                    <div>
                      <span className="metric-label">Creator</span>
                      <strong>{shortAddress(tokenSnapshot.creator)}</strong>
                    </div>
                  </div>

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

                  {tokenVerification && (
                    <div className={`callout ${verificationTone}`}>
                      <strong>
                        {tokenVerification.status === "official"
                          ? t("verifiedOfficial")
                          : tokenVerification.status === "warning"
                            ? t("verifiedSuspicious")
                            : t("verifiedForeign")}
                      </strong>
                      <p>{tokenVerification.summary}</p>
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

                  <div className="detail-grid">
                    <dl className="data-list">
                      <div><dt>{t("tokenAddressLabel")}</dt><dd>{tokenSnapshot.address}</dd></div>
                      <div><dt>{t("mode")}</dt><dd>{tokenSnapshot.launchMode}</dd></div>
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
                          <div><dt>{t("treasuryWalletLabel")}</dt><dd>{shortAddress(tokenSnapshot.taxConfig.wallet)}</dd></div>
                        </>
                      )}
                    </dl>

                    <dl className="data-list">
                      <div><dt>{t("protocolClaimable")}</dt><dd>{formatNative(tokenSnapshot.protocolClaimable)}</dd></div>
                      <div><dt>{t("creatorClaimable")}</dt><dd>{formatNative(tokenSnapshot.creatorClaimable)}</dd></div>
                      <div><dt>{t("tokenProtocolRecipient")}</dt><dd>{shortAddress(tokenSnapshot.protocolFeeRecipient)}</dd></div>
                      <div><dt>{t("creatorFeeSweepReady")}</dt><dd>{creatorFeeSweepReady ? t("yes") : t("no")}</dd></div>
                      <div><dt>{t("createdAt")}</dt><dd>{formatUnixTimestamp(tokenSnapshot.createdAt)}</dd></div>
                      <div><dt>{t("lastTradeAt")}</dt><dd>{formatUnixTimestamp(tokenSnapshot.lastTradeAt)}</dd></div>
                      <div><dt>{t("dexTokenReserve")}</dt><dd>{formatToken(tokenSnapshot.dexTokenReserve)}</dd></div>
                      <div><dt>{t("dexQuoteReserve")}</dt><dd>{formatNative(tokenSnapshot.dexQuoteReserve)}</dd></div>
                      <div><dt>{t("connectedAsCreator")}</dt><dd>{connectedAsCreator ? t("yes") : t("no")}</dd></div>
                      <div><dt>{t("statusMessage")}</dt><dd>{status}</dd></div>
                    </dl>
                  </div>

                  {creatorFeeSweepReady && isBonding && (
                    <div className="callout warn">
                      <strong>{t("abandonedSweep")}</strong>
                      <p>{t("abandonedSweepDesc")}</p>
                    </div>
                  )}

                  <div className="history-grid">
                    <article className="subpanel">
                      <div className="subpanel-header">
                        <h3>{t("priceTrajectory")}</h3>
                        <span className="list-item-meta">
                          {dexCandles.length > 0 ? t("segmentedChart") : isBonding ? t("protocolCandles") : t("dexHandoff")}
                        </span>
                      </div>
                      {bondingCandles.length > 0 || dexCandles.length > 0 ? (
                        <SegmentedPhaseChart bondingCandles={bondingCandles} dexCandles={dexCandles} graduationTimestampMs={graduationTimestampMs} />
                      ) : (
                        <div className="empty-state">{t("noChartData")}</div>
                      )}
                    </article>

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
                              <div>
                                <strong>{activityLabel(activity)}</strong>
                                <div className="trade-meta">{formatDateTime(activity.timestampMs)} · {activityPhaseLabel(activity)}</div>
                              </div>
                              <div>
                                {activity.kind === "graduated" ? (
                                  <>
                                    <strong>{formatNative(activity.quoteAmountContributed)}</strong>
                                    <div className="trade-meta">
                                      {t("lpSeed")} · {formatToken(activity.tokenAmount)} {t("tokenUnit")}
                                      {activity.preloadedQuoteAmount > 0n ? ` + ${formatNative(activity.preloadedQuoteAmount)} ${t("preload")}` : ""}
                                    </div>
                                  </>
                                ) : (
                                  <>
                                    <strong>{formatNative(activity.netQuote)}</strong>
                                    <div className="trade-meta">{formatToken(activity.tokenAmount)} {t("tokenUnit")}</div>
                                  </>
                                )}
                              </div>
                              <div>
                                {activity.kind === "graduated" ? (
                                  <>
                                    <strong>{shortAddress(activity.marketAddress)}</strong>
                                    <div className="trade-meta">{formatToken(activity.liquidityBurned)} {t("lpBurned")}</div>
                                  </>
                                ) : (
                                  <>
                                    <strong>{formatNative(activity.priceQuotePerToken)}</strong>
                                    <div className="trade-meta">{shortAddress(activity.txHash)}</div>
                                  </>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </article>
                  </div>
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
                  <div className="create-summary-grid compact">
                          <div><span>{t("mode")}</span><strong>{tokenSnapshot?.launchSuffix || "b314"}</strong></div>
                    <div><span>{t("wlSeatSizeShort")}</span><strong>{formatNative(whitelistSnapshot.slotSize)}</strong></div>
                    <div><span>{t("wlFilledShort")}</span><strong>{whitelistSeatsFilled.toString()}</strong></div>
                    <div><span>{t("wlRemainingShort")}</span><strong>{whitelistSeatsRemaining.toString()}</strong></div>
                  </div>
                  <div className={`callout ${whitelistApproved ? "success" : "warn"} compact-callout`}>
                    <strong>{whitelistApproved ? t("wlApproved") : t("wlNotApproved")}</strong>
                    <p>{t("wlCommitExplain")}</p>
                  </div>
                  <div className="button-row stacked">
                    <button onClick={handleWhitelistCommit} disabled={!canCommitWhitelist || walletWrongNetwork || !canWriteVerifiedLaunch}>
                      {t("commitSeat")}
                    </button>
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
                </>
              ) : (
                <>
                  <h2>{t("bondingActions")}</h2>
                  <label className="field">
                    <span>{`${t("buyAmount")} (${activeProtocolProfile.nativeSymbol})`}</span>
                    <input value={buyInput} onChange={(e) => setBuyInput(e.target.value)} />
                  </label>
                  <label className="field">
                    <span>{t("sellAmount")}</span>
                    <input value={sellInput} onChange={(e) => setSellInput(e.target.value)} />
                  </label>
                  <label className="field">
                    <span>{t("slippage")}</span>
                    <input value={slippageBps} onChange={(e) => setSlippageBps(e.target.value)} />
                  </label>
                  <div className="button-row stacked">
                    <button className="secondary-button" onClick={handlePreviewBuy} disabled={!tokenAddress || !isBonding || !canWriteVerifiedLaunch}>{t("previewBuy")}</button>
                    <button onClick={handleExecuteBuy} disabled={!isBonding || walletWrongNetwork || !canWriteVerifiedLaunch}>{t("executeBuy")}</button>
                    <button className="secondary-button" onClick={handlePreviewSell} disabled={!tokenAddress || !isBonding || !canWriteVerifiedLaunch}>{t("previewSell")}</button>
                    <button onClick={handleExecuteSell} disabled={!isBonding || walletWrongNetwork || !canWriteVerifiedLaunch}>{t("executeSell")}</button>
                  </div>

                  {buyPreviewState && (
                    <dl className="data-list compact">
                      <div><dt>{t("buyTokenOut")}</dt><dd>{formatToken(buyPreviewState.tokenOut)}</dd></div>
                      <div><dt>{t("buyFee")}</dt><dd>{formatNative(buyPreviewState.feeAmount)}</dd></div>
                      <div><dt>{t("buyRefund")}</dt><dd>{formatNative(buyPreviewState.refundAmount)}</dd></div>
                      <div><dt>{t("buyMinOut")}</dt><dd>{formatToken(applySlippageBps(buyPreviewState.tokenOut, Number(slippageBps || "0")))}</dd></div>
                    </dl>
                  )}

                  {sellPreviewState && (
                    <dl className="data-list compact">
                      <div><dt>{t("sellGrossOut")}</dt><dd>{formatNative(sellPreviewState.grossQuoteOut)}</dd></div>
                      <div><dt>{t("sellNetOut")}</dt><dd>{formatNative(sellPreviewState.netQuoteOut)}</dd></div>
                      <div><dt>{t("sellFee")}</dt><dd>{formatNative(sellPreviewState.totalFee)}</dd></div>
                      <div><dt>{t("sellMinOut")}</dt><dd>{formatNative(applySlippageBps(sellPreviewState.netQuoteOut, Number(slippageBps || "0")))}</dd></div>
                    </dl>
                  )}
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
        <span>Autonomous 314 Protocol · {t('openSource')}</span>
        <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
          <a href={REPO_URL} target="_blank" rel="noreferrer">{t('repoLink')}</a>
          <button className="lang-toggle" onClick={toggleLocale}>{locale === "en" ? t("footerLangZh") : t("footerLangEn")}</button>
        </div>
      </footer>
    </main>
  );
}
