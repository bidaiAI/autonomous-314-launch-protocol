import { useEffect, useMemo, useRef, useState } from "react";
import { getAddress, parseEther } from "viem";
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
import { SegmentedPhaseChart } from "./charts";
import { activeProtocolProfile } from "./profiles";

const protocolSnapshot = {
  preGrad: "314 bonding market, transfers disabled, 1-block sell cooldown",
  postGrad: `${activeProtocolProfile.dexName} only, LP burned, 314 disabled`,
  pollutionRule: `${activeProtocolProfile.wrappedNativeSymbol} preload alone does not stop graduation; LP initialization or token-side pollution still blocks.`,
  economics: "1% total fee = 0.7% creator + 0.3% protocol",
  sovereignty: "The launch contract itself is the market, reserve system, and graduation state machine."
};

type BuyPreview = Awaited<ReturnType<typeof previewBuy>>;
type SellPreview = Awaited<ReturnType<typeof previewSell>>;
type AppRoute = { page: "home" } | { page: "create" } | { page: "launch"; token: string };

function parseRoute(pathname: string): AppRoute {
  if (pathname === "/create") return { page: "create" };
  const launchMatch = pathname.match(/^\/launch\/(0x[a-fA-F0-9]{40})$/);
  if (launchMatch) return { page: "launch", token: launchMatch[1] };
  return { page: "home" };
}

function routeHref(route: AppRoute) {
  if (route.page === "create") return "/create";
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
  if (activity.kind === "graduated") return "Graduated";
  const side = activity.side === "buy" ? "Buy" : "Sell";
  return activity.source === "dex" ? `${side} · DEX` : `${side} · Protocol`;
}

function activityPhaseLabel(activity: ActivityFeedItem) {
  if (activity.phase === "bonding") return "Bonding314";
  if (activity.phase === "migrating") return "Migrating";
  return "DEXOnly";
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
    { label: "Website", href: resolveExternalHref(metadata.website || metadata.external_url) },
    { label: "X", href: resolveExternalHref(metadata.twitter) },
    { label: "Telegram", href: resolveExternalHref(metadata.telegram) },
    { label: "Discord", href: resolveExternalHref(metadata.discord) }
  ];

  return links.filter((link) => Boolean(link.href));
}

