import { useMemo, useState } from "react";
import type { CandlePoint } from "./types";
import { useActiveProtocolProfile } from "./profiles";

type BondingCandlestickChartProps = {
  candles: CandlePoint[];
  timeframeLabel: string;
  graduationTimestampMs: number | null;
  expanded?: boolean;
};

const PRICE_SCALE = 10 ** 18;

function priceToNumber(value: bigint) {
  return Number(value) / PRICE_SCALE;
}

function compactValue(value: number, digits = 4) {
  if (!Number.isFinite(value)) return "—";
  if (value === 0) return "0";
  if (Math.abs(value) >= 1) {
    return value.toLocaleString(undefined, {
      maximumFractionDigits: digits,
      minimumFractionDigits: Math.abs(value) < 10 ? 2 : 0
    });
  }
  if (Math.abs(value) >= 0.0001) {
    return value.toLocaleString(undefined, {
      maximumSignificantDigits: 4
    });
  }
  return value.toExponential(2);
}

function compactQuote(value: bigint) {
  return compactValue(priceToNumber(value), 6);
}

function buildTimeLabel(timestampMs: number, timeframeLabel: string) {
  if (timeframeLabel === "1d") {
    return new Date(timestampMs).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric"
    });
  }
  if (timeframeLabel === "4h" || timeframeLabel === "1h") {
    return new Date(timestampMs).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit"
    });
  }
  return new Date(timestampMs).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function buildAxisTimeLabel(timestampMs: number, timeframeLabel: string) {
  if (timeframeLabel === "1d") {
    return new Date(timestampMs).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric"
    });
  }
  if (timeframeLabel === "4h" || timeframeLabel === "1h") {
    return new Date(timestampMs).toLocaleString(undefined, {
      month: "numeric",
      day: "numeric",
      hour: "2-digit"
    });
  }
  return new Date(timestampMs).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit"
  });
}

