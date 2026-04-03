import { createPublicClient, getAddress, hexToBigInt, hexToNumber, http, keccak256, stringToHex, type Hex, type Log } from "viem";
import { launchTokenAbi, v2PairAbi } from "./abi";
import { indexerConfig } from "./config";
import { resolveIndexerProfile } from "./profiles";
import { normalizeGraduatedActivity, normalizePairTrade, normalizeProtocolTrade } from "./normalizers";
import type {
  CandleBucket,
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
const buyExecutedTopic = eventTopic(
  "BuyExecuted(address,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256)"
);
const sellExecutedTopic = eventTopic(
  "SellExecuted(address,uint256,uint256,uint256,uint256,uint256,uint256,uint256)"
);
const graduatedTopic = eventTopic("Graduated(address,uint256,uint256,uint256,uint256)");
const swapTopic = eventTopic("Swap(address,uint256,uint256,uint256,uint256,address)");

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
  const fromBlock =
    indexerConfig.fromBlock ??
    (latestBlock > indexerConfig.lookbackBlocks ? latestBlock - indexerConfig.lookbackBlocks : 0n);

  const factoryAddress = getAddress(indexerConfig.factoryAddress);
  const totalLaunches = (await client.readContract({
    address: factoryAddress,
    abi: legacyFactoryAbi,
    functionName: "totalLaunches"
  })) as bigint;
  const launchCount = Number(totalLaunches > BigInt(indexerConfig.launchLimit) ? BigInt(indexerConfig.launchLimit) : totalLaunches);
  const launches: `0x${string}`[] = [];

  for (let offset = 0; offset < launchCount; offset += 1) {
    const index = totalLaunches - 1n - BigInt(offset);
    const token = (await client.readContract({
      address: factoryAddress,
      abi: legacyFactoryAbi,
      functionName: "allLaunches",
      args: [index]
    })) as `0x${string}`;
    launches.push(token);
  }

  const workspaceSnapshots: LaunchWorkspaceSnapshot[] = [];

  for (const token of launches) {
    const tokenSnapshot = await readLaunchSnapshot(client, token);
    let tokenLogs: Log[] = [];
    try {
      tokenLogs = await getLogsChunked(client, {
        address: token,
        topics: [[buyExecutedTopic, sellExecutedTopic, graduatedTopic]],
        fromBlock,
        toBlock: latestBlock
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
      const [token0, token1] = (await Promise.all([
        client.readContract({ address: graduationPair, abi: v2PairAbi, functionName: "token0" }),
        client.readContract({ address: graduationPair, abi: v2PairAbi, functionName: "token1" })
      ])) as [`0x${string}`, `0x${string}`];

      let pairLogs: Log[] = [];
      try {
        pairLogs = await getLogsChunked(client, {
          address: graduationPair,
          topics: [[swapTopic]],
          fromBlock: graduationBlock && graduationBlock > fromBlock ? graduationBlock : fromBlock,
          toBlock: latestBlock
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
        bondingCandles: buildFiveMinuteCandles(protocolTrades),
        dexCandles: buildFiveMinuteCandles(dexTrades),
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
    toBlock: latestBlock.toString(),
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
  const batch = indexerConfig.logBatchBlocks > 0n ? indexerConfig.logBatchBlocks : 10n;
  const logs: Log[] = [];

  let cursor = params.fromBlock;
  while (cursor <= params.toBlock) {
    const end = cursor + batch - 1n > params.toBlock ? params.toBlock : cursor + batch - 1n;
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
  }

  return logs;
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
    state,
    pair,
    creator,
    metadataURI,
    currentPriceQuotePerToken,
    graduationQuoteReserve,
    graduationProgressBps,
    remainingQuoteCapacity,
    pairPreloadedQuote,
    pairClean,
    pairGraduationCompatible,
    protocolClaimable,
    creatorClaimable,
    dexReserves
  ] = (await Promise.all([
    client.readContract({ address: tokenAddress, abi: launchTokenAbi, functionName: "name" }),
    client.readContract({ address: tokenAddress, abi: launchTokenAbi, functionName: "symbol" }),
    client.readContract({ address: tokenAddress, abi: launchTokenAbi, functionName: "state" }),
    client.readContract({ address: tokenAddress, abi: launchTokenAbi, functionName: "pair" }),
    client.readContract({ address: tokenAddress, abi: launchTokenAbi, functionName: "creator" }),
    client.readContract({ address: tokenAddress, abi: launchTokenAbi, functionName: "metadataURI" }),
    client.readContract({ address: tokenAddress, abi: launchTokenAbi, functionName: "currentPriceQuotePerToken" }),
    client.readContract({ address: tokenAddress, abi: launchTokenAbi, functionName: "graduationQuoteReserve" }),
    client.readContract({ address: tokenAddress, abi: launchTokenAbi, functionName: "displayGraduationProgressBps" }),
    client.readContract({ address: tokenAddress, abi: launchTokenAbi, functionName: "remainingQuoteCapacity" }),
    client.readContract({ address: tokenAddress, abi: launchTokenAbi, functionName: "pairPreloadedQuote" }),
    client.readContract({ address: tokenAddress, abi: launchTokenAbi, functionName: "isPairClean" }),
    client.readContract({ address: tokenAddress, abi: launchTokenAbi, functionName: "isPairGraduationCompatible" }),
    client.readContract({ address: tokenAddress, abi: launchTokenAbi, functionName: "protocolClaimable" }),
    client.readContract({ address: tokenAddress, abi: launchTokenAbi, functionName: "creatorClaimable" }),
    client.readContract({ address: tokenAddress, abi: launchTokenAbi, functionName: "dexReserves" })
  ])) as [
    string,
    string,
    bigint,
    `0x${string}`,
    `0x${string}`,
    string,
    bigint,
    bigint,
    bigint,
    bigint,
    bigint,
    boolean,
    boolean,
    bigint,
    bigint,
    readonly [bigint, bigint]
  ];

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

  try {
    launchMode = (await client.readContract({ address: tokenAddress, abi: launchTokenAbi, functionName: "launchMode" })) as bigint;
  } catch {}
  try {
    launchSuffix = (await client.readContract({ address: tokenAddress, abi: launchTokenAbi, functionName: "launchSuffix" })) as string;
  } catch {}
  try {
    whitelistStatus = (await client.readContract({
      address: tokenAddress,
      abi: launchTokenAbi,
      functionName: "whitelistStatus"
    })) as bigint;
    whitelistSnapshot = (await client.readContract({
      address: tokenAddress,
      abi: launchTokenAbi,
      functionName: "whitelistSnapshot"
    })) as readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint];
  } catch {}
  if (isTaxedMode(launchMode)) {
    try {
      const [enabled, taxBps, burnShareBps, treasuryShareBps, treasuryWallet, active] = (await client.readContract({
        address: tokenAddress,
        abi: launchTokenAbi,
        functionName: "taxConfig"
      })) as readonly [boolean, bigint, bigint, bigint, `0x${string}`, boolean];
      taxConfig = {
        enabled,
        taxBps: taxBps.toString(),
        burnShareBps: burnShareBps.toString(),
        treasuryShareBps: treasuryShareBps.toString(),
        treasuryWallet: treasuryWallet === zeroAddress ? null : treasuryWallet,
        active
      };
    } catch {}
  }

  if (!launchSuffix) {
    launchSuffix = expectedSuffixForMode(Number(launchMode));
  }

  const parsedWhitelistSnapshot: WhitelistSnapshot =
    whitelistStatus === 0n && whitelistSnapshot[1] === 0n
      ? null
      : {
          status: whitelistSnapshot[0].toString(),
          deadline: whitelistSnapshot[1].toString(),
          threshold: whitelistSnapshot[2].toString(),
          slotSize: whitelistSnapshot[3].toString(),
          seatCount: whitelistSnapshot[4].toString(),
          seatsFilled: whitelistSnapshot[5].toString(),
          committedTotal: whitelistSnapshot[6].toString(),
          tokensPerSeat: whitelistSnapshot[7].toString(),
          whitelistCount: whitelistSnapshot[8].toString()
        };

  return {
    token: tokenAddress,
    creator,
    name,
    symbol,
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

function buildFiveMinuteCandles(trades: TradeRecord[]): CandleBucket[] {
  const timeframe = "5m" as const;
  const buckets = new Map<number, CandleBucket>();

  for (const trade of [...trades].sort((a, b) => a.timestampMs - b.timestampMs)) {
    const start = Math.floor(trade.timestampMs / 300000) * 300000;
    const price = tradePrice(BigInt(trade.netQuote), BigInt(trade.tokenAmount)).toString();
    const existing = buckets.get(start);

    if (!existing) {
      buckets.set(start, {
        token: trade.token,
        timeframe,
        bucketStart: start,
        open: price,
        high: price,
        low: price,
        close: price,
        volumeQuote: trade.netQuote,
        volumeToken: trade.tokenAmount,
        trades: 1
      });
      continue;
    }

    buckets.set(start, {
      ...existing,
      high: BigInt(existing.high) > BigInt(price) ? existing.high : price,
      low: BigInt(existing.low) < BigInt(price) ? existing.low : price,
      close: price,
      volumeQuote: (BigInt(existing.volumeQuote) + BigInt(trade.netQuote)).toString(),
      volumeToken: (BigInt(existing.volumeToken) + BigInt(trade.tokenAmount)).toString(),
      trades: existing.trades + 1
    });
  }

  return [...buckets.values()].sort((a, b) => a.bucketStart - b.bucketStart);
}

function tradePrice(quote: bigint, token: bigint) {
  if (token === 0n) return 0n;
  return (quote * 10n ** 18n) / token;
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
