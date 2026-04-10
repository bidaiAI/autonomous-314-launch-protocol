import { createPublicClient, getAddress, http, type Hex } from "viem";
import { launchFactoryAbi } from "./abi";
import { indexerConfig } from "./config";
import {
  explorerApiUsesPostQueryParams,
  withExplorerBaseParams,
  withExplorerVerificationParams
} from "./explorer";
import { resolveIndexerProfile } from "./profiles";
import { fetchLaunchVerificationIntents } from "./verification/launches";
import {
  constructorInputCount,
  encodeConstructorArguments,
  extractConstructorArgumentsFromCreationInput,
  loadContractBuildSpec,
  officialFactoryWhitelistPresetsFor,
  officialBootstrapTargetsFor,
  type BootstrapVerificationTarget
} from "./verification/specs";

type VerificationSource = "official" | "launch";
type VerificationState = "discovered" | "pending" | "verified" | "failed";
type VerificationChannel = "sourcify" | "etherscan";

type VerificationTarget = {
  address: `0x${string}`;
  contractIdentifier: string;
  creationTransactionHash: `0x${string}`;
  constructorArguments: Hex;
  label: string;
  source: VerificationSource;
};

type TrackedVerificationTarget = VerificationTarget & {
  state: VerificationState;
  attempts: number;
  nextAttemptAtMs: number;
  discoveredAtMs: number;
  lastAttemptAtMs: number | null;
  lastMessage: string | null;
  verifiedVia: string | null;
  verifiedAtMs: number | null;
  sourcifyVerificationId: string | null;
  etherscanGuid: string | null;
  sourcifyVerifiedAtMs: number | null;
  etherscanVerifiedAtMs: number | null;
};

type VerificationWorkerSnapshot = {
  enabled: boolean;
  intervalMs: number;
  confirmations: number;
  maxTargetsPerRun: number;
  nextScanBlock: string | null;
  trackedTargets: number;
  pendingTargets: number;
  verifiedTargets: number;
  failedTargets: number;
  running: boolean;
  lastRunStartedAtMs: number | null;
  lastRunFinishedAtMs: number | null;
  lastError: string | null;
  recent: Array<{
    address: `0x${string}`;
    label: string;
    source: VerificationSource;
    state: VerificationState;
    verifiedVia: string | null;
    attempts: number;
    lastMessage: string | null;
    sourcifyVerified: boolean;
    etherscanVerified: boolean;
  }>;
};

const profile = resolveIndexerProfile(indexerConfig.chainId);
const publicClient = createPublicClient({
  chain: profile.viemChain,
  transport: http(indexerConfig.rpcUrl)
});

function nowMs() {
  return Date.now();
}

function backoffMs(attempts: number) {
  if (attempts <= 1) return 15_000;
  if (attempts === 2) return 60_000;
  if (attempts === 3) return 5 * 60_000;
  return Math.min(30 * 60_000, 10 * 60_000 + (attempts - 4) * 5 * 60_000);
}

function toCompilerVersion(compilerVersion: string) {
  return compilerVersion.startsWith("v") ? compilerVersion : `v${compilerVersion}`;
}

class VerificationWorker {
  private readonly trackedTargets = new Map<string, TrackedVerificationTarget>();
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private lastRunStartedAtMs: number | null = null;
  private lastRunFinishedAtMs: number | null = null;
  private lastError: string | null = null;
  private nextScanBlock: bigint | null = null;
  private bootstrapped = false;