export function App() {
  const [route, setRoute] = useState<AppRoute>(() => parseRoute(window.location.pathname));
  const [wallet, setWallet] = useState<string>("");
  const [factoryAddress, setFactoryAddress] = useState(import.meta.env.VITE_FACTORY_ADDRESS ?? "");
  const [tokenAddress, setTokenAddress] = useState(import.meta.env.VITE_TOKEN_ADDRESS ?? "");
  const [createName, setCreateName] = useState("Autonomous 314");
  const [createSymbol, setCreateSymbol] = useState("A314");
  const [createMode, setCreateMode] = useState<"standard" | "whitelist">("standard");
  const [createDescription, setCreateDescription] = useState("");
  const [createImageUrl, setCreateImageUrl] = useState("");
  const [createImagePreview, setCreateImagePreview] = useState("");
  const [createImageFileName, setCreateImageFileName] = useState("");
  const [createWebsite, setCreateWebsite] = useState("");
  const [createTwitter, setCreateTwitter] = useState("");
  const [createTelegram, setCreateTelegram] = useState("");
  const [createDiscord, setCreateDiscord] = useState("");
  const [createMetadataUri, setCreateMetadataUri] = useState("");
  const [createWhitelistThreshold, setCreateWhitelistThreshold] = useState("4");
  const [createWhitelistSlotSize, setCreateWhitelistSlotSize] = useState("0.2");
  const [createWhitelistAddresses, setCreateWhitelistAddresses] = useState("");
  const [factorySnapshot, setFactorySnapshot] = useState<FactorySnapshot | null>(null);
  const [recentLaunchSnapshots, setRecentLaunchSnapshots] = useState<TokenSnapshot[]>([]);
  const [tokenSnapshot, setTokenSnapshot] = useState<TokenSnapshot | null>(null);
  const [tokenVerification, setTokenVerification] = useState<ProtocolVerification | null>(null);
  const [launchMetadataByToken, setLaunchMetadataByToken] = useState<Partial<Record<string, LaunchMetadata | null>>>({});
  const [marketQuery, setMarketQuery] = useState("");
  const [recentActivity, setRecentActivity] = useState<ActivityFeedItem[]>([]);
  const [bondingCandles, setBondingCandles] = useState<CandlePoint[]>([]);
  const [dexCandles, setDexCandles] = useState<CandlePoint[]>([]);
  const [graduationTimestampMs, setGraduationTimestampMs] = useState<number | null>(null);
  const [buyInput, setBuyInput] = useState("1");
  const [sellInput, setSellInput] = useState("1");
  const [slippageBps, setSlippageBps] = useState("300");
  const [buyPreviewState, setBuyPreviewState] = useState<BuyPreview | null>(null);
  const [sellPreviewState, setSellPreviewState] = useState<SellPreview | null>(null);
  const [status, setStatus] = useState<string>("Ready");
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

  const displayedGraduationTarget =
    tokenSnapshot?.graduationQuoteReserve && tokenSnapshot.graduationQuoteReserve > 0n
      ? tokenSnapshot.graduationQuoteReserve
      : factorySnapshot?.graduationQuoteReserve ?? 0n;
  const runtimeChainLabel = activeProtocolProfile.chainLabel;
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
  const whitelistSeatTarget =
    createMode === "whitelist" && whitelistThresholdValue > 0 && whitelistSlotValue > 0
      ? Math.round(whitelistThresholdValue / whitelistSlotValue)
      : 0;
  const whitelistAddressCount = parsedWhitelistAddresses?.length ?? 0;
  const whitelistAddressCountValid =
    createMode !== "whitelist" || (parsedWhitelistAddresses !== null && whitelistAddressCount >= whitelistSeatTarget && whitelistSeatTarget > 0);
  const factorySupportsWhitelistMode = factorySnapshot?.supportsWhitelistMode ?? false;
  const selectedCreateFee =
    createMode === "whitelist"
      ? factorySnapshot?.whitelistCreateFee ?? 0n
      : factorySnapshot?.standardCreateFee ?? factorySnapshot?.createFee ?? 0n;

  useEffect(() => {
    if (createMode === "whitelist" && !factorySupportsWhitelistMode) {
      setCreateMode("standard");
    }
  }, [createMode, factorySupportsWhitelistMode]);

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
      () => setStatus(`Token loaded: ${normalized}`),
      () => setStatus("Failed to load token")
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
              summary: "Protocol verification could not be completed for this address.",
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
          ? `Connected: ${account}`
          : `Connected: ${account} — switch wallet to ${runtimeChainLabel} before writing`
      );
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Wallet connection failed");
    }
  }

  async function handleSwitchNetwork() {
    try {
      setLoading(true);
      await switchWalletToExpectedChain();
      await refreshWalletNetworkStatus();
      setStatus(`Wallet switched to ${runtimeChainLabel}`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Network switch failed");
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
      setStatus("Factory loaded");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Failed to load factory");
    } finally {
      setLoading(false);
    }
  }

  async function handleLoadToken() {
    try {
      setLoading(true);
      navigate({ page: "launch", token: tokenAddress });
      setStatus("Token loaded");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Failed to load token");
    } finally {
      setLoading(false);
    }
  }

  async function handleSelectLaunch(address: string) {
    setTokenAddress(address);
    navigate({ page: "launch", token: address });
    try {
      setStatus(`Token loaded: ${address}`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Failed to load token");
    }
  }

  async function handleInspectAndLoadSearchToken() {
    if (!searchLooksLikeAddress) {
      setStatus("Enter a valid token address to verify and load.");
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
          : `${verification.summary} Loaded in read-only mode so you can inspect it safely.`
      );
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Failed to verify launch address");
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
      setStatus("Buy preview updated");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Buy preview failed");
    } finally {
      setLoading(false);
    }
  }

  async function handlePreviewSell() {
    try {
      setLoading(true);
      setSellPreviewState(await previewSell(tokenAddress, sellInput));
      setStatus("Sell preview updated");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Sell preview failed");
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
      reader.onerror = () => reject(new Error("Image preview failed"));
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
          ? "Inline metadata URI is disabled while a local image upload is embedded. Upload metadata externally and paste the resulting URI."
          : "Generated metadata URI is not available yet."
      );
      return;
    }

    setCreateMetadataUri(generatedInlineMetadataUri);
    setStatus("Generated inline metadata URI copied into the create form.");
  }

  function handleDownloadMetadata() {
    downloadLaunchMetadata(
      launchMetadata,
      `${(createSymbol || createName || "launch").trim().toLowerCase().replace(/[^a-z0-9-_]+/g, "-") || "launch"}-metadata.json`
    );
    setStatus("Downloaded launch metadata JSON.");
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
      const modeFee = createMode === "whitelist" ? snapshot.whitelistCreateFee : snapshot.standardCreateFee;
      const finalMetadataUri = createMetadataUri.trim() || generatedInlineMetadataUri;
      if (!finalMetadataUri) {
        throw new Error(
          usingUploadedImage
            ? "Local image upload is ready for preview/export, but you still need to upload metadata externally and paste a metadata URI before creating."
            : "Provide a metadata URI or use generated inline metadata first."
        );
      }
      const whitelistThreshold = createMode === "whitelist" ? parseEther(createWhitelistThreshold) : undefined;
      const whitelistSlotSize = createMode === "whitelist" ? parseEther(createWhitelistSlotSize) : undefined;
      if (createMode === "whitelist") {
        if (!parsedWhitelistAddresses || whitelistAddressCount < whitelistSeatTarget) {
          throw new Error("Whitelist mode needs enough valid addresses to cover every seat.");
        }
      }
      const expectedSuffix = createMode === "whitelist" ? "b314" : "0314";
      setStatus(`Mining vanity salt for suffix ${expectedSuffix}...`);

      const { receipt, createdToken, vanity } = await createLaunch(factoryAddress, {
        mode: createMode,
        name: createName,
        symbol: createSymbol,
        metadataURI: finalMetadataUri,
        createFee: modeFee,
        whitelistThreshold,
        whitelistSlotSize,
        whitelistAddresses: parsedWhitelistAddresses ?? undefined,
        onVanityProgress: ({ attempts, elapsedMs }) => {
          setStatus(
            `Mining vanity salt for suffix ${expectedSuffix}... ${attempts.toLocaleString()} attempts · ${(elapsedMs / 1000).toFixed(1)}s`
          );
        }
      });

      if (createdToken) {
        setTokenAddress(createdToken);
        navigate({ page: "launch", token: createdToken });
        setStatus(
          `Create launch confirmed: ${createdToken} (${expectedSuffix} vanity found in ${vanity.attempts.toLocaleString()} attempts / ${(vanity.elapsedMs / 1000).toFixed(1)}s)`
        );
      } else {
        setStatus(
          `Create launch confirmed: ${receipt.transactionHash} (predicted vanity ${vanity.predictedAddress})`
        );
      }

      const { factory, launches } = await readRecentLaunchSnapshots(factoryAddress);
      setFactorySnapshot(factory);
      setRecentLaunchSnapshots(launches);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Create launch failed");
    } finally {
      setLoading(false);
    }
  }

  async function handleWhitelistCommit() {
    if (!tokenSnapshot?.whitelistSnapshot) return;
    try {
      setLoading(true);
      const receipt = await executeWhitelistCommit(tokenAddress, tokenSnapshot.whitelistSnapshot.slotSize);
      setStatus(`Whitelist seat committed: ${receipt.transactionHash}`);
      await loadLaunchWorkspace(tokenAddress, false);
      setTokenSnapshot(await readToken(tokenAddress));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Whitelist commit failed");
    } finally {
      setLoading(false);
    }
  }

  async function handleClaimWhitelistAllocation() {
    try {
      setLoading(true);
      const receipt = await claimWhitelistAllocation(tokenAddress);
      setStatus(`Whitelist allocation claimed: ${receipt.transactionHash}`);
      await loadLaunchWorkspace(tokenAddress, false);
      setTokenSnapshot(await readToken(tokenAddress));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Whitelist allocation claim failed");
    } finally {
      setLoading(false);
    }
  }

  async function handleClaimWhitelistRefund() {
    try {
      setLoading(true);
      const receipt = await claimWhitelistRefund(tokenAddress);
      setStatus(`Whitelist refund claimed: ${receipt.transactionHash}`);
      await loadLaunchWorkspace(tokenAddress, false);
      setTokenSnapshot(await readToken(tokenAddress));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Whitelist refund claim failed");
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

      setStatus(`Buy confirmed: ${receipt.transactionHash}`);
      await loadLaunchWorkspace(tokenAddress, false);
      setTokenSnapshot(await readToken(tokenAddress));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Buy failed");
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

      setStatus(`Sell confirmed: ${receipt.transactionHash}`);
      await loadLaunchWorkspace(tokenAddress, false);
      setTokenSnapshot(await readToken(tokenAddress));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Sell failed");
    } finally {
      setLoading(false);
    }
  }

  async function handleClaimFactoryFees() {
    try {
      setLoading(true);
      const receipt = await claimFactoryProtocolFees(factoryAddress);
      setStatus(`Factory fee claim confirmed: ${receipt.transactionHash}`);
      await reloadLoadedViews();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Factory fee claim failed");
    } finally {
      setLoading(false);
    }
  }

  async function handleClaimTokenProtocolFees() {
    try {
      setLoading(true);
      const receipt = await claimTokenProtocolFees(tokenAddress);
      setStatus(`Protocol token fee claim confirmed: ${receipt.transactionHash}`);
      await loadLaunchWorkspace(tokenAddress, false);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Protocol token fee claim failed");
    } finally {
      setLoading(false);
    }
  }

  async function handleClaimCreatorFees() {
    try {
      setLoading(true);
      const receipt = await claimCreatorFees(tokenAddress);
      setStatus(`Creator fee claim confirmed: ${receipt.transactionHash}`);
      await loadLaunchWorkspace(tokenAddress, false);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Creator fee claim failed");
    } finally {
      setLoading(false);
    }
  }

  async function handleSweepCreatorFees() {
    try {
      setLoading(true);
      const receipt = await sweepAbandonedCreatorFees(tokenAddress);
      setStatus(`Creator fee sweep confirmed: ${receipt.transactionHash}`);
      await loadLaunchWorkspace(tokenAddress, false);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Creator fee sweep failed");
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
            <span className="badge">Creator-first open launch protocol</span>
            <span className="section-kicker">{runtimeChainLabel} official profile</span>
          </div>
          <h1>Autonomous 314</h1>
          <p className="topbar-copy">
            A launch contract that is its own market, reserve system, and graduation engine. Create on-chain, trade inside the contract, and graduate directly into {activeProtocolProfile.dexName}.
          </p>
        </div>
        <div className="topbar-actions">
          <nav className="nav-pills">
            <button className={route.page === "home" ? "nav-pill active" : "nav-pill"} onClick={() => navigate({ page: "home" })}>
              Home
            </button>
            <button className={route.page === "create" ? "nav-pill active" : "nav-pill"} onClick={() => navigate({ page: "create" })}>
              Create
            </button>
            {route.page === "launch" && (
              <button
                className={route.page === "launch" ? "nav-pill active" : "nav-pill"}
                onClick={() => navigate({ page: "launch", token: route.token })}
              >
                Launch
              </button>
            )}
          </nav>
          <button className="secondary-button" onClick={handleConnectWallet}>
            {wallet ? shortAddress(wallet) : "Connect Wallet"}
          </button>
        </div>
      </header>

      {walletWrongNetwork && (
        <section className="callout danger">
          <strong>Wrong network</strong>
          <p>
            Connected wallet chain is {walletChainId}. Switch to {runtimeChainLabel} (chainId {activeProtocolProfile.chainId}) before
            creating launches, trading, or claiming fees.
          </p>
          <div className="button-row">
            <button onClick={handleSwitchNetwork}>Switch wallet network</button>
          </div>
        </section>
      )}

      {route.page === "home" && (
        <>
          <section className="home-hero panel">
            <div>
              <span className="section-kicker">Open launch market</span>
              <h2>Creator-first launches that graduate into a canonical V2 market.</h2>
              <p>
                Browse live launches here, open a focused workspace to trade and inspect lifecycle state, or move into the create flow to deploy a new official launch.
              </p>
            </div>
            <div className="button-row hero-actions">
              <button onClick={() => navigate({ page: "create" })}>Create a launch</button>
              {latestLaunch && (
                <button className="secondary-button" onClick={() => void handleSelectLaunch(latestLaunch.address)}>
                  Open latest workspace
                </button>
              )}
            </div>
          </section>

          <section className="market-strip compact">
            <div className="strip-card">
              <span className="metric-label">Fee split</span>
              <strong>{protocolSnapshot.economics}</strong>
            </div>
            <div className="strip-card">
              <span className="metric-label">Graduation</span>
              <strong>
                {displayedGraduationTarget > 0n
                  ? `${formatNative(displayedGraduationTarget)} + 20% LP reserve`
                  : "Configurable protocol seed + 20% LP reserve"}
              </strong>
            </div>
            <div className="strip-card">
              <span className="metric-label">Market mode</span>
              <strong>{protocolSnapshot.preGrad}</strong>
            </div>
          </section>

          <section className="market-board">
            <div className="section-header">
              <div>
                <span className="section-kicker">Market board</span>
                <h2>Open launches</h2>
              </div>
              <div className="market-toolbar">
                <label className="field compact-field search-field">
                  <span>Search launches</span>
                  <input
                    value={marketQuery}
                    onChange={(e) => setMarketQuery(e.target.value)}
                    placeholder="Name, symbol, creator, or token address"
                  />
                </label>
                {searchLooksLikeAddress ? (
                  <button className="secondary-button" onClick={() => void handleInspectAndLoadSearchToken()} disabled={loading}>
                    Verify & load
                  </button>
                ) : null}
                <span className="list-item-meta">
                  {filteredLaunchSnapshots.length} of {recentLaunchSnapshots.length} indexed launches
                </span>
              </div>
            </div>

            {tokenVerification && searchLooksLikeAddress && (
              <div className={`callout ${verificationTone}`}>
                <strong>
                  {tokenVerification.status === "official"
                    ? "Verified official Autonomous 314 launch"
                    : tokenVerification.status === "warning"
                      ? "Suspicious launch surface"
                      : "Unverified token"}
                </strong>
                <p>{tokenVerification.summary}</p>
              </div>
            )}

            {filteredLaunchSnapshots.length === 0 ? (
              <div className="empty-state panel">
                {trimmedMarketQuery
                  ? "No indexed launch matched your query. Paste an address and use Verify & load to inspect an arbitrary token."
                  : "No launches have been created yet. Go to the create page to deploy the first launch."}
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
                          <img src={image} alt={`${metadata?.name || launch.name} cover`} />
                        ) : (
                          <div className="launch-card-placeholder">{(metadata?.symbol || launch.symbol).slice(0, 6)}</div>
                        )}
                        <span className={`stage-pill ${launch.state === "Bonding314" ? "live" : launch.state === "DEXOnly" ? "done" : ""}`}>
                          {launch.state}
                        </span>
                      </div>
                      <div className="launch-card-body">
                          <div className="launch-card-head">
                            <div>
                              <h3>{metadata?.name || launch.name}</h3>
                              <div className="launch-card-symbol">
                                {metadata?.symbol || launch.symbol} · {launch.launchSuffix || "launch"}
                              </div>
                            </div>
                            <div className="launch-card-price">{formatNative(launch.currentPriceQuotePerToken)}</div>
                          </div>
                        <p className="launch-card-description">
                          {metadata?.description ||
                            "Metadata has not been resolved yet, but the on-chain launch is already live and can be opened in the dedicated workspace."}
                        </p>
                        <div className="launch-card-stats">
                          <div>
                            <span className="metric-label">Progress</span>
                            <strong>{formatPercentFromBps(launch.graduationProgressBps)}</strong>
                          </div>
                          <div>
                            <span className="metric-label">Price</span>
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
                            <span>No social links yet</span>
                          )}
                        </div>
                        <div className="button-row launch-card-actions">
                          <button onClick={() => void handleQuickBuyLaunch(launch.address)}>
                            Buy now
                          </button>
                          <button className="secondary-button" onClick={() => void handleSelectLaunch(launch.address)}>
                            Open workspace
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
              <h2>Factory / market</h2>
              <label className="field">
                <span>Factory address</span>
                <input value={factoryAddress} onChange={(e) => setFactoryAddress(e.target.value)} placeholder="0x..." />
              </label>
              <div className="button-row">
                <button onClick={handleLoadFactory}>Load Factory</button>
                <button
                  className="secondary-button"
                  onClick={handleClaimFactoryFees}
                  disabled={!factorySnapshot || !connectedAsProtocolRecipient || walletWrongNetwork}
                >
                  Claim Fees
                </button>
              </div>
              {factorySnapshot && (
                <>
                  <dl className="data-list compact">
                    <div><dt>Current create fee</dt><dd>{formatNative(factorySnapshot.createFee)}</dd></div>
                    <div><dt>Graduation target</dt><dd>{formatNative(factorySnapshot.graduationQuoteReserve)}</dd></div>
                    <div><dt>Total launches</dt><dd>{factorySnapshot.totalLaunches.toString()}</dd></div>
                    <div><dt>Protocol recipient</dt><dd>{shortAddress(factorySnapshot.protocolFeeRecipient)}</dd></div>
                    <div><dt>Accrued fees</dt><dd>{formatNative(factorySnapshot.accruedProtocolCreateFees)}</dd></div>
                  </dl>
                  <div className="mini-list">
                    <div className="mini-list-title">Recent launches</div>
                    {recentLaunchSnapshots.length === 0 ? (
                      <div className="mini-list-empty">No launches yet.</div>
                    ) : (
                      recentLaunchSnapshots.slice(0, 8).map((launch) => (
                        <button key={launch.address} className="list-item" onClick={() => void handleSelectLaunch(launch.address)}>
                          <span className="list-item-main">
                            <strong>{launch.symbol}</strong>
                            <span>{launch.state} · {formatPercentFromBps(launch.graduationProgressBps)}</span>
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
                  <span className="section-kicker">Create</span>
                  <h2>Launch configuration</h2>
                  <p className="topbar-copy">
                    Configure the token surface, metadata, and launch mode in one pass. Standard launches stay minimal and
                    clean; whitelist launches add a fixed-seat commitment window before normal 314 bonding opens.
                  </p>
                </div>
                <div className="mode-toggle" role="tablist" aria-label="Launch mode">
                  <button
                    type="button"
                    className={createMode === "standard" ? "mode-tab active" : "mode-tab"}
                    onClick={() => setCreateMode("standard")}
                  >
                    <span>0314</span>
                    <small>Standard</small>
                  </button>
                  <button
                    type="button"
                    className={createMode === "whitelist" ? "mode-tab active" : "mode-tab"}
                    onClick={() => setCreateMode("whitelist")}
                    disabled={!factorySupportsWhitelistMode}
                    title={
                      factorySupportsWhitelistMode
                        ? "Deploy a whitelist-fixed-seat launch"
                        : "Whitelist mode unlocks after the V2 factory is deployed"
                    }
                  >
                    <span>b314</span>
                    <small>{factorySupportsWhitelistMode ? "Whitelist" : "Coming next"}</small>
                  </button>
                </div>
              </div>

              <div className="create-layout">
                <div className="create-sections">
                  <section className="create-section">
                    <div className="create-section-head">
                      <div>
                        <span className="section-kicker">Identity</span>
                        <h3>Launch identity</h3>
                      </div>
                      <span className="status-pill success">{createMode === "whitelist" ? "b314" : "0314"}</span>
                    </div>
                    <div className="metadata-two-column">
                      <label className="field">
                        <span>Name</span>
                        <input value={createName} onChange={(e) => setCreateName(e.target.value)} placeholder="Token name" />
                      </label>
                      <label className="field">
                        <span>Symbol</span>
                        <input value={createSymbol} onChange={(e) => setCreateSymbol(e.target.value)} placeholder="TOKEN" />
                      </label>
                    </div>
                    <label className="field">
                      <span>Description</span>
                      <textarea
                        value={createDescription}
                        onChange={(e) => setCreateDescription(e.target.value)}
                        placeholder="Explain the meme, the community angle, and the launch context."
                        rows={4}
                      />
                    </label>
                  </section>

                  <section className="create-section">
                    <div className="create-section-head">
                      <div>
                        <span className="section-kicker">Metadata</span>
                        <h3>Media and socials</h3>
                      </div>
                    </div>
                    <div className="metadata-two-column">
                      <label className="field">
                        <span>Image URL</span>
                        <input value={createImageUrl} onChange={(e) => setCreateImageUrl(e.target.value)} placeholder="https://... or ipfs://..." />
                      </label>
                      <label className="field">
                        <span>Upload image (preview only)</span>
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
                        <span>Website</span>
                        <input value={createWebsite} onChange={(e) => setCreateWebsite(e.target.value)} placeholder="https://..." />
                      </label>
                      <label className="field">
                        <span>X / Twitter</span>
                        <input value={createTwitter} onChange={(e) => setCreateTwitter(e.target.value)} placeholder="https://x.com/..." />
                      </label>
                    </div>
                    <div className="metadata-two-column">
                      <label className="field">
                        <span>Telegram</span>
                        <input value={createTelegram} onChange={(e) => setCreateTelegram(e.target.value)} placeholder="https://t.me/..." />
                      </label>
                      <label className="field">
                        <span>Discord</span>
                        <input value={createDiscord} onChange={(e) => setCreateDiscord(e.target.value)} placeholder="https://discord.gg/..." />
                      </label>
                    </div>
                    <div className="callout warn compact-callout">
                      <strong>Preview is local only.</strong>
                      <p>
                        Local uploads only power preview and metadata export. To create a real launch, publish the final
                        metadata JSON to IPFS, Arweave, or an HTTPS endpoint you control, then paste the URI below.
                      </p>
                      {createImageFileName && <p>Selected local file: {createImageFileName}</p>}
                    </div>
                    <label className="field">
                      <span>Final metadata URI</span>
                      <input
                        value={createMetadataUri}
                        onChange={(e) => setCreateMetadataUri(e.target.value)}
                        placeholder="ipfs://... or leave empty to use generated inline metadata"
                      />
                    </label>
                    <div className="button-row">
                      <button className="secondary-button" onClick={handleUseGeneratedMetadataUri} type="button">
                        Use generated inline metadata
                      </button>
                      <button className="secondary-button" onClick={handleDownloadMetadata} type="button">
                        Download metadata.json
                      </button>
                    </div>
                  </section>

                  {createMode === "whitelist" && (
                    <section className="create-section">
                      <div className="create-section-head">
                        <div>
                          <span className="section-kicker">Whitelist</span>
                          <h3>Fixed-seat commitment window</h3>
                        </div>
                      </div>
                      <div className="metadata-two-column">
                        <label className="field">
                          <span>Threshold (BNB)</span>
                          <select value={createWhitelistThreshold} onChange={(e) => setCreateWhitelistThreshold(e.target.value)}>
                            <option value="4">4 BNB</option>
                            <option value="6">6 BNB</option>
                            <option value="8">8 BNB</option>
                          </select>
                        </label>
                        <label className="field">
                          <span>Seat size (BNB)</span>
                          <select value={createWhitelistSlotSize} onChange={(e) => setCreateWhitelistSlotSize(e.target.value)}>
                            <option value="0.1">0.1 BNB</option>
                            <option value="0.2">0.2 BNB</option>
                            <option value="0.5">0.5 BNB</option>
                            <option value="1">1 BNB</option>
                          </select>
                        </label>
                      </div>
                      <div className="create-summary-grid compact">
                        <div><span>Seat target</span><strong>{whitelistSeatTarget || "—"}</strong></div>
                        <div><span>Provided addresses</span><strong>{whitelistAddressCount}</strong></div>
                        <div><span>Window</span><strong>24h</strong></div>
                      </div>
                      <label className="field">
                        <span>Whitelist addresses</span>
                        <textarea
                          value={createWhitelistAddresses}
                          onChange={(e) => setCreateWhitelistAddresses(e.target.value)}
                          placeholder="One address per line or comma-separated"
                          rows={7}
                        />
                      </label>
                      <div className={`callout ${whitelistAddressCountValid ? "success" : "warn"} compact-callout`}>
                        <strong>{whitelistAddressCountValid ? "Seat coverage looks valid." : "More whitelist addresses are needed."}</strong>
                        <p>
                          b314 requires at least one eligible address per seat. Users commit by sending the exact seat size; once
                          the seat cap is filled or the threshold is reached, the launch finalizes automatically.
                        </p>
                      </div>
                    </section>
                  )}
                </div>

                <aside className="create-summary-panel">
                  <div className="metadata-preview-card">
                    <div className="metadata-preview-head">
                      <div>
                        <span className="metric-label">Market preview</span>
                        <strong>{createName || "Untitled launch"}</strong>
                      </div>
                      <span className="status-pill success">{createSymbol || "TKN"}</span>
                    </div>
                    <div className="metadata-preview-body">
                      <div className="metadata-image-shell">
                        {resolvePreviewImage(launchMetadata.image ?? "") ? (
                          <img className="metadata-image" src={resolvePreviewImage(launchMetadata.image ?? "")} alt={`${createName || "Launch"} preview`} />
                        ) : (
                          <div className="metadata-image-placeholder">No image yet</div>
                        )}
                      </div>
                      <div className="metadata-preview-copy">
                        <p>{launchMetadata.description || "Write a short pitch so the card reads like a real market listing, not a raw contract shell."}</p>
                        <div className="metadata-links">
                          {launchMetadata.website && <span>Website</span>}
                          {launchMetadata.twitter && <span>X</span>}
                          {launchMetadata.telegram && <span>Telegram</span>}
                          {launchMetadata.discord && <span>Discord</span>}
                          {!launchMetadata.website && !launchMetadata.twitter && !launchMetadata.telegram && !launchMetadata.discord && <span>No social links yet</span>}
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="create-summary-grid">
                    <div><span>Mode</span><strong>{createMode === "whitelist" ? "Whitelist b314" : "Standard 0314"}</strong></div>
                    <div><span>Vanity target</span><strong>{createMode === "whitelist" ? "b314" : "0314"}</strong></div>
                    <div><span>Create fee</span><strong>{selectedCreateFee > 0n ? formatNative(selectedCreateFee) : "Load factory"}</strong></div>
                    <div><span>Graduation</span><strong>{factorySnapshot ? formatNative(factorySnapshot.graduationQuoteReserve) : "12 BNB"}</strong></div>
                  </div>

                  <div className="status-hint">
                    Only <strong>name</strong>, <strong>symbol</strong>, and <strong>metadataURI</strong> go on-chain. Rich launch content lives in metadata.
                  </div>
                  <div className="status-hint">
                    {generatedInlineMetadataUri
                      ? `Generated inline metadata is ready (${metadataUriSizeBytes.toLocaleString()} bytes).`
                      : usingUploadedImage
                        ? "A local uploaded image is good for preview/export, but you still need to publish metadata externally and paste its URI before creating."
                        : "You can paste a permanent metadata URI or generate an inline one for lightweight launches."}
                  </div>
                  <div className="status-hint">
                    Official creates mine a local CREATE2 salt so the new launch address ends with <strong>{createMode === "whitelist" ? "b314" : "0314"}</strong>.
                  </div>
                  <button onClick={handleCreateLaunch} disabled={walletWrongNetwork || (createMode === "whitelist" && !whitelistAddressCountValid)}>
                    {createMode === "whitelist" ? "Create b314 launch" : "Create 0314 launch"}
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
                  <span className="section-kicker">Workspace</span>
                  <h2>Launch controls</h2>
                </div>
                <button className="secondary-button" onClick={() => navigate({ page: "create" })}>New launch</button>
              </div>
              <label className="field">
                <span>Factory address</span>
                <input value={factoryAddress} onChange={(e) => setFactoryAddress(e.target.value)} placeholder="0x..." />
              </label>
              <label className="field">
                <span>Launch token address</span>
                <input value={tokenAddress} onChange={(e) => setTokenAddress(e.target.value)} placeholder="0x..." />
              </label>
              <div className="button-row">
                <button onClick={handleLoadFactory}>Load Factory</button>
                <button className="secondary-button" onClick={handleLoadToken}>Verify & Load Launch</button>
              </div>
              {factorySnapshot && (
                <dl className="data-list compact">
                  <div><dt>Create fee</dt><dd>{formatNative(factorySnapshot.createFee)}</dd></div>
                  <div><dt>Graduation target</dt><dd>{formatNative(factorySnapshot.graduationQuoteReserve)}</dd></div>
                  <div><dt>Total launches</dt><dd>{factorySnapshot.totalLaunches.toString()}</dd></div>
                  <div><dt>Protocol recipient</dt><dd>{shortAddress(factorySnapshot.protocolFeeRecipient)}</dd></div>
                </dl>
              )}
              <div className="mini-list">
                <div className="mini-list-title">Recent launches</div>
                {recentLaunchSnapshots.length === 0 ? (
                  <div className="mini-list-empty">No launches yet.</div>
                ) : (
                  recentLaunchSnapshots.slice(0, 8).map((launch) => (
                    <button
                      key={launch.address}
                      className={`list-item ${tokenAddress.toLowerCase() === launch.address.toLowerCase() ? "active" : ""}`}
                      onClick={() => void handleSelectLaunch(launch.address)}
                    >
                      <span className="list-item-main">
                        <strong>{launch.symbol}</strong>
                        <span>{launch.state} · {formatPercentFromBps(launch.graduationProgressBps)}</span>
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
                  <span className="section-kicker">Selected launch</span>
                  <h2>{tokenSnapshot ? `${tokenSnapshot.name} (${tokenSnapshot.symbol})` : "Load a launch workspace"}</h2>
                </div>
                <span className={`stage-pill ${isBonding ? "live" : isMigrating ? "warn" : isDexOnly ? "done" : ""}`}>
                  {tokenSnapshot?.state ?? "No selection"}
                </span>
              </div>

              {tokenSnapshot ? (
                <>
                  <div className="launch-hero">
                    <div className="launch-hero-media">
                      {resolvePreviewImage(selectedLaunchMetadata?.image ?? "") ? (
                        <img src={resolvePreviewImage(selectedLaunchMetadata?.image ?? "")} alt={`${selectedLaunchMetadata?.name || tokenSnapshot.name} cover`} />
                      ) : (
                        <div className="launch-card-placeholder large">{tokenSnapshot.symbol.slice(0, 8)}</div>
                      )}
                    </div>
                    <div className="launch-hero-copy">
                      <div className="launch-hero-head">
                        <div>
                          <span className="section-kicker">Launch overview</span>
                          <h3>{selectedLaunchMetadata?.name || tokenSnapshot.name}</h3>
                          <div className="launch-card-symbol">{selectedLaunchMetadata?.symbol || tokenSnapshot.symbol}</div>
                        </div>
                      </div>
                      <p>
                        {selectedLaunchMetadata?.description ||
                          (selectedLaunchMetadataLoading
                            ? "Resolving off-chain metadata for this launch..."
                            : "No off-chain metadata was resolved for this launch yet. The protocol state is live, but discovery metadata may still be missing or hosted elsewhere.")}
                      </p>
                      <div className="metadata-links">
                        {selectedLaunchLinks.length > 0 ? (
                          selectedLaunchLinks.map((link) => (
                            <a key={`${tokenSnapshot.address}-${link.label}`} href={link.href} target="_blank" rel="noreferrer">
                              {link.label}
                            </a>
                          ))
                        ) : (
                          <span>No social links yet</span>
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
                    <div className={`lifecycle-step ${tokenSnapshot.state === "Created" ? "current" : "done"}`}>Created</div>
                    <div className={`lifecycle-step ${isWhitelistCommit ? "current" : tokenSnapshot.whitelistStatus > 0n ? "done" : ""}`}>Whitelist</div>
                    <div className={`lifecycle-step ${isBonding ? "current" : isMigrating || isDexOnly ? "done" : ""}`}>Bonding314</div>
                    <div className={`lifecycle-step ${isMigrating ? "current" : isDexOnly ? "done" : ""}`}>Migrating</div>
                    <div className={`lifecycle-step ${isDexOnly ? "current" : ""}`}>DEXOnly</div>
                  </div>

                  {tokenVerification && (
                    <div className={`callout ${verificationTone}`}>
                      <strong>
                        {tokenVerification.status === "official"
                          ? "Official Autonomous 314 launch"
                          : tokenVerification.status === "warning"
                            ? "Suspicious launch surface"
                            : "Unverified token"}
                      </strong>
                      <p>{tokenVerification.summary}</p>
                      <dl className="data-list compact">
                        <div><dt>Factory match</dt><dd>{String(tokenVerification.checks.factoryMatches)}</dd></div>
                        <div><dt>Factory registry</dt><dd>{String(tokenVerification.checks.factoryRegistryRecognizesToken)}</dd></div>
                        <div><dt>Mode match</dt><dd>{String(tokenVerification.checks.tokenModeMatchesFactory)}</dd></div>
                        <div><dt>Launch event found</dt><dd>{String(tokenVerification.checks.launchEventFound)}</dd></div>
                        <div><dt>Event metadata match</dt><dd>{String(tokenVerification.checks.eventMetadataMatchesToken)}</dd></div>
                        <div><dt>Protocol recipient match</dt><dd>{String(tokenVerification.checks.protocolRecipientMatches)}</dd></div>
                        <div><dt>Router match</dt><dd>{String(tokenVerification.checks.routerMatches)}</dd></div>
                        <div><dt>Graduation target match</dt><dd>{String(tokenVerification.checks.graduationTargetMatches)}</dd></div>
                        <div><dt>Canonical pair match</dt><dd>{String(tokenVerification.checks.pairMatchesDex)}</dd></div>
                        <div><dt>Suffix / mode</dt><dd>{String(tokenVerification.checks.suffixMatchesMode)}</dd></div>
                      </dl>
                    </div>
                  )}

                  <div className={`callout ${pollutionTone}`}>
                    <strong>Graduation compatibility</strong>
                    <p>
                      {tokenSnapshot.pairClean
                        ? "Pair is clean and ready for canonical graduation."
                        : tokenSnapshot.pairGraduationCompatible
                          ? "Quote-side preload exists, so graduation stays live but the opening DEX state is no longer strictly canonical."
                          : "Current pair state is not graduation-compatible. The protocol will not migrate until the pair is valid."}
                    </p>
                  </div>

                  <div className="detail-grid">
                    <dl className="data-list">
                      <div><dt>Token address</dt><dd>{tokenSnapshot.address}</dd></div>
                      <div><dt>Mode</dt><dd>{tokenSnapshot.launchMode}</dd></div>
                      <div><dt>Suffix</dt><dd>{tokenSnapshot.launchSuffix}</dd></div>
                      <div><dt>Metadata URI</dt><dd>{tokenSnapshot.metadataURI}</dd></div>
                      <div><dt>Graduation target</dt><dd>{formatNative(tokenSnapshot.graduationQuoteReserve)}</dd></div>
                      <div><dt>Pair</dt><dd>{tokenSnapshot.pair}</dd></div>
                      <div><dt>Pair clean</dt><dd>{String(tokenSnapshot.pairClean)}</dd></div>
                      <div><dt>Graduation compatible</dt><dd>{String(tokenSnapshot.pairGraduationCompatible)}</dd></div>
                      <div><dt>Preloaded quote</dt><dd>{formatNative(tokenSnapshot.pairPreloadedQuote)}</dd></div>
                      {tokenSnapshot.whitelistSnapshot && (
                        <>
                          <div><dt>Whitelist threshold</dt><dd>{formatNative(tokenSnapshot.whitelistSnapshot.threshold)}</dd></div>
                          <div><dt>Whitelist seat size</dt><dd>{formatNative(tokenSnapshot.whitelistSnapshot.slotSize)}</dd></div>
                          <div><dt>Whitelist seats</dt><dd>{tokenSnapshot.whitelistSnapshot.seatCount.toString()}</dd></div>
                          <div><dt>Whitelist filled</dt><dd>{tokenSnapshot.whitelistSnapshot.seatsFilled.toString()}</dd></div>
                        </>
                      )}
                    </dl>

                    <dl className="data-list">
                      <div><dt>Protocol claimable</dt><dd>{formatNative(tokenSnapshot.protocolClaimable)}</dd></div>
                      <div><dt>Creator claimable</dt><dd>{formatNative(tokenSnapshot.creatorClaimable)}</dd></div>
                      <div><dt>Token protocol recipient</dt><dd>{shortAddress(tokenSnapshot.protocolFeeRecipient)}</dd></div>
                      <div><dt>Creator fee sweep ready</dt><dd>{creatorFeeSweepReady ? "Yes" : "No"}</dd></div>
                      <div><dt>Created at</dt><dd>{formatUnixTimestamp(tokenSnapshot.createdAt)}</dd></div>
                      <div><dt>Last trade at</dt><dd>{formatUnixTimestamp(tokenSnapshot.lastTradeAt)}</dd></div>
                      <div><dt>DEX token reserve</dt><dd>{formatToken(tokenSnapshot.dexTokenReserve)}</dd></div>
                      <div><dt>DEX quote reserve</dt><dd>{formatNative(tokenSnapshot.dexQuoteReserve)}</dd></div>
                      <div><dt>Connected as creator</dt><dd>{connectedAsCreator ? "Yes" : "No"}</dd></div>
                      <div><dt>Status message</dt><dd>{status}</dd></div>
                    </dl>
                  </div>

                  {creatorFeeSweepReady && isBonding && (
                    <div className="callout warn">
                      <strong>Abandoned creator fee sweep is available</strong>
                      <p>
                        This launch has remained in Bonding314 for at least 180 days and has had no trades for 30 days.
                        Anyone may move the unclaimable creator fee vault into the protocol fee vault.
                      </p>
                    </div>
                  )}

                  <div className="history-grid">
                    <article className="subpanel">
                      <div className="subpanel-header">
                        <h3>Price trajectory</h3>
                        <span className="list-item-meta">
                          {dexCandles.length > 0 ? "Segmented protocol / DEX chart" : isBonding ? "Protocol candles" : "DEX handoff mode"}
                        </span>
                      </div>
                      {bondingCandles.length > 0 || dexCandles.length > 0 ? (
                        <SegmentedPhaseChart bondingCandles={bondingCandles} dexCandles={dexCandles} graduationTimestampMs={graduationTimestampMs} />
                      ) : (
                        <div className="empty-state">No protocol or DEX candle data is available in the current lookback window.</div>
                      )}
                    </article>

                    <article className="subpanel">
                      <div className="subpanel-header">
                        <h3>Recent activity</h3>
                        <span className="list-item-meta">{recentActivity.length} events</span>
                      </div>
                      {recentActivity.length === 0 ? (
                        <div className="empty-state">No protocol, migration, or pair activity found in the current lookback window.</div>
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
                                      LP seed · {formatToken(activity.tokenAmount)} token
                                      {activity.preloadedQuoteAmount > 0n ? ` + ${formatNative(activity.preloadedQuoteAmount)} preload` : ""}
                                    </div>
                                  </>
                                ) : (
                                  <>
                                    <strong>{formatNative(activity.netQuote)}</strong>
                                    <div className="trade-meta">{formatToken(activity.tokenAmount)} token</div>
                                  </>
                                )}
                              </div>
                              <div>
                                {activity.kind === "graduated" ? (
                                  <>
                                    <strong>{shortAddress(activity.marketAddress)}</strong>
                                    <div className="trade-meta">{formatToken(activity.liquidityBurned)} LP burned</div>
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
                <div className="empty-state">Load a launch address or select one from the recent launch list to open the workspace.</div>
              )}
            </article>
          </section>

          <aside className="actions-rail">
            <article className="panel" id="trade-panel">
              {isWhitelistCommit && whitelistSnapshot ? (
                <>
                  <h2>Whitelist commit</h2>
                  <div className="create-summary-grid compact">
                    <div><span>Mode</span><strong>b314</strong></div>
                    <div><span>Seat size</span><strong>{formatNative(whitelistSnapshot.slotSize)}</strong></div>
                    <div><span>Filled</span><strong>{whitelistSeatsFilled.toString()}</strong></div>
                    <div><span>Remaining</span><strong>{whitelistSeatsRemaining.toString()}</strong></div>
                  </div>
                  <div className={`callout ${whitelistApproved ? "success" : "warn"} compact-callout`}>
                    <strong>{whitelistApproved ? "Wallet is approved." : "Wallet is not in the whitelist."}</strong>
                    <p>
                      Commit mode uses fixed seats. Each approved address sends the exact seat size once; when the threshold is
                      reached, the whitelist finalizes and allocations become claimable.
                    </p>
                  </div>
                  <div className="button-row stacked">
                    <button onClick={handleWhitelistCommit} disabled={!canCommitWhitelist || walletWrongNetwork || !canWriteVerifiedLaunch}>
                      Commit whitelist seat
                    </button>
                    <button
                      className="secondary-button"
                      onClick={handleClaimWhitelistAllocation}
                      disabled={!canClaimWhitelistAllocationForWallet || walletWrongNetwork || !canWriteVerifiedLaunch}
                    >
                      Claim whitelist allocation
                    </button>
                    <button
                      className="secondary-button"
                      onClick={handleClaimWhitelistRefund}
                      disabled={!canClaimWhitelistRefundForWallet || walletWrongNetwork || !canWriteVerifiedLaunch}
                    >
                      Claim whitelist refund
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <h2>Bonding actions</h2>
                  <label className="field">
                    <span>{`Buy amount (${activeProtocolProfile.nativeSymbol})`}</span>
                    <input value={buyInput} onChange={(e) => setBuyInput(e.target.value)} />
                  </label>
                  <label className="field">
                    <span>Sell amount (token)</span>
                    <input value={sellInput} onChange={(e) => setSellInput(e.target.value)} />
                  </label>
                  <label className="field">
                    <span>Slippage tolerance (bps)</span>
                    <input value={slippageBps} onChange={(e) => setSlippageBps(e.target.value)} />
                  </label>
                  <div className="button-row stacked">
                    <button className="secondary-button" onClick={handlePreviewBuy} disabled={!tokenAddress || !isBonding || !canWriteVerifiedLaunch}>Preview Buy</button>
                    <button onClick={handleExecuteBuy} disabled={!isBonding || walletWrongNetwork || !canWriteVerifiedLaunch}>Execute Buy</button>
                    <button className="secondary-button" onClick={handlePreviewSell} disabled={!tokenAddress || !isBonding || !canWriteVerifiedLaunch}>Preview Sell</button>
                    <button onClick={handleExecuteSell} disabled={!isBonding || walletWrongNetwork || !canWriteVerifiedLaunch}>Execute Sell</button>
                  </div>

                  {buyPreviewState && (
                    <dl className="data-list compact">
                      <div><dt>Buy token out</dt><dd>{formatToken(buyPreviewState.tokenOut)}</dd></div>
                      <div><dt>Buy fee</dt><dd>{formatNative(buyPreviewState.feeAmount)}</dd></div>
                      <div><dt>Refund</dt><dd>{formatNative(buyPreviewState.refundAmount)}</dd></div>
                      <div><dt>Buy min out</dt><dd>{formatToken(applySlippageBps(buyPreviewState.tokenOut, Number(slippageBps || "0")))}</dd></div>
                    </dl>
                  )}

                  {sellPreviewState && (
                    <dl className="data-list compact">
                      <div><dt>Sell gross out</dt><dd>{formatNative(sellPreviewState.grossQuoteOut)}</dd></div>
                      <div><dt>Sell net out</dt><dd>{formatNative(sellPreviewState.netQuoteOut)}</dd></div>
                      <div><dt>Sell fee</dt><dd>{formatNative(sellPreviewState.totalFee)}</dd></div>
                      <div><dt>Sell min out</dt><dd>{formatNative(applySlippageBps(sellPreviewState.netQuoteOut, Number(slippageBps || "0")))}</dd></div>
                    </dl>
                  )}
                </>
              )}
            </article>

            <article className="panel">
              <h2>Claims & permissions</h2>
              <div className="button-row stacked">
                <button
                  className="secondary-button"
                  onClick={handleClaimTokenProtocolFees}
                  disabled={!tokenSnapshot || !connectedAsTokenProtocolRecipient || walletWrongNetwork || !canWriteVerifiedLaunch}
                >
                  Claim token protocol fees
                </button>
                <button className="secondary-button" onClick={handleClaimCreatorFees} disabled={!isDexOnly || !connectedAsCreator || walletWrongNetwork || !canWriteVerifiedLaunch}>
                  Claim creator fees
                </button>
                <button className="secondary-button" onClick={handleSweepCreatorFees} disabled={!tokenSnapshot || !creatorFeeSweepReady || walletWrongNetwork || !canWriteVerifiedLaunch}>
                  Sweep abandoned creator fees
                </button>
              </div>
              <ul className="compact-list">
                <li>Default trading path uses explicit slippage-protected contract calls.</li>
                <li>Raw native transfer buy is disabled in the reference flow; explicit slippage-protected contract calls are the intended path.</li>
                <li>Creator fees claim only after DEXOnly; the protocol only takes 0.3% while creators receive 0.7%.</li>
                <li>Abandoned pre-grad creator fees can be swept after 180 days of age and 30 days without trades.</li>
                <li>Only official factory launches are writable in the reference UI. Suspicious or foreign contracts load in read-only mode.</li>
                <li>When graduation compatibility is false, treat migration as blocked.</li>
              </ul>
              <div className="status-hint">
                Factory create-fee claims require the connected wallet to match the current factory protocol recipient.
                Token fee claims require the connected wallet to match the launch’s immutable protocol fee recipient.
              </div>
            </article>
          </aside>
        </section>
      )}
    </main>
  );
}
