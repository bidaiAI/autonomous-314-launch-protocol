import { mkdir, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { indexerConfig } from "./config";
import { buildIndexerSnapshot } from "./service";

async function main() {
  console.log("[indexer] bootstrap");
  console.log("[indexer] chain:", indexerConfig.chain);
  for (const note of indexerConfig.notes) {
    console.log("[indexer] note:", note);
  }

  const snapshot = await buildIndexerSnapshot();

  await mkdir(dirname(indexerConfig.outputPath), { recursive: true });
  await writeFile(indexerConfig.outputPath, JSON.stringify(snapshot, null, 2));
  const chartCacheDir = join(dirname(indexerConfig.outputPath), "chart-cache");
  await mkdir(chartCacheDir, { recursive: true });
  await Promise.all(
    snapshot.launches.map((launch) =>
      writeFile(
        join(chartCacheDir, `${snapshot.chainId}-${launch.token.toLowerCase()}.json`),
        JSON.stringify(
          {
            token: launch.token,
            chainId: snapshot.chainId,
            chain: snapshot.chain,
            nativeSymbol: snapshot.nativeSymbol,
            wrappedNativeSymbol: snapshot.wrappedNativeSymbol,
            dexName: snapshot.dexName,
            factory: snapshot.factory,
            generatedAtMs: snapshot.generatedAtMs,
            indexedToBlock: snapshot.toBlock,
            segmentedChart: launch.segmentedChart
          },
          null,
          2
        )
      )
    )
  );

  console.log(
    JSON.stringify(
      {
        chain: snapshot.chain,
        factory: snapshot.factory,
        outputPath: indexerConfig.outputPath,
        launchCount: snapshot.launchCount,
        launches: snapshot.launches.map((launch) => ({
          token: launch.token,
          symbol: launch.symbol,
          state: launch.state,
          activities: launch.recentActivity.length,
          bondingCandles: launch.segmentedChart.bondingCandles.length,
          dexCandles: launch.segmentedChart.dexCandles.length
        }))
      },
      null,
      2
    )
  );
}

void main().catch((error) => {
  console.error("[indexer] fatal", error);
  process.exitCode = 1;
});
