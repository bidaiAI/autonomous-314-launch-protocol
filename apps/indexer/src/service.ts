import { createPublicClient, getAddress, hexToBigInt, hexToNumber, http, keccak256, stringToHex, type Hex, type Log } from "viem";
import { launchTokenAbi, v2PairAbi } from "./abi";
import { buildCandlesFromTrades } from "./candles";
import { indexerConfig } from "./config";
import { resolveIndexerProfile } from "./profiles";
import { normalizeGraduatedActivity, normalizePairTrade, normalizeProtocolTrade } from "./normalizers";
import type {
  IndexerSnapshot,
  LaunchMode,
  LaunchState,
  LaunchWorkspaceSnapshot,
  TaxConfigSnapshot,
  TradeRecord,
  WhitelistSnapshot
} from "./schema";

const launchStates = ["Created", "Bonding314", "Migrating", "DEXOnly", "WhitelistCommit"] as const;
const launchModeLabels: Record<number, LaunchMode> = {
  0: "Unregistered",
  1: "Standard0314",
  2: "WhitelistB314",
  3: "Taxed1314",
  4: "Taxed2314",
  5: "Taxed3314",
  6: "Taxed4314",
  7: "Taxed5314",
  8: "Taxed6314",
  9: "Taxed7314",
  10: "Taxed8314",
  11: "Taxed9314",
  12: "WhitelistTaxF314"
} as const;
const zeroAddress = "0x0000000000000000000000000000000000000000";
const legacyFactoryAbi = [
  {
    type: "function",
    name: "totalLaunches",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }]
  },
  {
    type: "function",
    name: "allLaunches",
    stateMutability: "view",
    inputs: [{ name: "", type: "uint256" }],
    outputs: [{ name: "", type: "address" }]
  }
] as const;
const erc20BalanceOfAbi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }]
  }
] as const;
const buyExecutedTopic = eventTopic(
  "BuyExecuted(address,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256)"
);
const sellExecutedTopic = eventTopic(
  "SellExecuted(address,uint256,uint256,uint256,uint256,uint256,uint256,uint256)"
);
const graduatedTopic = eventTopic("Graduated(address,uint256,uint256,uint256,uint256)");
const swapTopic = eventTopic("Swap(address,uint256,uint256,uint256,uint256,address)");

async function readPairStatus(
  client: ReturnType<typeof createPublicClient>,
  tokenAddress: `0x${string}`,
  pair: `0x${string}`,
  wrappedNative: `0x${string}`
) {
  if (pair === zeroAddress) {
    return {
      pairPreloadedQuote: 0n,
      pairClean: false,
      pairGraduationCompatible: false
    };
  }

  const [pairSupply, reserves, token0, token1, tokenBalanceAtPair, quoteBalanceAtPair] = (await client.multicall({
    allowFailure: false,
    contracts: [
      { address: pair, abi: v2PairAbi, functionName: "totalSupply" },
      { address: pair, abi: v2PairAbi, functionName: "getReserves" },
      { address: pair, abi: v2PairAbi, functionName: "token0" },
      { address: pair, abi: v2PairAbi, functionName: "token1" },
      { address: tokenAddress, abi: erc20BalanceOfAbi, functionName: "balanceOf", args: [pair] },
      { address: wrappedNative, abi: erc20BalanceOfAbi, functionName: "balanceOf", args: [pair] }
    ]
  })) as unknown as [
    bigint,
    readonly [bigint, bigint, number],
    `0x${string}`,
    `0x${string}`,
    bigint,
    bigint
  ];

  const quoteReserve =
    token0.toLowerCase() === wrappedNative.toLowerCase()
      ? reserves[0]
      : token1.toLowerCase() === wrappedNative.toLowerCase()
        ? reserves[1]
        : 0n;
  const tokenReserve =
    token0.toLowerCase() === tokenAddress.toLowerCase()
      ? reserves[0]
      : token1.toLowerCase() === tokenAddress.toLowerCase()
        ? reserves[1]
        : 0n;

  return {
    pairPreloadedQuote: quoteBalanceAtPair,
    pairClean: pairSupply === 0n && tokenReserve === 0n && quoteReserve === 0n && tokenBalanceAtPair === 0n && quoteBalanceAtPair === 0n,
    pairGraduationCompatible: pairSupply === 0n && tokenReserve === 0n && tokenBalanceAtPair === 0n
  };
}