  start() {
    if (!indexerConfig.autoVerifyEnabled || this.timer) return;
    void this.runOnce();
    this.timer = setInterval(() => {
      void this.runOnce();
    }, indexerConfig.autoVerifyIntervalMs);
    this.timer.unref();
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  getSnapshot(): VerificationWorkerSnapshot {
    const targets = [...this.trackedTargets.values()];
    const recent = [...targets]
      .sort((a, b) => (b.lastAttemptAtMs ?? b.discoveredAtMs) - (a.lastAttemptAtMs ?? a.discoveredAtMs))
      .slice(0, 12)
      .map((target) => ({
        address: target.address,
        label: target.label,
        source: target.source,
        state: target.state,
        verifiedVia: target.verifiedVia,
        attempts: target.attempts,
        lastMessage: target.lastMessage,
        sourcifyVerified: Boolean(target.sourcifyVerifiedAtMs),
        etherscanVerified: Boolean(target.etherscanVerifiedAtMs)
      }));

    return {
      enabled: indexerConfig.autoVerifyEnabled,
      intervalMs: indexerConfig.autoVerifyIntervalMs,
      confirmations: indexerConfig.autoVerifyMinConfirmations,
      maxTargetsPerRun: indexerConfig.autoVerifyMaxTargetsPerRun,
      nextScanBlock: this.nextScanBlock?.toString() ?? null,
      trackedTargets: targets.length,
      pendingTargets: targets.filter((target) => target.state === "pending" || target.state === "discovered").length,
      verifiedTargets: targets.filter((target) => target.state === "verified").length,
      failedTargets: targets.filter((target) => target.state === "failed").length,
      running: this.running,
      lastRunStartedAtMs: this.lastRunStartedAtMs,
      lastRunFinishedAtMs: this.lastRunFinishedAtMs,
      lastError: this.lastError,
      recent
    };
  }

  async runOnce() {
    if (!indexerConfig.autoVerifyEnabled || this.running) return;
    this.running = true;
    this.lastRunStartedAtMs = nowMs();
    this.lastError = null;

    try {
      await this.ensureBootstrapTargets();
      await this.processDueTargets();
      await this.scanForNewLaunches();
      await this.processDueTargets();
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      console.error("[verifier] run failed", error);
    } finally {
      this.lastRunFinishedAtMs = nowMs();
      this.running = false;
    }
  }

  private async ensureBootstrapTargets() {
    if (this.bootstrapped || !indexerConfig.autoVerifyBootstrapOfficial) return;

    for (const target of officialBootstrapTargetsFor(indexerConfig.chainId, indexerConfig.factoryAddress)) {
      this.trackTarget(await this.buildBootstrapTarget(target));
    }

    this.bootstrapped = true;
  }

  private async buildBootstrapTarget(target: BootstrapVerificationTarget): Promise<VerificationTarget> {
    if (target.contractIdentifier === "contracts/LaunchFactory.sol:LaunchFactory") {
      const [
        owner,
        router,
        protocolFeeRecipient,
        standardDeployer,
        whitelistDeployer,
        taxedDeployer,
        whitelistTaxedDeployer,
        standardCreateFee,
        whitelistCreateFee,
        graduationQuoteReserve
      ] = (await Promise.all([
        publicClient.readContract({ address: target.address, abi: launchFactoryAbi, functionName: "owner" }),
        publicClient.readContract({ address: target.address, abi: launchFactoryAbi, functionName: "router" }),
        publicClient.readContract({
          address: target.address,
          abi: launchFactoryAbi,
          functionName: "protocolFeeRecipient"
        }),
        publicClient.readContract({
          address: target.address,
          abi: launchFactoryAbi,
          functionName: "standardDeployer"
        }),
        publicClient.readContract({
          address: target.address,
          abi: launchFactoryAbi,
          functionName: "whitelistDeployer"
        }),
        publicClient.readContract({ address: target.address, abi: launchFactoryAbi, functionName: "taxedDeployer" }),
        publicClient.readContract({
          address: target.address,
          abi: launchFactoryAbi,
          functionName: "whitelistTaxedDeployer"
        }),
        publicClient.readContract({
          address: target.address,
          abi: launchFactoryAbi,
          functionName: "standardCreateFee"
        }),
        publicClient.readContract({
          address: target.address,
          abi: launchFactoryAbi,
          functionName: "whitelistCreateFee"
        }),
        publicClient.readContract({
          address: target.address,
          abi: launchFactoryAbi,
          functionName: "graduationQuoteReserve"
        })
      ])) as [
        `0x${string}`,
        `0x${string}`,
        `0x${string}`,
        `0x${string}`,
        `0x${string}`,
        `0x${string}`,
        `0x${string}`,
        bigint,
        bigint,
        bigint
      ];
      const whitelistPresets = officialFactoryWhitelistPresetsFor(indexerConfig.chainId);
      if (!whitelistPresets) {
        throw new Error(`Missing official factory whitelist presets for chain ${indexerConfig.chainId}`);
      }

      return {
        ...target,
        constructorArguments: encodeConstructorArguments(target.contractIdentifier, [
          getAddress(owner),
          getAddress(router),
          getAddress(protocolFeeRecipient),
          getAddress(standardDeployer),
          getAddress(whitelistDeployer),
          getAddress(taxedDeployer),
          getAddress(whitelistTaxedDeployer),
          standardCreateFee,
          whitelistCreateFee,
          graduationQuoteReserve,
          whitelistPresets.thresholds,
          whitelistPresets.slotSizes
        ])
      };
    }

    if (constructorInputCount(target.contractIdentifier) === 0) {
      return {
        ...target,
        constructorArguments: "0x"
      };
    }

    const tx = await publicClient.getTransaction({ hash: target.creationTransactionHash });
    return {
      ...target,
      constructorArguments: extractConstructorArgumentsFromCreationInput(target.contractIdentifier, tx.input)
    };
  }

  private async scanForNewLaunches() {
    if (!indexerConfig.factoryAddress) return;

    const latestBlock = await publicClient.getBlockNumber();
    const confirmedBlock = latestBlock > BigInt(indexerConfig.autoVerifyMinConfirmations)
      ? latestBlock - BigInt(indexerConfig.autoVerifyMinConfirmations)
      : 0n;

    if (this.nextScanBlock === null) {
      this.nextScanBlock =
        indexerConfig.fromBlock ??
        (confirmedBlock > indexerConfig.lookbackBlocks ? confirmedBlock - indexerConfig.lookbackBlocks : 0n);
    }

    if (this.nextScanBlock > confirmedBlock) {
      return;
    }

    let intents;
    try {
      intents = await fetchLaunchVerificationIntents(publicClient, {
        factoryAddress: getAddress(indexerConfig.factoryAddress),
        fromBlock: this.nextScanBlock,
        toBlock: confirmedBlock,
        batchBlocks: indexerConfig.logBatchBlocks
      });
    } catch (error) {
      if (await this.shouldSkipPrunedHistoryScan(error)) {
        this.nextScanBlock = confirmedBlock + 1n;
        return;
      }
      throw error;
    }

    for (const intent of intents) {
      this.trackTarget(intent);
    }

    this.nextScanBlock = confirmedBlock + 1n;
  }

  private async shouldSkipPrunedHistoryScan(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/History has been pruned/i.test(message) || !indexerConfig.factoryAddress) {
      return false;
    }

    const totalLaunches = (await publicClient.readContract({
      address: getAddress(indexerConfig.factoryAddress),
      abi: launchFactoryAbi,
      functionName: "totalLaunches"
    })) as bigint;

    if (totalLaunches === 0n) {
      console.warn("[verifier] skipping historical launch scan on pruned RPC because factory has no launches yet");
      return true;
    }
    return false;
  }

