import { decodeEventLog, type Hex, type Log } from "viem";
import { launchFactoryAbi, launchTokenAbi, v2PairAbi } from "./abi";

type DecodedFactoryEvent =
  | {
      type: "LaunchCreated";
      args: {
        creator: `0x${string}`;
        token: `0x${string}`;
        name: string;
        symbol: string;
        metadataURI: string;
      };
    }
  | { type: "UnknownFactoryEvent"; topic: Hex };

type DecodedLaunchEvent =
  | {
      type: "BuyExecuted";
      args: {
        buyer: `0x${string}`;
        grossQuoteIn: bigint;
        netQuoteIn: bigint;
        protocolFee: bigint;
        creatorFee: bigint;
        refundAmount: bigint;
        tokenOut: bigint;
        newCurveQuoteReserve: bigint;
        newSaleTokenReserve: bigint;
      };
    }
  | {
      type: "SellExecuted";
      args: {
        seller: `0x${string}`;
        tokenIn: bigint;
        grossQuoteOut: bigint;
        netQuoteOut: bigint;
        protocolFee: bigint;
        creatorFee: bigint;
        newCurveQuoteReserve: bigint;
        newSaleTokenReserve: bigint;
      };
    }
  | {
      type: "Graduated";
      args: {
        pair: `0x${string}`;
        tokenAmount: bigint;
        quoteAmountContributed: bigint;
        preloadedQuoteAmount: bigint;
        liquidityBurned: bigint;
      };
    }
  | { type: "UnknownLaunchEvent"; topic: Hex };

type DecodedPairEvent =
  | {
      type: "Swap";
      args: {
        amount0In: bigint;
        amount1In: bigint;
        amount0Out: bigint;
        amount1Out: bigint;
      };
    }
  | { type: "UnknownPairEvent"; topic: Hex };

export function decodeFactoryEvent(log: Log): DecodedFactoryEvent {
  try {
    const decoded = decodeEventLog({
      abi: launchFactoryAbi,
      data: log.data,
      topics: log.topics
    }) as any;

    if (decoded.eventName === "LaunchCreated") {
      return {
        type: "LaunchCreated",
        args: {
          creator: decoded.args.creator,
          token: decoded.args.token,
          name: decoded.args.name,
          symbol: decoded.args.symbol,
          metadataURI: decoded.args.metadataURI
        }
      };
    }
  } catch {
    // ignore
  }

  return {
    type: "UnknownFactoryEvent",
    topic: log.topics[0] ?? "0x"
  };
}

export function decodeLaunchEvent(log: Log): DecodedLaunchEvent {
  try {
    const decoded = decodeEventLog({
      abi: launchTokenAbi,
      data: log.data,
      topics: log.topics
    }) as any;

    if (decoded.eventName === "BuyExecuted") {
      return {
        type: "BuyExecuted",
        args: {
          buyer: decoded.args.buyer,
          grossQuoteIn: decoded.args.grossQuoteIn,
          netQuoteIn: decoded.args.netQuoteIn,
          protocolFee: decoded.args.protocolFee,
          creatorFee: decoded.args.creatorFee,
          refundAmount: decoded.args.refundAmount,
          tokenOut: decoded.args.tokenOut,
          newCurveQuoteReserve: decoded.args.newCurveQuoteReserve,
          newSaleTokenReserve: decoded.args.newSaleTokenReserve
        }
      };
    }

    if (decoded.eventName === "SellExecuted") {
      return {
        type: "SellExecuted",
        args: {
          seller: decoded.args.seller,
          tokenIn: decoded.args.tokenIn,
          grossQuoteOut: decoded.args.grossQuoteOut,
          netQuoteOut: decoded.args.netQuoteOut,
          protocolFee: decoded.args.protocolFee,
          creatorFee: decoded.args.creatorFee,
          newCurveQuoteReserve: decoded.args.newCurveQuoteReserve,
          newSaleTokenReserve: decoded.args.newSaleTokenReserve
        }
      };
    }

    if (decoded.eventName === "Graduated") {
      return {
        type: "Graduated",
        args: {
          pair: decoded.args.pair,
          tokenAmount: decoded.args.tokenAmount,
          quoteAmountContributed: decoded.args.quoteAmountContributed,
          preloadedQuoteAmount: decoded.args.preloadedQuoteAmount,
          liquidityBurned: decoded.args.liquidityBurned
        }
      };
    }
  } catch {
    // ignore
  }

  return {
    type: "UnknownLaunchEvent",
    topic: log.topics[0] ?? "0x"
  };
}

export function decodePairEvent(log: Log): DecodedPairEvent {
  try {
    const decoded = decodeEventLog({
      abi: v2PairAbi,
      data: log.data,
      topics: log.topics
    }) as any;

    if (decoded.eventName === "Swap") {
      return {
        type: "Swap",
        args: {
          amount0In: decoded.args.amount0In,
          amount1In: decoded.args.amount1In,
          amount0Out: decoded.args.amount0Out,
          amount1Out: decoded.args.amount1Out
        }
      };
    }
  } catch {
    // ignore
  }

  return {
    type: "UnknownPairEvent",
    topic: log.topics[0] ?? "0x"
  };
}