export async function buildIndexerSnapshot(): Promise<IndexerSnapshot> {
  if (!indexerConfig.factoryAddress) {
    throw new Error("INDEXER_FACTORY_ADDRESS is required");
  }

  const profile = resolveIndexerProfile(indexerConfig.chainId);

  const client = createPublicClient({
    chain: profile.viemChain,
    transport: http(indexerConfig.rpcUrl)
  });

  const latestBlock = await client.getBlockNumber();
  const snapshotToBlock =
    indexerConfig.toBlock && indexerConfig.toBlock < latestBlock
      ? indexerConfig.toBlock
      : latestBlock;
  const fromBlock =
    indexerConfig.fromBlock ??
    (snapshotToBlock > indexerConfig.lookbackBlocks ? snapshotToBlock - indexerConfig.lookbackBlocks : 0n);

  const factoryAddress = getAddress(indexerConfig.factoryAddress);
  const totalLaunches = (await client.readContract({
    address: factoryAddress,
    abi: legacyFactoryAbi,
    functionName: "totalLaunches"
  })) as bigint;
  const launchCount = Number(totalLaunches > BigInt(indexerConfig.launchLimit) ? BigInt(indexerConfig.launchLimit) : totalLaunches);
  const launches =
    launchCount === 0
      ? []
      : ((await client.multicall({
          allowFailure: false,
          contracts: Array.from({ length: launchCount }, (_unused, offset) => ({
            address: factoryAddress,
            abi: legacyFactoryAbi,
            functionName: "allLaunches" as const,
            args: [totalLaunches - 1n - BigInt(offset)] as const
          }))
        })) as unknown as `0x${string}`[]);

  const workspaceSnapshots: LaunchWorkspaceSnapshot[] = [];

  for (const token of launches) {
    const tokenSnapshot = await readLaunchSnapshot(client, token);
    let tokenLogs: Log[] = [];
    try {
      tokenLogs = await getLogsChunked(client, {
        address: token,
        topics: [[buyExecutedTopic, sellExecutedTopic, graduatedTopic]],
        fromBlock,
        toBlock: snapshotToBlock
      });
    } catch {
      tokenLogs = [];
    }
    const orderedTokenLogs = [...tokenLogs].sort(compareLogsAsc);
    const tokenTimes = await buildBlockTimes(client, orderedTokenLogs);

    const protocolTrades: TradeRecord[] = [];
    const dexTrades: TradeRecord[] = [];
    const activities: LaunchWorkspaceSnapshot["recentActivity"] = [];
    let graduationBlock: bigint | null = null;
    let graduationTimestampMs: number | null = null;
    let graduationPair = tokenSnapshot.pair;

    for (const log of orderedTokenLogs) {
      const timestampMs = tokenTimes.get((log.blockNumber ?? 0n).toString()) ?? Date.now();
      const protocolTrade = normalizeProtocolTrade(log, timestampMs);
      if (protocolTrade) {
        protocolTrades.push(protocolTrade);
        activities.push(protocolTrade);
        continue;
      }

      const graduated = normalizeGraduatedActivity(log, timestampMs);
      if (graduated) {
        graduationBlock = graduated.blockNumber;
        graduationTimestampMs = graduated.timestampMs;
        graduationPair = graduated.marketAddress;
        activities.push(graduated);
      }
    }

    if ((graduationBlock !== null || tokenSnapshot.state === "DEXOnly") && graduationPair !== zeroAddress) {
      const [token0, token1] = (await client.multicall({
        allowFailure: false,
        contracts: [
          { address: graduationPair, abi: v2PairAbi, functionName: "token0" },
          { address: graduationPair, abi: v2PairAbi, functionName: "token1" }
        ]
      })) as unknown as [`0x${string}`, `0x${string}`];

      let pairLogs: Log[] = [];
      try {
        pairLogs = await getLogsChunked(client, {
          address: graduationPair,
          topics: [[swapTopic]],
          fromBlock: graduationBlock && graduationBlock > fromBlock ? graduationBlock : fromBlock,
          toBlock: snapshotToBlock
        });
      } catch {
        pairLogs = [];
      }
      const orderedPairLogs = [...pairLogs].sort(compareLogsAsc);
      const pairTimes = await buildBlockTimes(client, orderedPairLogs);

      for (const log of orderedPairLogs) {
        const timestampMs = pairTimes.get((log.blockNumber ?? 0n).toString()) ?? graduationTimestampMs ?? Date.now();
        const dexTrade = normalizePairTrade(log, timestampMs, token, graduationPair, token0, token1);
        if (!dexTrade) continue;
        dexTrades.push(dexTrade);
        activities.push(dexTrade);
      }
    }

    const recentActivity = [...activities]
      .sort(compareActivityDesc)
      .slice(0, indexerConfig.activityLimitPerLaunch);

    workspaceSnapshots.push({
      ...tokenSnapshot,
      recentActivity,
      segmentedChart: {
        bondingCandles: buildCandlesFromTrades(protocolTrades),
        dexCandles: buildCandlesFromTrades(dexTrades),
        graduationTimestampMs
      }
    });
  }

  return {
    generatedAtMs: Date.now(),
    chainId: indexerConfig.chainId,
    chain: indexerConfig.chain,
    nativeSymbol: profile.nativeSymbol,
    wrappedNativeSymbol: profile.wrappedNativeSymbol,
    dexName: profile.dexName,
    factory: getAddress(indexerConfig.factoryAddress),
    fromBlock: fromBlock.toString(),
    toBlock: snapshotToBlock.toString(),
    launchCount: workspaceSnapshots.length,
    launches: workspaceSnapshots
  };
}

