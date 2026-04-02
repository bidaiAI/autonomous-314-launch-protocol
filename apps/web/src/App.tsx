import { useMemo, useRef, useState } from "react";
import {
  applySlippageBps,
  claimCreatorFees,
  claimFactoryProtocolFees,
  claimTokenProtocolFees,
  connectWallet,
  createLaunch,
  executeBuy,
  executeSell,
  fetchSegmentedChartSnapshot,
  fetchUnifiedActivity,
  formatNative,
  formatDateTime,
  formatToken,
  previewBuy,
  previewSell,
  readFactory,
  readIndexedLaunchWorkspace,
  readRecentLaunchSnapshots,
  readToken
} from "./protocol";
import type { ActivityFeedItem, CandlePoint, FactorySnapshot, TokenSnapshot } from "./types";
import { SegmentedPhaseChart } from "./charts";
import { activeProtocolProfile } from "./profiles";

const protocolSnapshot = {
  preGrad: "314 bonding market, transfers disabled, 1-block sell cooldown",
  postGrad: `${activeProtocolProfile.dexName} only, LP burned, 314 disabled`,
  pollutionRule: `${activeProtocolProfile.wrappedNativeSymbol} donation no longer blocks graduation; LP initialization or token-side pollution still blocks.`
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

export function App() {
  const [wallet, setWallet] = useState<string>("");
  const [factoryAddress, setFactoryAddress] = useState(import.meta.env.VITE_FACTORY_ADDRESS ?? "");
  const [tokenAddress, setTokenAddress] = useState(import.meta.env.VITE_TOKEN_ADDRESS ?? "");
  const [createName, setCreateName] = useState("Autonomous 314");
  const [createSymbol, setCreateSymbol] = useState("A314");
  const [createMetadataUri, setCreateMetadataUri] = useState("ipfs://metadata");
  const [factorySnapshot, setFactorySnapshot] = useState<FactorySnapshot | null>(null);
  const [recentLaunchSnapshots, setRecentLaunchSnapshots] = useState<TokenSnapshot[]>([]);
  const [tokenSnapshot, setTokenSnapshot] = useState<TokenSnapshot | null>(null);
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
  const workspaceRequestRef = useRef(0);

  const isBonding = tokenSnapshot?.state === "Bonding314";
  const isMigrating = tokenSnapshot?.state === "Migrating";
  const isDexOnly = tokenSnapshot?.state === "DEXOnly";
  const connectedAsCreator =
    wallet && tokenSnapshot ? wallet.toLowerCase() === tokenSnapshot.creator.toLowerCase() : false;
  const connectedAsProtocolRecipient =
    wallet && factorySnapshot ? wallet.toLowerCase() === factorySnapshot.protocolFeeRecipient.toLowerCase() : false;

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
      const { account } = await connectWallet();
      setWallet(account);
      setStatus(`Connected: ${account}`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Wallet connection failed");
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

      const { receipt, createdToken } = await createLaunch(factoryAddress, {
        name: createName,
        symbol: createSymbol,
        metadataURI: createMetadataUri,
        createFee: snapshot.createFee
      });

      if (createdToken) {
        setTokenAddress(createdToken);
        await loadLaunchWorkspace(createdToken);
        setStatus(`Create launch confirmed: ${createdToken}`);
      } else {
        setStatus(`Create launch confirmed: ${receipt.transactionHash}`);
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

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <div className="brand-row">
            <span className="badge">Open Launch Protocol</span>
            <span className="section-kicker">Launchpad reference UI</span>
          </div>
          <h1>Autonomous 314</h1>
          <p className="topbar-copy">
            A launchpad-style reference workspace for discovering launches, creating new pools, trading during
            bonding, and handing off cleanly into DEX-only mode after graduation.
          </p>
        </div>
        <button className="secondary-button" onClick={handleConnectWallet}>
          {wallet ? shortAddress(wallet) : "Connect Wallet"}
        </button>
      </header>

      <section className="market-strip">
        <div className="strip-card">
          <span className="metric-label">Chain</span>
          <strong>{runtimeChainLabel}</strong>
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
          <span className="metric-label">Pre-grad mode</span>
          <strong>{protocolSnapshot.preGrad}</strong>
        </div>
        <div className="strip-card">
          <span className="metric-label">Runtime</span>
          <strong>{loading ? "Executing" : "Ready"}</strong>
        </div>
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
              <button className="secondary-button" onClick={handleClaimFactoryFees}>Claim Fees</button>
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
                        onClick={async () => {
                          setTokenAddress(launch.address);
                          try {
                            setLoading(true);
                            await loadLaunchWorkspace(launch.address);
                            setStatus(`Token loaded: ${launch.address}`);
                          } catch (error) {
                            setStatus(error instanceof Error ? error.message : "Failed to load token");
                          } finally {
                            setLoading(false);
                          }
                        }}
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
              <span>Metadata URI</span>
              <input value={createMetadataUri} onChange={(e) => setCreateMetadataUri(e.target.value)} placeholder="ipfs://..." />
            </label>
            <div className="status-hint">
              Launches are created through the open factory. The official UI defaults to protocol-safe paths and emits
              canonical events for third-party indexers.
            </div>
            <div className="status-hint">
              Upfront cost = current on-chain create fee ({factorySnapshot ? formatNative(factorySnapshot.createFee) : "load factory"})
              {" "}+ network gas.
            </div>
            <button onClick={handleCreateLaunch}>Create Launch</button>
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
              <button className="secondary-button" onClick={handlePreviewBuy} disabled={!tokenAddress}>Refresh Buy Quote</button>
              <button className="secondary-button" onClick={handlePreviewSell} disabled={!tokenAddress}>Refresh Sell Quote</button>
            </div>

            {tokenSnapshot ? (
              <>
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
                        ? "Quote-side donation exists, but graduation still remains compatible."
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
                    <div><dt>DEX token reserve</dt><dd>{formatToken(tokenSnapshot.dexTokenReserve)}</dd></div>
                    <div><dt>DEX quote reserve</dt><dd>{formatNative(tokenSnapshot.dexQuoteReserve)}</dd></div>
                    <div><dt>Connected as creator</dt><dd>{connectedAsCreator ? "Yes" : "No"}</dd></div>
                    <div><dt>Status message</dt><dd>{status}</dd></div>
                  </dl>
                </div>

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
              <button className="secondary-button" onClick={handlePreviewBuy} disabled={!tokenAddress}>Preview Buy</button>
              <button onClick={handleExecuteBuy} disabled={!isBonding}>Execute Buy</button>
              <button className="secondary-button" onClick={handlePreviewSell} disabled={!tokenAddress}>Preview Sell</button>
              <button onClick={handleExecuteSell} disabled={!isBonding}>Execute Sell</button>
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
              <button className="secondary-button" onClick={handleClaimTokenProtocolFees} disabled={!tokenSnapshot}>
                Claim token protocol fees
              </button>
              <button className="secondary-button" onClick={handleClaimCreatorFees} disabled={!isDexOnly || !connectedAsCreator}>
                Claim creator fees
              </button>
            </div>
            <ul className="compact-list">
              <li>Default trading path uses explicit slippage-protected contract calls.</li>
              <li>Raw native transfer buy is not exposed as the primary UI path.</li>
              <li>Creator fee claim stays disabled until DEXOnly.</li>
              <li>When graduation compatibility is false, treat migration as blocked.</li>
            </ul>
          </article>
        </aside>
      </section>
    </main>
  );
}
