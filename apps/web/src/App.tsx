import { useEffect, useMemo, useRef, useState } from "react";
import {
  applySlippageBps,
  buildInlineMetadataUri,
  buildLaunchMetadata,
  claimCreatorFees,
  claimFactoryProtocolFees,
  claimTokenProtocolFees,
  connectWallet,
  createLaunch,
  downloadLaunchMetadata,
  executeBuy,
  executeSell,
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
  switchWalletToExpectedChain,
  sweepAbandonedCreatorFees
} from "./protocol";
import type { ActivityFeedItem, CandlePoint, FactorySnapshot, LaunchMetadata, TokenSnapshot } from "./types";
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
  const [wallet, setWallet] = useState<string>("");
  const [factoryAddress, setFactoryAddress] = useState(import.meta.env.VITE_FACTORY_ADDRESS ?? "");
  const [tokenAddress, setTokenAddress] = useState(import.meta.env.VITE_TOKEN_ADDRESS ?? "");
  const [createName, setCreateName] = useState("Autonomous 314");
  const [createSymbol, setCreateSymbol] = useState("A314");
  const [createDescription, setCreateDescription] = useState("");
  const [createImageUrl, setCreateImageUrl] = useState("");
  const [createImagePreview, setCreateImagePreview] = useState("");
  const [createImageFileName, setCreateImageFileName] = useState("");
  const [createWebsite, setCreateWebsite] = useState("");
  const [createTwitter, setCreateTwitter] = useState("");
  const [createTelegram, setCreateTelegram] = useState("");
  const [createDiscord, setCreateDiscord] = useState("");
  const [createMetadataUri, setCreateMetadataUri] = useState("");
  const [factorySnapshot, setFactorySnapshot] = useState<FactorySnapshot | null>(null);
  const [recentLaunchSnapshots, setRecentLaunchSnapshots] = useState<TokenSnapshot[]>([]);
  const [tokenSnapshot, setTokenSnapshot] = useState<TokenSnapshot | null>(null);
  const [launchMetadataByToken, setLaunchMetadataByToken] = useState<Partial<Record<string, LaunchMetadata | null>>>({});
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

  const pollutionTone = useMemo(() => {
    if (!tokenSnapshot) return "neutral";
    if (tokenSnapshot.pairClean) return "success";
    if (tokenSnapshot.pairGraduationCompatible) return "warn";
    return "danger";
  }, [tokenSnapshot]);

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

  async function refreshWalletNetworkStatus() {
    const chainId = await getWalletChainId();
    const onExpectedChain = chainId === null ? true : await isWalletOnExpectedChain();
    setWalletChainId(chainId);
    setWalletOnExpectedChain(onExpectedChain);
    return { chainId, onExpectedChain };
  }

  async function loadLaunchWorkspace(address: string, preferIndexed = true) {
    const requestId = ++workspaceRequestRef.current;
    const snapshot = await readToken(address);
    const indexed = preferIndexed ? await readIndexedLaunchWorkspace(address) : null;
    const [activity, chart] = indexed
      ? [indexed.recentActivity, indexed.segmentedChart]
      : await Promise.all([fetchUnifiedActivity(address), fetchSegmentedChartSnapshot(address)]);

    if (requestId !== workspaceRequestRef.current) {
      return snapshot;
    }

    setTokenSnapshot(snapshot);
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
      await loadLaunchWorkspace(tokenAddress);
      setStatus("Token loaded");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Failed to load token");
    } finally {
      setLoading(false);
    }
  }

  async function handleSelectLaunch(address: string) {
    setTokenAddress(address);
    try {
      setLoading(true);
      await loadLaunchWorkspace(address);
      setStatus(`Token loaded: ${address}`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Failed to load token");
    } finally {
      setLoading(false);
    }
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
      const finalMetadataUri = createMetadataUri.trim() || generatedInlineMetadataUri;
      if (!finalMetadataUri) {
        throw new Error(
          usingUploadedImage
            ? "Local image upload is ready for preview/export, but you still need to upload metadata externally and paste a metadata URI before creating."
            : "Provide a metadata URI or use generated inline metadata first."
        );
      }
      setStatus("Mining vanity salt for suffix 0314...");

      const { receipt, createdToken, vanity } = await createLaunch(factoryAddress, {
        name: createName,
        symbol: createSymbol,
        metadataURI: finalMetadataUri,
        createFee: snapshot.createFee,
        onVanityProgress: ({ attempts, elapsedMs }) => {
          setStatus(`Mining vanity salt for suffix 0314... ${attempts.toLocaleString()} attempts · ${(elapsedMs / 1000).toFixed(1)}s`);
        }
      });

      if (createdToken) {
        setTokenAddress(createdToken);
        await loadLaunchWorkspace(createdToken);
        setStatus(
          `Create launch confirmed: ${createdToken} (0314 vanity found in ${vanity.attempts.toLocaleString()} attempts / ${(vanity.elapsedMs / 1000).toFixed(1)}s)`
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

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <div className="brand-row">
            <span className="badge">Creator-first open launch protocol</span>
            <span className="section-kicker">Reference launchpad for a sovereign EVM standard</span>
          </div>
          <h1>Autonomous 314</h1>
          <p className="topbar-copy">
            A creator-first launch protocol for Web3: pre-graduation trading lives inside the launch contract itself,
            not inside a closed platform. Projects can launch, trade, graduate, and continue on a canonical DEX even
            if no platform frontend exists. The protocol keeps only 0.3% and routes 0.7% to creators instead of
            normalizing platform-first 1% extraction.
          </p>
        </div>
        <button className="secondary-button" onClick={handleConnectWallet}>
          {wallet ? shortAddress(wallet) : "Connect Wallet"}
        </button>
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

      <section className="market-strip">
        <div className="strip-card">
          <span className="metric-label">Economics</span>
          <strong>{protocolSnapshot.economics}</strong>
        </div>
        <div className="strip-card">
          <span className="metric-label">Graduation</span>
          <strong>
            {displayedGraduationTarget > 0n
              ? `${formatNative(displayedGraduationTarget)} protocol seed + 20% token reserve`
              : "Configurable protocol seed + 20% token reserve"}
          </strong>
        </div>
        <div className="strip-card">
          <span className="metric-label">Autonomy</span>
          <strong>{protocolSnapshot.sovereignty}</strong>
        </div>
        <div className="strip-card">
          <span className="metric-label">Official profile</span>
          <strong>{runtimeChainLabel} · {activeProtocolProfile.dexName}</strong>
        </div>
      </section>

      <section className="manifesto-grid">
        <article className="manifesto-card">
          <span className="metric-label">Why this exists</span>
          <h3>Launches should not need a platform to exist.</h3>
          <p>
            The launch contract is the system: it holds the pre-grad market, the reserves, the graduation rules, and
            the DEX handoff. Frontends and indexers improve usability, but they are not the source of truth.
          </p>
        </article>
        <article className="manifesto-card">
          <span className="metric-label">Creator-first economics</span>
          <h3>More of the fee stays with the project.</h3>
          <p>
            Instead of sending the whole 1% to a platform, this protocol routes 0.7% to creators and only 0.3% to the
            protocol. The goal is adoption, not rent extraction.
          </p>
        </article>
        <article className="manifesto-card">
          <span className="metric-label">Web3 alignment</span>
          <h3>Open, composable, and not platform-custodied.</h3>
          <p>
            Anyone can integrate the contracts, build their own UI, or run their own indexer. The official interface is
            a reference implementation, not a gatekeeper.
          </p>
        </article>
      </section>

      <section className="market-board">
        <div className="section-header">
          <div>
            <span className="section-kicker">Market board</span>
            <h2>Pump-style launch cards backed by protocol state</h2>
          </div>
          <span className="list-item-meta">
            {recentLaunchSnapshots.length} recent {recentLaunchSnapshots.length === 1 ? "launch" : "launches"}
          </span>
        </div>

        {recentLaunchSnapshots.length === 0 ? (
          <div className="empty-state">
            No launches have been created yet. Create one from the left rail and it will appear here with protocol state,
            metadata, and graduation progress.
          </div>
        ) : (
          <div className="launch-card-grid">
            {recentLaunchSnapshots.map((launch) => {
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
                        <div className="launch-card-symbol">{metadata?.symbol || launch.symbol}</div>
                      </div>
                      <div className="launch-card-price">{formatNative(launch.currentPriceQuotePerToken)}</div>
                    </div>
                    <p className="launch-card-description">
                      {metadata?.description ||
                        "Metadata has not been resolved yet, but the on-chain launch is live and can already be explored through the protocol workspace."}
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

      <section className="workspace-grid">
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
                  <div><dt>Current on-chain create fee</dt><dd>{formatNative(factorySnapshot.createFee)}</dd></div>
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
                    recentLaunchSnapshots.map((launch) => (
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
                {connectedAsProtocolRecipient && (
                  <div className="status-hint">Connected wallet matches the protocol fee recipient.</div>
                )}
              </>
            )}
          </article>

          <article className="panel">
            <h2>Create launch</h2>
            <label className="field">
              <span>Name</span>
              <input value={createName} onChange={(e) => setCreateName(e.target.value)} placeholder="Token name" />
            </label>
            <label className="field">
              <span>Symbol</span>
              <input value={createSymbol} onChange={(e) => setCreateSymbol(e.target.value)} placeholder="TOKEN" />
            </label>
            <label className="field">
              <span>Description</span>
              <textarea
                value={createDescription}
                onChange={(e) => setCreateDescription(e.target.value)}
                placeholder="Explain what this launch is, who it is for, and why it exists."
                rows={4}
              />
            </label>
            <div className="metadata-two-column">
              <label className="field">
                <span>Image URL</span>
                <input
                  value={createImageUrl}
                  onChange={(e) => setCreateImageUrl(e.target.value)}
                  placeholder="https://... or ipfs://..."
                />
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
            <div className="callout warn compact-callout">
              <strong>Upload is not a publish step.</strong>
              <p>
                Local image upload only powers preview and metadata export. The protocol does not pin media for you, so
                a production launch still needs a permanent metadata URI such as IPFS, Arweave, or an HTTPS endpoint you
                control.
              </p>
              {createImageFileName && <p>Selected local file: {createImageFileName}</p>}
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
            <div className="metadata-preview-card">
              <div className="metadata-preview-head">
                <div>
                  <span className="metric-label">Metadata preview</span>
                  <strong>{createName || "Untitled launch"}</strong>
                </div>
                <span className="status-pill success">{createSymbol || "TKN"}</span>
              </div>
              <div className="metadata-preview-body">
                <div className="metadata-image-shell">
                  {resolvePreviewImage(launchMetadata.image ?? "") ? (
                    <img
                      className="metadata-image"
                      src={resolvePreviewImage(launchMetadata.image ?? "")}
                      alt={`${createName || "Launch"} preview`}
                    />
                  ) : (
                    <div className="metadata-image-placeholder">No image yet</div>
                  )}
                </div>
                <div className="metadata-preview-copy">
                  <p>{launchMetadata.description || "Add a description, image, and links to make launch cards look more like a real Pump-style market."}</p>
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
            <div className="status-hint">
              Only <strong>name</strong>, <strong>symbol</strong>, and <strong>metadataURI</strong> go on-chain. Rich launch
              content like description, image, website, and social links belongs in the metadata JSON the URI points to.
            </div>
            <div className="status-hint">
              Official creates first mine a CREATE2 salt locally so the new launch address ends with <strong>0314</strong>,
              then submit <code>createLaunchWithSalt(...)</code>.
            </div>
            <div className="status-hint">
              {generatedInlineMetadataUri
                ? `Generated inline metadata is ready (${metadataUriSizeBytes.toLocaleString()} bytes).`
                : usingUploadedImage
                  ? "A local uploaded image is great for preview/export, but you still need to publish metadata externally and paste its URI before creating."
                  : "You can paste a permanent metadata URI or generate an inline one for lightweight launches."}
            </div>
            <div className="status-hint">
              Upfront cost = current on-chain create fee ({factorySnapshot ? formatNative(factorySnapshot.createFee) : "load factory"}) + network gas.
            </div>
            <button onClick={handleCreateLaunch} disabled={walletWrongNetwork}>Create Launch</button>
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

            <label className="field">
              <span>Launch token address</span>
              <input value={tokenAddress} onChange={(e) => setTokenAddress(e.target.value)} placeholder="0x..." />
            </label>
            <div className="button-row">
              <button onClick={handleLoadToken}>Load Launch</button>
              <button className="secondary-button" onClick={handlePreviewBuy} disabled={!tokenAddress || !isBonding}>Refresh Buy Quote</button>
              <button className="secondary-button" onClick={handlePreviewSell} disabled={!tokenAddress || !isBonding}>Refresh Sell Quote</button>
            </div>

            {tokenSnapshot ? (
              <>
                <div className="launch-hero">
                  <div className="launch-hero-media">
                    {resolvePreviewImage(selectedLaunchMetadata?.image ?? "") ? (
                      <img
                        src={resolvePreviewImage(selectedLaunchMetadata?.image ?? "")}
                        alt={`${selectedLaunchMetadata?.name || tokenSnapshot.name} cover`}
                      />
                    ) : (
                      <div className="launch-card-placeholder large">{tokenSnapshot.symbol.slice(0, 8)}</div>
                    )}
                  </div>
                  <div className="launch-hero-copy">
                    <div className="launch-hero-head">
                      <div>
                        <span className="section-kicker">Selected launch</span>
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
                      {launchMetadataLinks(selectedLaunchMetadata).length > 0 ? (
                        launchMetadataLinks(selectedLaunchMetadata).map((link) => (
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
                    <span className="metric-label">Remaining quote capacity</span>
                    <strong>{formatNative(tokenSnapshot.remainingQuoteCapacity)}</strong>
                  </div>
                  <div>
                    <span className="metric-label">Creator</span>
                    <strong>{shortAddress(tokenSnapshot.creator)}</strong>
                  </div>
                </div>

                <div className="progress-shell" aria-hidden="true">
                  <div
                    className="progress-fill"
                    style={{ width: `${Math.min(100, Number(tokenSnapshot.graduationProgressBps) / 100)}%` }}
                  />
                </div>

                <div className="lifecycle-row">
                  <div className={`lifecycle-step ${tokenSnapshot.state === "Created" ? "current" : "done"}`}>Created</div>
                  <div className={`lifecycle-step ${isBonding ? "current" : isMigrating || isDexOnly ? "done" : ""}`}>Bonding314</div>
                  <div className={`lifecycle-step ${isMigrating ? "current" : isDexOnly ? "done" : ""}`}>Migrating</div>
                  <div className={`lifecycle-step ${isDexOnly ? "current" : ""}`}>DEXOnly</div>
                </div>

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
                    <div><dt>Metadata URI</dt><dd>{tokenSnapshot.metadataURI}</dd></div>
                    <div><dt>Graduation target</dt><dd>{formatNative(tokenSnapshot.graduationQuoteReserve)}</dd></div>
                    <div><dt>Pair</dt><dd>{tokenSnapshot.pair}</dd></div>
                    <div><dt>Pair clean</dt><dd>{String(tokenSnapshot.pairClean)}</dd></div>
                    <div><dt>Graduation compatible</dt><dd>{String(tokenSnapshot.pairGraduationCompatible)}</dd></div>
                    <div><dt>Preloaded quote</dt><dd>{formatNative(tokenSnapshot.pairPreloadedQuote)}</dd></div>
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
                      <SegmentedPhaseChart
                        bondingCandles={bondingCandles}
                        dexCandles={dexCandles}
                        graduationTimestampMs={graduationTimestampMs}
                      />
                    ) : (
                      <div className="empty-state">
                        No protocol or DEX candle data is available in the current lookback window.
                      </div>
                    )}
                  </article>

                  <article className="subpanel">
                    <div className="subpanel-header">
                      <h3>Recent activity</h3>
                      <span className="list-item-meta">{recentActivity.length} events</span>
                    </div>
                    {recentActivity.length === 0 ? (
                      <div className="empty-state">
                        No protocol, migration, or pair activity found in the current lookback window.
                      </div>
                    ) : (
                      <div className="trade-list">
                        {recentActivity.map((activity) => (
                          <div
                            key={`${activity.txHash}-${activity.blockNumber.toString()}-${activity.logIndex}`}
                            className={`trade-row ${activityTone(activity)}`}
                          >
                            <div>
                              <strong>{activityLabel(activity)}</strong>
                              <div className="trade-meta">
                                {formatDateTime(activity.timestampMs)} · {activityPhaseLabel(activity)}
                              </div>
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
              <div className="empty-state">
                Load a launch address or create a new token to open the launch workspace.
              </div>
            )}
          </article>
        </section>

        <aside className="actions-rail">
          <article className="panel">
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
              <button className="secondary-button" onClick={handlePreviewBuy} disabled={!tokenAddress || !isBonding}>Preview Buy</button>
              <button onClick={handleExecuteBuy} disabled={!isBonding || walletWrongNetwork}>Execute Buy</button>
              <button className="secondary-button" onClick={handlePreviewSell} disabled={!tokenAddress || !isBonding}>Preview Sell</button>
              <button onClick={handleExecuteSell} disabled={!isBonding || walletWrongNetwork}>Execute Sell</button>
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
          </article>

          <article className="panel">
            <h2>Claims & permissions</h2>
            <div className="button-row stacked">
              <button
                className="secondary-button"
                onClick={handleClaimTokenProtocolFees}
                disabled={!tokenSnapshot || !connectedAsTokenProtocolRecipient || walletWrongNetwork}
              >
                Claim token protocol fees
              </button>
              <button className="secondary-button" onClick={handleClaimCreatorFees} disabled={!isDexOnly || !connectedAsCreator || walletWrongNetwork}>
                Claim creator fees
              </button>
              <button className="secondary-button" onClick={handleSweepCreatorFees} disabled={!tokenSnapshot || !creatorFeeSweepReady || walletWrongNetwork}>
                Sweep abandoned creator fees
              </button>
            </div>
            <ul className="compact-list">
              <li>Default trading path uses explicit slippage-protected contract calls.</li>
              <li>Raw native transfer buy is disabled in the reference flow; explicit slippage-protected contract calls are the intended path.</li>
              <li>Creator fees claim only after DEXOnly; the protocol only takes 0.3% while creators receive 0.7%.</li>
              <li>Abandoned pre-grad creator fees can be swept after 180 days of age and 30 days without trades.</li>
              <li>When graduation compatibility is false, treat migration as blocked.</li>
            </ul>
            <div className="status-hint">
              Factory create-fee claims require the connected wallet to match the current factory protocol recipient.
              Token fee claims require the connected wallet to match the launch’s immutable protocol fee recipient.
            </div>
          </article>
        </aside>
      </section>
    </main>
  );
}