export function BondingCandlestickChart({
  candles,
  timeframeLabel,
  graduationTimestampMs,
  expanded = false
}: BondingCandlestickChartProps) {
  const activeProtocolProfile = useActiveProtocolProfile();
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);

  const sortedCandles = useMemo(
    () => [...candles].sort((a, b) => a.bucketStart - b.bucketStart),
    [candles]
  );

  if (sortedCandles.length === 0) {
    return <div className="empty-state">No internal market candles yet.</div>;
  }

  const width = Math.max(expanded ? 1180 : 920, sortedCandles.length * (expanded ? 28 : 18) + 120);
  const height = expanded ? 520 : 380;
  const left = 18;
  const right = 72;
  const top = 18;
  const volumeHeight = expanded ? 110 : 78;
  const bottom = 42;
  const plotHeight = height - top - volumeHeight - bottom;
  const volumeTop = top + plotHeight + 14;
  const innerWidth = width - left - right;
  const slotWidth = innerWidth / Math.max(sortedCandles.length, 1);
  const candleBodyWidth = Math.max(Math.min(slotWidth * 0.62, 14), 3);
  const allHighs = sortedCandles.map((candle) => priceToNumber(candle.high));
  const allLows = sortedCandles.map((candle) => priceToNumber(candle.low));
  const rawMin = Math.min(...allLows);
  const rawMax = Math.max(...allHighs);
  const pricePadding = Math.max((rawMax - rawMin) * 0.08, rawMax * 0.01 || 0.00000001);
  const minPrice = Math.max(0, rawMin - pricePadding);
  const maxPrice = rawMax + pricePadding;
  const priceSpan = Math.max(maxPrice - minPrice, 0.00000001);
  const maxVolume = Math.max(...sortedCandles.map((candle) => priceToNumber(candle.volumeQuote)), 0.00000001);
  const activeIndex = hoveredIndex ?? sortedCandles.length - 1;
  const activeCandle = sortedCandles[activeIndex];
  const latestCandle = sortedCandles[sortedCandles.length - 1];
  const firstCandle = sortedCandles[0];
  const changeValue = priceToNumber(latestCandle.close) - priceToNumber(firstCandle.open);
  const changePercent =
    firstCandle.open > 0n
      ? (changeValue / priceToNumber(firstCandle.open)) * 100
      : 0;

  const priceY = (value: number) => top + ((maxPrice - value) / priceSpan) * plotHeight;
  const volumeY = (value: number) => volumeTop + volumeHeight - (value / maxVolume) * volumeHeight;

  const priceTicks = Array.from({ length: 5 }, (_, index) => {
    const ratio = index / 4;
    const value = maxPrice - ratio * priceSpan;
    return {
      value,
      y: priceY(value)
    };
  });

  const timeTickIndexes = Array.from(
    new Set(
      [0, Math.floor(sortedCandles.length * 0.33), Math.floor(sortedCandles.length * 0.66), sortedCandles.length - 1]
        .filter((index) => index >= 0 && index < sortedCandles.length)
    )
  );

  return (
    <div className={`chart-shell meme-chart ${expanded ? "expanded" : ""}`}>
      <div className="meme-chart-summary">
        <div>
          <span className="metric-label">Timeframe</span>
          <strong>{timeframeLabel}</strong>
        </div>
        <div>
          <span className="metric-label">Last</span>
          <strong>{compactQuote(latestCandle.close)} {activeProtocolProfile.nativeSymbol}</strong>
        </div>
        <div>
          <span className="metric-label">Change</span>
          <strong className={changeValue >= 0 ? "chart-positive" : "chart-negative"}>
            {changeValue >= 0 ? "+" : ""}
            {compactValue(changePercent, 2)}%
          </strong>
        </div>
        <div>
          <span className="metric-label">Trades</span>
          <strong>{activeCandle.trades}</strong>
        </div>
        <div>
          <span className="metric-label">Volume</span>
          <strong>{compactQuote(activeCandle.volumeQuote)} {activeProtocolProfile.nativeSymbol}</strong>
        </div>
      </div>

      <div className="meme-chart-meta">
        <span>
          O {compactQuote(activeCandle.open)} · H {compactQuote(activeCandle.high)} · L {compactQuote(activeCandle.low)} · C {compactQuote(activeCandle.close)}
        </span>
        <span>{buildTimeLabel(activeCandle.bucketStart, timeframeLabel)}</span>
      </div>

      <div className="chart-scroll-shell">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="chart-svg"
          role="img"
          aria-label="Internal market candlestick chart"
          style={{ minWidth: `${width}px` }}
        >
          <defs>
            <linearGradient id="chart-bg-fade" x1="0%" y1="0%" x2="0%" y2="100%">
              <stop offset="0%" stopColor="rgba(94,234,212,0.04)" />
              <stop offset="100%" stopColor="rgba(8,16,24,0)" />
            </linearGradient>
          </defs>

          <rect x={left} y={top} width={innerWidth} height={plotHeight} fill="url(#chart-bg-fade)" rx="12" />

          {priceTicks.map((tick) => (
            <g key={`price-${tick.y}`}>
              <line
                x1={left}
                x2={width - right}
                y1={tick.y}
                y2={tick.y}
                stroke="rgba(148,163,184,0.12)"
                strokeDasharray="4 6"
              />
              <text x={width - right + 8} y={tick.y + 4} fill="rgba(148,163,184,0.78)" fontSize="11">
                {compactValue(tick.value, 6)}
              </text>
            </g>
          ))}

          <line
            x1={left}
            x2={width - right}
            y1={volumeTop - 6}
            y2={volumeTop - 6}
            stroke="rgba(148,163,184,0.18)"
          />

          {sortedCandles.map((candle, index) => {
            const centerX = left + index * slotWidth + slotWidth / 2;
            const openY = priceY(priceToNumber(candle.open));
            const closeY = priceY(priceToNumber(candle.close));
            const highY = priceY(priceToNumber(candle.high));
            const lowY = priceY(priceToNumber(candle.low));
            const bodyTop = Math.min(openY, closeY);
            const bodyHeight = Math.max(Math.abs(closeY - openY), 1.5);
            const rising = candle.close >= candle.open;
            const volumeHeightPx = volumeHeight - (volumeY(priceToNumber(candle.volumeQuote)) - volumeTop);
            const color = rising ? "#4ade80" : "#f87171";
            const volumeColor = rising ? "rgba(74,222,128,0.36)" : "rgba(248,113,113,0.34)";

            return (
              <g key={`${candle.bucketStart}-${index}`}>
                <line
                  x1={centerX}
                  x2={centerX}
                  y1={highY}
                  y2={lowY}
                  stroke={color}
                  strokeWidth={1.4}
                  strokeLinecap="round"
                />
                <rect
                  x={centerX - candleBodyWidth / 2}
                  y={bodyTop}
                  width={candleBodyWidth}
                  height={bodyHeight}
                  rx={1.5}
                  fill={color}
                  opacity={hoveredIndex === index ? 1 : 0.94}
                />
                <rect
                  x={centerX - candleBodyWidth / 2}
                  y={volumeTop + volumeHeight - volumeHeightPx}
                  width={candleBodyWidth}
                  height={Math.max(volumeHeightPx, 1)}
                  rx={1.5}
                  fill={volumeColor}
                />
                <rect
                  x={centerX - slotWidth / 2}
                  y={top}
                  width={slotWidth}
                  height={plotHeight + volumeHeight + 14}
                  fill="transparent"
                  onMouseEnter={() => setHoveredIndex(index)}
                  onMouseLeave={() => setHoveredIndex(null)}
                />
              </g>
            );
          })}

          {timeTickIndexes.map((index) => {
            const candle = sortedCandles[index];
            const centerX = left + index * slotWidth + slotWidth / 2;
            return (
              <text
                key={`time-${candle.bucketStart}`}
                x={centerX}
                y={height - 12}
                fill="rgba(148,163,184,0.78)"
                fontSize="11"
                textAnchor="middle"
              >
                {buildAxisTimeLabel(candle.bucketStart, timeframeLabel)}
              </text>
            );
          })}
        </svg>
      </div>

      <div className="chart-caption">
        {graduationTimestampMs
          ? `Internal market closed at graduation on ${new Date(graduationTimestampMs).toLocaleString()}.`
          : "Candles and volume are built from internal BuyExecuted / SellExecuted protocol trades."}
      </div>
    </div>
  );
}