async function getLogsChunked(
  client: ReturnType<typeof createPublicClient>,
  params: {
    address: `0x${string}`;
    topics?: (Hex | Hex[] | null)[];
    fromBlock: bigint;
    toBlock: bigint;
  }
) {
  const configuredBatch = indexerConfig.logBatchBlocks > 0n ? indexerConfig.logBatchBlocks : 2_000n;
  return getLogsChunkedWithBatch(client, params, configuredBatch);
}

async function getLogsChunkedWithBatch(
  client: ReturnType<typeof createPublicClient>,
  params: {
    address: `0x${string}`;
    topics?: (Hex | Hex[] | null)[];
    fromBlock: bigint;
    toBlock: bigint;
  },
  batch: bigint
): Promise<Log[]> {
  if (params.fromBlock > params.toBlock) {
    return [] as Log[];
  }

  const safeBatch = batch > 0n ? batch : 2_000n;
  if (params.toBlock - params.fromBlock + 1n <= safeBatch) {
    return requestLogsChunk(client, params, safeBatch);
  }

  const logs: Log[] = [];

  let cursor = params.fromBlock;
  while (cursor <= params.toBlock) {
    const end = cursor + safeBatch - 1n > params.toBlock ? params.toBlock : cursor + safeBatch - 1n;
    try {
      const chunk = await client.request({
        method: "eth_getLogs",
        params: [
          {
            address: params.address,
            topics: params.topics,
            fromBlock: `0x${cursor.toString(16)}`,
            toBlock: `0x${end.toString(16)}`
          }
        ]
      });
      logs.push(...chunk.map((entry) => rpcLogToLog(entry as any)));
      cursor = end + 1n;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const prunedHistory =
        message.toLowerCase().includes("history has been pruned") ||
        message.toLowerCase().includes("pruned for this block");
      if (prunedHistory) {
        cursor = end + 1n;
        continue;
      }
      if (safeBatch <= 50n) {
        throw error;
      }
      const narrowedBatch = safeBatch / 2n;
      const retried = await getLogsChunkedWithBatch(
        client,
        {
          address: params.address,
          topics: params.topics,
          fromBlock: cursor,
          toBlock: end
        },
        narrowedBatch
      );
      logs.push(...retried);
      cursor = end + 1n;
    }
  }

  return logs;
}

