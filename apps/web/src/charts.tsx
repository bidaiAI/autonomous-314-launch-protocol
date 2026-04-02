import type { CandlePoint } from "./types";

type SegmentedPhaseChartProps = {
  bondingCandles: CandlePoint[];
  dexCandles: CandlePoint[];
  graduationTimestampMs: number | null;
};

function linePoints(candles: CandlePoint[], left: number, right: number, width: number, height: number, padding: number, min: number, span: number) {
  if (candles.length === 0) return "";

  const innerLeft = padding + left * (width - padding * 2);
  const innerRight = padding + right * (width - padding * 2);
  const innerWidth = Math.max(innerRight - innerLeft, 1);

  return candles
    .map((candle, index) => {
      const x = innerLeft + (index / Math.max(candles.length - 1, 1)) * innerWidth;
      const y = height - padding - ((Number(candle.close) - min) / span) * (height - padding * 2);
      return `${x},${y}`;
    })
    .join(" ");
}

export function SegmentedPhaseChart({ bondingCandles, dexCandles, graduationTimestampMs }: SegmentedPhaseChartProps) {
  const hasBonding = bondingCandles.length > 0;
  const hasDex = dexCandles.length > 0;

  if (!hasBonding && !hasDex) {
    return <div className="empty-state">No protocol or DEX candles yet.</div>;
  }

  const width = 720;
  const height = 220;
  const padding = 18;
  const divider = 0.5;
  const allCloses = [...bondingCandles, ...dexCandles].map((candle) => Number(candle.close));
  const min = Math.min(...allCloses);
  const max = Math.max(...allCloses);
  const span = Math.max(max - min, 1);

  const bondingPoints = linePoints(
    bondingCandles,
    hasBonding && hasDex ? 0 : 0,
    hasBonding && hasDex ? 0.46 : 1,
    width,
    height,
    padding,
    min,
    span
  );

  const dexPoints = linePoints(
    dexCandles,
    hasBonding && hasDex ? 0.54 : 0,
    1,
    width,
    height,
    padding,
    min,
    span
  );

  const dividerX = padding + divider * (width - padding * 2);

  return (
    <div className="chart-shell segmented">
      <svg viewBox={`0 0 ${width} ${height}`} className="chart-svg" role="img" aria-label="Segmented price trajectory">
        <defs>
          <linearGradient id="bondingLine" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#5eead4" />
            <stop offset="100%" stopColor="#38bdf8" />
          </linearGradient>
          <linearGradient id="dexLine" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#a78bfa" />
            <stop offset="100%" stopColor="#f59e0b" />
          </linearGradient>
        </defs>

        {hasBonding && hasDex && (
          <>
            <line
              x1={dividerX}
              x2={dividerX}
              y1={padding}
              y2={height - padding}
              stroke="rgba(245,247,251,0.28)"
              strokeDasharray="5 5"
              strokeWidth="1.5"
            />
            <text x={dividerX + 8} y={padding + 10} fill="rgba(245,247,251,0.68)" fontSize="11">
              Graduated
            </text>
          </>
        )}

        {hasBonding && (
          <text x={padding} y={padding + 10} fill="rgba(94,234,212,0.88)" fontSize="11">
            Bonding314
          </text>
        )}
        {hasDex && (
          <text x={width - padding - 68} y={padding + 10} fill="rgba(245,158,11,0.88)" fontSize="11">
            DEXOnly
          </text>
        )}

        {bondingPoints && (
          <polyline
            fill="none"
            stroke="url(#bondingLine)"
            strokeWidth="3"
            strokeLinejoin="round"
            strokeLinecap="round"
            points={bondingPoints}
          />
        )}

        {dexPoints && (
          <polyline
            fill="none"
            stroke="url(#dexLine)"
            strokeWidth="3"
            strokeLinejoin="round"
            strokeLinecap="round"
            points={dexPoints}
          />
        )}
      </svg>

      {graduationTimestampMs ? (
        <div className="chart-caption">
          Cutover anchored to <strong>Graduated</strong> at {new Date(graduationTimestampMs).toLocaleString()}.
        </div>
      ) : (
        <div className="chart-caption">
          Chart shows the current phase only until the canonical <strong>Graduated</strong> marker is emitted.
        </div>
      )}
    </div>
  );
}