  private trackTarget(target: VerificationTarget) {
    const key = target.address.toLowerCase();
    const existing = this.trackedTargets.get(key);
    if (existing) {
      existing.contractIdentifier = target.contractIdentifier;
      existing.creationTransactionHash = target.creationTransactionHash;
      existing.constructorArguments = target.constructorArguments;
      existing.label = target.label;
      existing.source = target.source;
      return existing;
    }

    const tracked: TrackedVerificationTarget = {
      ...target,
      state: "discovered",
      attempts: 0,
      nextAttemptAtMs: nowMs(),
      discoveredAtMs: nowMs(),
      lastAttemptAtMs: null,
      lastMessage: null,
      verifiedVia: null,
      verifiedAtMs: null,
      sourcifyVerificationId: null,
      etherscanGuid: null,
      sourcifyVerifiedAtMs: null,
      etherscanVerifiedAtMs: null
    };

    this.trackedTargets.set(key, tracked);
    return tracked;
  }

  private async processDueTargets() {
    const dueTargets = [...this.trackedTargets.values()]
      .filter((target) => !this.hasSatisfiedDesiredChannels(target) && target.nextAttemptAtMs <= nowMs())
      .sort((a, b) => {
        if (a.source !== b.source) return a.source === "official" ? -1 : 1;
        return a.discoveredAtMs - b.discoveredAtMs;
      })
      .slice(0, indexerConfig.autoVerifyMaxTargetsPerRun);

    for (const target of dueTargets) {
      await this.processTarget(target);
    }
  }

