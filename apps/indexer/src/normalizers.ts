import { getAddress, type Log } from "viem";
import { decodeLaunchEvent, decodePairEvent } from "./events";
import type { ActivityRecord, TradeRecord } from "./schema";

export function normalizeProtocolTrade(log: Log, timestampMs: number): TradeRecord | null {
  const decoded = decodeLaunchEvent(log);

  if (decoded.type === "BuyExecuted") {
    return {
      kind: "trade",
      token: getAddress(log.address!),
      marketAddress: getAddress(log.address!),
      txHash: log.transactionHash!,
      blockNumber: log.blockNumber!,
      logIndex: Number(log.logIndex),
      timestampMs,
      source: "protocol",
      phase: "bonding",
      side: "buy",
      grossQuote: decoded.args.grossQuoteIn.toString(),
      netQuote: decoded.args.netQuoteIn.toString(),
      protocolFee: decoded.args.protocolFee.toString(),
      creatorFee: decoded.args.creatorFee.toString(),
      tokenAmount: decoded.args.tokenOut.toString()
    };
  }

  if (decoded.type === "SellExecuted") {
    return {
      kind: "trade",
      token: getAddress(log.address!),
      marketAddress: getAddress(log.address!),
      txHash: log.transactionHash!,
      blockNumber: log.blockNumber!,
      logIndex: Number(log.logIndex),
      timestampMs,
      source: "protocol",
      phase: "bonding",
      side: "sell",
      grossQuote: decoded.args.grossQuoteOut.toString(),
      netQuote: decoded.args.netQuoteOut.toString(),
      protocolFee: decoded.args.protocolFee.toString(),
      creatorFee: decoded.args.creatorFee.toString(),
      tokenAmount: decoded.args.tokenIn.toString()
    };
  }

  return null;
}

export function normalizeGraduatedActivity(log: Log, timestampMs: number): ActivityRecord | null {
  const decoded = decodeLaunchEvent(log);
  if (decoded.type !== "Graduated") return null;

  return {
    kind: "graduated",
    token: getAddress(log.address!),
    marketAddress: getAddress(decoded.args.pair),
    txHash: log.transactionHash!,
    blockNumber: log.blockNumber!,
    logIndex: Number(log.logIndex),
    timestampMs,
    source: "system",
    phase: "migrating",
    quoteAmountContributed: decoded.args.quoteAmountContributed.toString(),
    preloadedQuoteAmount: decoded.args.preloadedQuoteAmount.toString(),
    tokenAmount: decoded.args.tokenAmount.toString(),
    liquidityBurned: decoded.args.liquidityBurned.toString()
  };
}

export function normalizePairTrade(
  log: Log,
  timestampMs: number,
  launchToken: `0x${string}`,
  pairAddress: `0x${string}`,
  token0: `0x${string}`,
  token1: `0x${string}`
): TradeRecord | null {
  const decoded = decodePairEvent(log);
  if (decoded.type !== "Swap") return null;

  const launch = getAddress(launchToken);
  const isToken0Launch = getAddress(token0) === launch;
  const launchIn = isToken0Launch ? decoded.args.amount0In : decoded.args.amount1In;
  const launchOut = isToken0Launch ? decoded.args.amount0Out : decoded.args.amount1Out;
  const quoteIn = isToken0Launch ? decoded.args.amount1In : decoded.args.amount0In;
  const quoteOut = isToken0Launch ? decoded.args.amount1Out : decoded.args.amount0Out;

  if (launchOut > 0n && quoteIn > 0n) {
    return {
      kind: "trade",
      token: launch,
      marketAddress: getAddress(pairAddress),
      txHash: log.transactionHash!,
      blockNumber: log.blockNumber!,
      logIndex: Number(log.logIndex),
      timestampMs,
      source: "dex",
      phase: "dexOnly",
      side: "buy",
      grossQuote: quoteIn.toString(),
      netQuote: quoteIn.toString(),
      protocolFee: "0",
      creatorFee: "0",
      tokenAmount: launchOut.toString()
    };
  }

  if (launchIn > 0n && quoteOut > 0n) {
    return {
      kind: "trade",
      token: launch,
      marketAddress: getAddress(pairAddress),
      txHash: log.transactionHash!,
      blockNumber: log.blockNumber!,
      logIndex: Number(log.logIndex),
      timestampMs,
      source: "dex",
      phase: "dexOnly",
      side: "sell",
      grossQuote: quoteOut.toString(),
      netQuote: quoteOut.toString(),
      protocolFee: "0",
      creatorFee: "0",
      tokenAmount: launchIn.toString()
    };
  }

  return null;
}
