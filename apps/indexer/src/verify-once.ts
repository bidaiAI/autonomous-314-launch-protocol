import { runVerificationSweepOnce } from "./verifier";

async function main() {
  const snapshot = await runVerificationSweepOnce();
  console.log(
    JSON.stringify(
      {
        verifier: snapshot
      },
      null,
      2
    )
  );
}

void main().catch((error) => {
  console.error("[verify-once] fatal", error);
  process.exitCode = 1;
});
