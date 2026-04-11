import type { CandleBucket, TradeRecord } from "./schema";

export const timeframeMs = {
  "1m": 60_000,
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
  "1h": 60 * 60_000,
  "4h": 4 * 60 * 60_000,
  "1d": 24 * 60 * 60_000
} as const;

export const supportedTimeframes = Object.keys(timeframeMs) as Array<keyof typeof timeframeMs>;

function bucketStart(timestampMs: number, timeframe: keyof typeof timeframeMs) {
  const interval = timeframeMs[timeframe];
  return Math.floor(timestampMs / interval) * interval;
}

function tradePrice(trade: TradeRecord) {
  const quote = BigInt(trade.netQuote);
  const token = BigInt(trade.tokenAmount);
  if (token === 0n) return 0n;
  return (quote * 10n ** 18n) / token;
}

export function foldTradeIntoCandles(
  existing: CandleBucket[],
  trade: TradeRecord,
  timestampMs: number
): CandleBucket[] {
  const price = tradePrice(trade).toString();
  const quote = trade.netQuote;
  const token = trade.tokenAmount;

  const next = [...existing];

  for (const timeframe of supportedTimeframes) {
    const start = bucketStart(timestampMs, timeframe);
    const index = next.findIndex(
      (bucket) => bucket.token === trade.token && bucket.timeframe === timeframe && bucket.bucketStart === start
    );

    if (index === -1) {
      next.push({
        token: trade.token,
        timeframe,
        bucketStart: start,
        open: price,
        high: price,
        low: price,
        close: price,
        volumeQuote: quote,
        volumeToken: token,
        trades: 1
      });
      continue;
    }

    const current = next[index];
    const high = BigInt(current.high) > BigInt(price) ? current.high : price;
    const low = BigInt(current.low) < BigInt(price) ? current.low : price;

    next[index] = {
      ...current,
      high,
      low,
      close: price,
      volumeQuote: (BigInt(current.volumeQuote) + BigInt(quote)).toString(),
      volumeToken: (BigInt(current.volumeToken) + BigInt(token)).toString(),
      trades: current.trades + 1
    };
  }

  return next;
}

export function buildCandlesFromTrades(trades: TradeRecord[]): CandleBucket[] {
  const sortedTrades = [...trades].sort((a, b) => a.timestampMs - b.timestampMs);
  const buckets = new Map<string, CandleBucket>();

  for (const trade of sortedTrades) {
    const price = tradePrice(trade).toString();
    const quote = trade.netQuote;
    const token = trade.tokenAmount;

    for (const timeframe of supportedTimeframes) {
      const start = bucketStart(trade.timestampMs, timeframe);
      const key = `${timeframe}:${start}`;
      const existing = buckets.get(key);

      if (!existing) {
        buckets.set(key, {
          token: trade.token,
          timeframe,
          bucketStart: start,
          open: price,
          high: price,
          low: price,
          close: price,
          volumeQuote: quote,
          volumeToken: token,
          trades: 1
        });
        continue;
      }

      buckets.set(key, {
        ...existing,
        high: BigInt(existing.high) > BigInt(price) ? existing.high : price,
        low: BigInt(existing.low) < BigInt(price) ? existing.low : price,
        close: price,
        volumeQuote: (BigInt(existing.volumeQuote) + BigInt(quote)).toString(),
        volumeToken: (BigInt(existing.volumeToken) + BigInt(token)).toString(),
        trades: existing.trades + 1
      });
    }
  }

  return [...buckets.values()].sort((a, b) => {
    const timeframeDiff = timeframeMs[a.timeframe] - timeframeMs[b.timeframe];
    if (timeframeDiff !== 0) return timeframeDiff;
    return a.bucketStart - b.bucketStart;
  });
}