async function requestLogsChunk(
  client: ReturnType<typeof createPublicClient>,
  params: {
    address: `0x${string}`;
    topics?: (Hex | Hex[] | null)[];
    fromBlock: bigint;
    toBlock: bigint;
  },
  batch: bigint
): Promise<Log[]> {
  try {
    const chunk = await client.request({
      method: "eth_getLogs",
      params: [
        {
          address: params.address,
          topics: params.topics,
          fromBlock: `0x${params.fromBlock.toString(16)}`,
          toBlock: `0x${params.toBlock.toString(16)}`
        }
      ]
    });
    return chunk.map((entry) => rpcLogToLog(entry as any));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const prunedHistory =
      message.toLowerCase().includes("history has been pruned") ||
      message.toLowerCase().includes("pruned for this block");
    if (prunedHistory) {
      return [] as Log[];
    }
    const range = params.toBlock - params.fromBlock + 1n;
    if (batch <= 1n || range <= 1n) {
      throw error;
    }
    const narrowedBatch = batch / 2n > 0n ? batch / 2n : 1n;
    return getLogsChunkedWithBatch(client, params, narrowedBatch);
  }
}

function eventTopic(signature: string): Hex {
  return keccak256(stringToHex(signature));
}

function launchModeFromId(mode: number): LaunchMode {
  return launchModeLabels[mode] ?? "Unregistered";
}

function expectedSuffixForMode(mode: number) {
  switch (mode) {
    case 2:
      return "b314";
    case 3:
      return "1314";
    case 4:
      return "2314";
    case 5:
      return "3314";
    case 6:
      return "4314";
    case 7:
      return "5314";
    case 8:
      return "6314";
    case 9:
      return "7314";
    case 10:
      return "8314";
    case 11:
      return "9314";
    case 12:
      return "f314";
    case 1:
    default:
      return "0314";
  }
}

function isTaxedMode(mode: bigint) {
  return mode >= 3n;
}

function rpcLogToLog(entry: {
  address: `0x${string}`;
  blockHash: `0x${string}` | null;
  blockNumber: `0x${string}` | null;
  data: `0x${string}`;
  logIndex: `0x${string}` | null;
  transactionHash: `0x${string}` | null;
  transactionIndex: `0x${string}` | null;
  removed: boolean;
  topics: Hex[];
}): Log {
  const normalizedTopics = (entry.topics.length === 0
    ? []
    : [entry.topics[0], ...entry.topics.slice(1)]) as [] | [Hex, ...Hex[]];

  return {
    address: entry.address,
    blockHash: entry.blockHash,
    blockNumber: entry.blockNumber ? hexToBigInt(entry.blockNumber) : null,
    data: entry.data,
    logIndex: entry.logIndex ? hexToNumber(entry.logIndex) : null,
    transactionHash: entry.transactionHash,
    transactionIndex: entry.transactionIndex ? hexToNumber(entry.transactionIndex) : null,
    removed: entry.removed,
    topics: normalizedTopics
  };
}