  private async processTarget(target: TrackedVerificationTarget) {
    target.attempts += 1;
    target.lastAttemptAtMs = nowMs();
    target.state = "pending";

    await this.checkSourcifyVerified(target);

    if (indexerConfig.etherscanApiKey) {
      await this.checkEtherscanVerified(target);
    }

    if (this.hasSatisfiedDesiredChannels(target)) {
      this.refreshOverallVerificationState(target);
      return;
    }

    const messages: string[] = [];
    if (!target.sourcifyVerifiedAtMs) {
      const sourcifyResult = await this.submitSourcify(target);
      if (sourcifyResult) {
        messages.push(sourcifyResult);
      }
    }

    if (indexerConfig.etherscanApiKey && !target.etherscanVerifiedAtMs) {
      const etherscanResult = await this.submitEtherscan(target);
      if (etherscanResult) {
        messages.push(etherscanResult);
      }
    }

    if (this.hasSatisfiedDesiredChannels(target)) {
      this.refreshOverallVerificationState(target);
      return;
    }

    target.lastMessage = messages.join(" | ") || target.lastMessage;
    const hasFatalMessage = messages.some((message) => message.toLowerCase().includes("fatal"));
    this.refreshOverallVerificationState(target);
    if (hasFatalMessage && !this.hasSatisfiedRequiredChannels(target)) {
      target.state = "failed";
    }
    target.nextAttemptAtMs = nowMs() + backoffMs(target.attempts);
  }

  private requiredChannels() {
    return ["sourcify"] as const;
  }

  private hasSatisfiedRequiredChannels(target: TrackedVerificationTarget) {
    return this.requiredChannels().every((channel) =>
      channel === "sourcify" ? Boolean(target.sourcifyVerifiedAtMs) : Boolean(target.etherscanVerifiedAtMs)
    );
  }

  private desiredChannels() {
    return indexerConfig.etherscanApiKey
      ? (["sourcify", "etherscan"] as const)
      : (["sourcify"] as const);
  }

  private hasSatisfiedDesiredChannels(target: TrackedVerificationTarget) {
    return this.desiredChannels().every((channel) =>
      channel === "sourcify" ? Boolean(target.sourcifyVerifiedAtMs) : Boolean(target.etherscanVerifiedAtMs)
    );
  }

  private refreshOverallVerificationState(target: TrackedVerificationTarget) {
    const verifiedChannels: VerificationChannel[] = [];
    if (target.sourcifyVerifiedAtMs) verifiedChannels.push("sourcify");
    if (target.etherscanVerifiedAtMs) verifiedChannels.push("etherscan");

    target.verifiedVia = verifiedChannels.length > 0 ? verifiedChannels.join("+") : null;
    if (this.hasSatisfiedDesiredChannels(target)) {
      target.state = "verified";
      target.verifiedAtMs =
        Math.max(target.sourcifyVerifiedAtMs ?? 0, target.etherscanVerifiedAtMs ?? 0) || nowMs();
      target.nextAttemptAtMs = Number.MAX_SAFE_INTEGER;
      return;
    }

    if (this.hasSatisfiedRequiredChannels(target)) {
      target.state = "verified";
      target.verifiedAtMs = Math.max(target.sourcifyVerifiedAtMs ?? 0, target.etherscanVerifiedAtMs ?? 0) || nowMs();
      return;
    }

    target.state = "pending";
  }

