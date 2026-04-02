import { mkdir, writeFile } from "fs/promises";
import { dirname } from "path";
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
