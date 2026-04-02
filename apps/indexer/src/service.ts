import { createPublicClient, getAddress, http, keccak256, stringToHex, type Hex, type Log } from "viem";
import { launchTokenAbi, v2PairAbi } from "./abi";
import { indexerConfig } from "./config";
import { resolveIndexerProfile } from "./profiles";
import { decodeFactoryEvent } from "./events";
import { normalizeGraduatedActivity, normalizePairTrade, normalizeProtocolTrade } from "./normalizers";
import type { CandleBucket, IndexerSnapshot, LaunchState, LaunchWorkspaceSnapshot, TradeRecord } from "./schema";

const launchStates = ["Created", "Bonding314", "Migrating", "DEXOnly"] as const;
const zeroAddress = "0x0000000000000000000000000000000000000000";
const launchCreatedTopic = eventTopic("LaunchCreated(address,address,string,string,string)");
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

  const factoryLogs = await getLogsChunked(client, {
    address: getAddress(indexerConfig.factoryAddress),
    topics: [[launchCreatedTopic]],
    fromBlock,
    toBlock: latestBlock
  });

  const launches: Array<{
    log: Log;
    decoded: {
      type: "LaunchCreated";
      args: {
        creator: `0x${string}`;
        token: `0x${string}`;
        name: string;
        symbol: string;
        metadataURI: string;
      };
    };
  }> = [];

  for (const log of factoryLogs) {
    const decoded = decodeFactoryEvent(log);
    if (decoded.type !== "LaunchCreated") continue;
    launches.push({ log, decoded });
  }

  launches.sort((a, b) => compareLogsDesc(a.log, b.log));
  launches.splice(indexerConfig.launchLimit);

  const workspaceSnapshots: LaunchWorkspaceSnapshot[] = [];

  for (const launch of launches) {
    const token = launch.decoded.args.token;
    const tokenSnapshot = await readLaunchSnapshot(client, token);

    const tokenLogs = await getLogsChunked(client, {
      address: token,
      topics: [[buyExecutedTopic, sellExecutedTopic, graduatedTopic]],
      fromBlock,
      toBlock: latestBlock
    });
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

      const pairLogs = await getLogsChunked(client, {
        address: graduationPair,
        topics: [[swapTopic]],
        fromBlock: graduationBlock && graduationBlock > fromBlock ? graduationBlock : fromBlock,
        toBlock: latestBlock
      });
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
    const chunk = await client.getLogs({
      address: params.address,
      topics: params.topics,
      fromBlock: cursor,
      toBlock: end
    } as any);
    logs.push(...chunk);
    cursor = end + 1n;
  }

  return logs;
}

function eventTopic(signature: string): Hex {
  return keccak256(stringToHex(signature));
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

  return {
    token: tokenAddress,
    creator,
    name,
    symbol,
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