async function readLaunchSnapshot(client: ReturnType<typeof createPublicClient>, tokenAddress: `0x${string}`): Promise<Omit<LaunchWorkspaceSnapshot, "recentActivity" | "segmentedChart">> {
  const [
    name,
    symbol,
    totalSupply,
    state,
    pair,
    wrappedNative,
    creator,
    metadataURI,
    currentPriceQuotePerToken,
    graduationQuoteReserve,
    graduationProgressBps,
    remainingQuoteCapacity,
    protocolFeeAccrued,
    creatorFeeAccrued,
    protocolClaimable,
    creatorClaimable,
    dexReserves
  ] = (await client.multicall({
    allowFailure: false,
    contracts: [
      { address: tokenAddress, abi: launchTokenAbi, functionName: "name" },
      { address: tokenAddress, abi: launchTokenAbi, functionName: "symbol" },
      { address: tokenAddress, abi: launchTokenAbi, functionName: "totalSupply" },
      { address: tokenAddress, abi: launchTokenAbi, functionName: "state" },
      { address: tokenAddress, abi: launchTokenAbi, functionName: "pair" },
      { address: tokenAddress, abi: launchTokenAbi, functionName: "wrappedNative" },
      { address: tokenAddress, abi: launchTokenAbi, functionName: "creator" },
      { address: tokenAddress, abi: launchTokenAbi, functionName: "metadataURI" },
      { address: tokenAddress, abi: launchTokenAbi, functionName: "currentPriceQuotePerToken" },
      { address: tokenAddress, abi: launchTokenAbi, functionName: "graduationQuoteReserve" },
      { address: tokenAddress, abi: launchTokenAbi, functionName: "displayGraduationProgressBps" },
      { address: tokenAddress, abi: launchTokenAbi, functionName: "remainingQuoteCapacity" },
      { address: tokenAddress, abi: launchTokenAbi, functionName: "protocolFeeVault" },
      { address: tokenAddress, abi: launchTokenAbi, functionName: "creatorFeeVault" },
      { address: tokenAddress, abi: launchTokenAbi, functionName: "protocolClaimable" },
      { address: tokenAddress, abi: launchTokenAbi, functionName: "creatorClaimable" },
      { address: tokenAddress, abi: launchTokenAbi, functionName: "dexReserves" }
    ]
  })) as unknown as [
    string,
    string,
    bigint,
    bigint,
    `0x${string}`,
    `0x${string}`,
    `0x${string}`,
    string,
    bigint,
    bigint,
    bigint,
    bigint,
    bigint,
    bigint,
    bigint,
    bigint,
    readonly [bigint, bigint]
  ];

  const {
    pairPreloadedQuote,
    pairClean,
    pairGraduationCompatible
  } = await readPairStatus(client, tokenAddress, pair, wrappedNative);

  let launchMode = 1n;
  let launchSuffix = expectedSuffixForMode(Number(launchMode));
  let whitelistStatus = 0n;
  let whitelistSnapshot: readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint] = [
    0n,
    0n,
    0n,
    0n,
    0n,
    0n,
    0n,
    0n,
    0n
  ];
  let taxConfig: TaxConfigSnapshot = null;

  const optionalResults = (await client.multicall({
    allowFailure: true,
    contracts: [
      { address: tokenAddress, abi: launchTokenAbi, functionName: "launchMode" },
      { address: tokenAddress, abi: launchTokenAbi, functionName: "launchSuffix" },
      { address: tokenAddress, abi: launchTokenAbi, functionName: "whitelistStatus" },
      { address: tokenAddress, abi: launchTokenAbi, functionName: "whitelistSnapshot" },
      { address: tokenAddress, abi: launchTokenAbi, functionName: "taxConfig" }
    ]
  })) as unknown as Array<
    | { status: "success"; result: unknown }
    | { status: "failure"; error: unknown }
  >;

  const launchModeResult = optionalResults[0];
  const launchSuffixResult = optionalResults[1];
  const whitelistStatusResult = optionalResults[2];
  const whitelistSnapshotResult = optionalResults[3];
  const taxConfigResult = optionalResults[4];

  if (launchModeResult?.status === "success" && typeof launchModeResult.result === "bigint") {
    launchMode = launchModeResult.result;
  }
  if (launchSuffixResult?.status === "success" && typeof launchSuffixResult.result === "string") {
    launchSuffix = launchSuffixResult.result;
  }
  if (whitelistStatusResult?.status === "success" && typeof whitelistStatusResult.result === "bigint") {
    whitelistStatus = whitelistStatusResult.result;
  }
  if (whitelistSnapshotResult?.status === "success" && Array.isArray(whitelistSnapshotResult.result)) {
    whitelistSnapshot = whitelistSnapshotResult.result as unknown as readonly [
      bigint,
      bigint,
      bigint,
      bigint,
      bigint,
      bigint,
      bigint,
      bigint,
      bigint
    ];
  }
  if (taxConfigResult?.status === "success" && Array.isArray(taxConfigResult.result) && isTaxedMode(launchMode)) {
    const [enabled, taxBps, burnShareBps, treasuryShareBps, treasuryWallet, active] =
      taxConfigResult.result as unknown as readonly [boolean, bigint, bigint, bigint, `0x${string}`, boolean];
    taxConfig = {
      enabled,
      taxBps: taxBps.toString(),
      burnShareBps: burnShareBps.toString(),
      treasuryShareBps: treasuryShareBps.toString(),
      treasuryWallet: treasuryWallet === zeroAddress ? null : treasuryWallet,
      active
    };
  }

  if (!launchSuffix) {
    launchSuffix = expectedSuffixForMode(Number(launchMode));
  }

  const parsedWhitelistSnapshot: WhitelistSnapshot =
    whitelistStatus === 0n && whitelistSnapshot[1] === 0n
      ? null
      : {
          status: whitelistSnapshot[0].toString(),
          opensAt: whitelistSnapshot[1].toString(),
          deadline: whitelistSnapshot[2].toString(),
          threshold: whitelistSnapshot[3].toString(),
          slotSize: whitelistSnapshot[4].toString(),
          seatCount: whitelistSnapshot[5].toString(),
          seatsFilled: whitelistSnapshot[6].toString(),
          committedTotal: whitelistSnapshot[7].toString(),
          tokensPerSeat: whitelistSnapshot[8].toString()
        };

  return {
    token: tokenAddress,
    creator,
    name,
    symbol,
    totalSupply: totalSupply.toString(),
    mode: Number(launchMode),
    modeLabel: launchModeFromId(Number(launchMode)),
    suffix: launchSuffix,
    metadataURI,
    state: (launchStates[Number(state)] ?? "Created") as LaunchState,
    pair,
    graduationQuoteReserve: graduationQuoteReserve.toString(),
    currentPriceQuotePerToken: currentPriceQuotePerToken.toString(),
    graduationProgressBps: Number(graduationProgressBps),
    remainingQuoteCapacity: remainingQuoteCapacity.toString(),
    pairPreloadedQuote: pairPreloadedQuote.toString(),
    pairClean,
    pairGraduationCompatible,
    protocolFeeAccrued: protocolFeeAccrued.toString(),
    creatorFeeAccrued: creatorFeeAccrued.toString(),
    protocolClaimable: protocolClaimable.toString(),
    creatorClaimable: creatorClaimable.toString(),
    whitelistStatus: whitelistStatus.toString(),
    whitelistSnapshot: parsedWhitelistSnapshot,
    taxConfig,
    dexTokenReserve: dexReserves[0].toString(),
    dexQuoteReserve: dexReserves[1].toString()
  };
}

