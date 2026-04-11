import test from "node:test";
import assert from "node:assert/strict";
import { buildCandlesFromTrades } from "./candles";
import type { TradeRecord } from "./schema";

const baseTrade: Omit<TradeRecord, "timestampMs" | "blockNumber" | "logIndex" | "txHash"> = {
  kind: "trade",
  token: "0x0000000000000000000000000000000000000001",
  marketAddress: "0x0000000000000000000000000000000000000002",
  actor: "0x0000000000000000000000000000000000000003",
  source: "protocol",
  phase: "bonding",
  side: "buy",
  grossQuote: "100",
  netQuote: "100",
  protocolFee: "0",
  creatorFee: "0",
  tokenAmount: "50"
};

test("buildCandlesFromTrades pre-aggregates all supported chart timeframes", () => {
  const trades: TradeRecord[] = [
    {
      ...baseTrade,
      txHash: "0x0000000000000000000000000000000000000000000000000000000000000001",
      blockNumber: 1n,
      logIndex: 0,
      timestampMs: 61_000
    },
    {
      ...baseTrade,
      txHash: "0x0000000000000000000000000000000000000000000000000000000000000002",
      blockNumber: 2n,
      logIndex: 0,
      timestampMs: 121_000,
      netQuote: "200",
      grossQuote: "200",
      tokenAmount: "50"
    }
  ];

  const candles = buildCandlesFromTrades(trades);
  const oneMinute = candles.filter((candle) => candle.timeframe === "1m");
  const fiveMinute = candles.filter((candle) => candle.timeframe === "5m");
  const oneHour = candles.filter((candle) => candle.timeframe === "1h");

  assert.equal(oneMinute.length, 2);
  assert.equal(fiveMinute.length, 1);
  assert.equal(oneHour.length, 1);
  assert.equal(fiveMinute[0]?.bucketStart, 0);
  assert.equal(fiveMinute[0]?.trades, 2);
  assert.equal(fiveMinute[0]?.open, "2000000000000000000");
  assert.equal(fiveMinute[0]?.close, "4000000000000000000");
  assert.equal(fiveMinute[0]?.volumeQuote, "300");
  assert.equal(fiveMinute[0]?.volumeToken, "100");
});