  private markChannelVerified(target: TrackedVerificationTarget, via: VerificationChannel, message: string) {
    if (via === "sourcify" && !target.sourcifyVerifiedAtMs) {
      target.sourcifyVerifiedAtMs = nowMs();
    }
    if (via === "etherscan" && !target.etherscanVerifiedAtMs) {
      target.etherscanVerifiedAtMs = nowMs();
    }
    target.lastMessage = message;
    this.refreshOverallVerificationState(target);
  }

  private async checkSourcifyVerified(target: TrackedVerificationTarget) {
    if (target.sourcifyVerifiedAtMs) return true;
    const response = await fetch(
      `${indexerConfig.sourcifyServerUrl}/v2/contract/${indexerConfig.chainId}/${target.address}`
    );
    if (response.ok) {
      this.markChannelVerified(target, "sourcify", "Verified on Sourcify");
      return true;
    }
    if (response.status !== 404) {
      target.lastMessage = `Sourcify lookup returned ${response.status}`;
    }
    return false;
  }

  private async submitSourcify(target: TrackedVerificationTarget) {
    if (target.sourcifyVerifiedAtMs) return null;
    const spec = loadContractBuildSpec(target.contractIdentifier);
    const response = await fetch(
      `${indexerConfig.sourcifyServerUrl}/v2/verify/${indexerConfig.chainId}/${target.address}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          stdJsonInput: spec.stdJsonInput,
          compilerVersion: spec.compilerVersion,
          contractIdentifier: spec.contractIdentifier,
          creationTransactionHash: target.creationTransactionHash
        })
      }
    );

    const body = await safeJson(response);
    if (response.status === 202) {
      target.sourcifyVerificationId = typeof body?.verificationId === "string" ? body.verificationId : null;
      return `Sourcify queued${target.sourcifyVerificationId ? ` (${target.sourcifyVerificationId})` : ""}`;
    }
    if (response.status === 409) {
      this.markChannelVerified(target, "sourcify", body?.message ?? "Already verified on Sourcify");
      return target.lastMessage;
    }

    const message = body?.message ?? `Sourcify ${response.status}`;
    if (response.status >= 400 && response.status < 500 && response.status !== 429) {
      return `Sourcify fatal: ${message}`;
    }
    return `Sourcify pending: ${message}`;
  }

  private async checkEtherscanVerified(target: TrackedVerificationTarget) {
    if (!indexerConfig.etherscanApiKey) return false;
    if (target.etherscanVerifiedAtMs) return true;

    if (target.etherscanGuid) {
      const status = explorerApiUsesPostQueryParams(indexerConfig.etherscanApiUrl)
        ? await this.postEtherscan({
          module: "contract",
          action: "checkverifystatus",
          guid: target.etherscanGuid
        })
        : await this.getEtherscan({
          module: "contract",
          action: "checkverifystatus",
          guid: target.etherscanGuid
        });
      const statusResult = typeof status.result === "string" ? status.result : null;
      if (status.status === "1" && statusResult && /pass/i.test(statusResult)) {
        this.markChannelVerified(target, "etherscan", statusResult);
        return true;
      }
      if (statusResult) {
        target.lastMessage = statusResult;
      }
    }

    const lookup = await this.getEtherscan({
      module: "contract",
      action: "getsourcecode",
      address: target.address
    });
    const first = Array.isArray(lookup.result) ? lookup.result[0] : null;
    const sourceCode = typeof first?.SourceCode === "string" ? first.SourceCode.trim() : "";
    if (lookup.status === "1" && sourceCode && sourceCode !== "Contract source code not verified") {
      this.markChannelVerified(target, "etherscan", "Verified on Etherscan-compatible explorer");
      return true;
    }
    return false;
  }

  private async submitEtherscan(target: TrackedVerificationTarget) {
    if (!indexerConfig.etherscanApiKey) return null;
    if (target.etherscanVerifiedAtMs) return null;

    const spec = loadContractBuildSpec(target.contractIdentifier);
    const optimizerSettings = ((spec.stdJsonInput.settings as Record<string, unknown> | undefined)?.optimizer ??
      {}) as Record<string, unknown>;
    const evmVersion = ((spec.stdJsonInput.settings as Record<string, unknown> | undefined)?.evmVersion ??
      "default") as string;

    const response = await this.postEtherscan(withExplorerVerificationParams({
      apiUrl: indexerConfig.etherscanApiUrl,
      apiKey: indexerConfig.etherscanApiKey,
      chainId: indexerConfig.chainId,
      constructorArguments: target.constructorArguments === "0x" ? "" : target.constructorArguments.slice(2),
      query: {
      module: "contract",
      action: "verifysourcecode",
      contractaddress: target.address,
      sourceCode: JSON.stringify(spec.stdJsonInput),
      codeformat: "solidity-standard-json-input",
      contractname: spec.contractIdentifier,
      compilerversion: toCompilerVersion(spec.compilerVersion),
      optimizationUsed: optimizerSettings.enabled ? "1" : "0",
      runs: String(optimizerSettings.runs ?? 200),
      evmVersion
      }
    }));

    if (response.status === "1" && typeof response.result === "string") {
      target.etherscanGuid = response.result;
      return `Etherscan queued (${response.result})`;
    }
    if (typeof response.result === "string" && /already verified/i.test(response.result)) {
      this.markChannelVerified(target, "etherscan", response.result);
      return response.result;
    }

    if (await this.checkEtherscanVerified(target)) {
      return target.lastMessage;
    }

    return `Etherscan pending: ${response.result ?? response.message ?? "unknown response"}`;
  }

  private explorerBaseParams(params: Record<string, string>) {
    return withExplorerBaseParams({
      apiUrl: indexerConfig.etherscanApiUrl,
      apiKey: indexerConfig.etherscanApiKey,
      chainId: indexerConfig.chainId,
      query: params
    });
  }

  private async postEtherscan(params: Record<string, string>) {
    const payload = new URLSearchParams(this.explorerBaseParams(params));
    let response: Response;

    if (explorerApiUsesPostQueryParams(indexerConfig.etherscanApiUrl)) {
      const url = new URL(indexerConfig.etherscanApiUrl);
      for (const key of ["apikey", "chainid", "module", "action"]) {
        const value = payload.get(key);
        if (value !== null) {
          url.searchParams.set(key, value);
        }
      }
      response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded; charset=utf-8"
        },
        body: payload
      });
    } else {
      response = await fetch(indexerConfig.etherscanApiUrl, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded; charset=utf-8"
        },
        body: payload
      });
    }

    return (await safeJson(response)) as {
      status?: string;
      message?: string;
      result?: string | Array<Record<string, unknown>>;
    };
  }

  private async getEtherscan(params: Record<string, string>) {
    const url = new URL(indexerConfig.etherscanApiUrl);
    for (const [key, value] of Object.entries(this.explorerBaseParams(params))) {
      url.searchParams.set(key, value);
    }
    const response = await fetch(url);
    return (await safeJson(response)) as {
      status?: string;
      message?: string;
      result?: string | Array<Record<string, unknown>>;
    };
  }
}

async function safeJson(response: Response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as Record<string, any>;
  } catch {
    return { message: text };
  }
}

const verificationWorker = new VerificationWorker();

export function startVerificationWorker() {
  verificationWorker.start();
  return verificationWorker;
}

export function stopVerificationWorker() {
  verificationWorker.stop();
}

export function getVerificationWorkerSnapshot() {
  return verificationWorker.getSnapshot();
}

export async function runVerificationSweepOnce() {
  await verificationWorker.runOnce();
  return verificationWorker.getSnapshot();
}