async function buildBlockTimes(client: ReturnType<typeof createPublicClient>, logs: Log[]) {
  const uniqueBlocks = [...new Set(logs.map((log) => (log.blockNumber ?? 0n).toString()))];
  const entries = await Promise.all(
    uniqueBlocks.map(async (blockKey) => {
      const block = await client.getBlock({ blockNumber: BigInt(blockKey) });
      return [blockKey, Number(block.timestamp) * 1000] as const;
    })
  );
  return new Map<string, number>(entries);
}

function compareLogsAsc(a: Pick<Log, "blockNumber" | "logIndex">, b: Pick<Log, "blockNumber" | "logIndex">) {
  const blockA = a.blockNumber ?? 0n;
  const blockB = b.blockNumber ?? 0n;
  if (blockA < blockB) return -1;
  if (blockA > blockB) return 1;
  return Number((a.logIndex ?? 0) - (b.logIndex ?? 0));
}

function compareLogsDesc(a: Pick<Log, "blockNumber" | "logIndex">, b: Pick<Log, "blockNumber" | "logIndex">) {
  const blockA = a.blockNumber ?? 0n;
  const blockB = b.blockNumber ?? 0n;
  if (blockA > blockB) return -1;
  if (blockA < blockB) return 1;
  return Number((b.logIndex ?? 0) - (a.logIndex ?? 0));
}

function compareActivityDesc(a: { blockNumber: bigint; logIndex: number }, b: { blockNumber: bigint; logIndex: number }) {
  if (a.blockNumber > b.blockNumber) return -1;
  if (a.blockNumber < b.blockNumber) return 1;
  return b.logIndex - a.logIndex;
}
