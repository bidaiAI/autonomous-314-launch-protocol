# Automatic contract verification / open-source flow

The current production indexer can now run a background verification worker for:

1. **Official bootstrap contracts** on BSC and Base
   - `LaunchTokenDeployer`
   - `LaunchTokenWhitelistDeployer`
   - `LaunchTokenTaxedDeployer`
   - `LaunchCreate2Deployer`
   - `LaunchFactory`
2. **Every new launch created by the official factory** via `LaunchCreated`

## Why this is low load

The worker is intentionally lightweight:

- it reads existing Hardhat `artifacts/build-info` instead of recompiling
- it scans factory logs in batches
- it rate-limits itself via `INDEXER_AUTO_VERIFY_MAX_TARGETS_PER_RUN`
- it waits between retries with backoff
- it only rechecks targets that are still unverified

In practice this is a **small background job**, not a heavy server task.

## Verification strategy

### Default path: Sourcify

The worker submits:

- `stdJsonInput`
- `compilerVersion`
- `contractIdentifier`
- `creationTransactionHash`

to Sourcify's official API:

- [Sourcify API docs](https://docs.sourcify.dev/docs/api/index.html)

Sourcify verification is already sufficient for the current production flow:

- the source is published on Sourcify
- BscScan currently surfaces that verified source on the contract page

So **automatic open-source is already achieved through Sourcify** even without a separate explorer API key.

### Optional path: explorer API key

If you set:

- `INDEXER_ETHERSCAN_API_KEY`, or
- `INDEXER_BSCSCAN_API_KEY`, or
- `INDEXER_BASESCAN_API_KEY`

the worker will also attempt direct explorer verification as a best-effort enhancement.

Without this key, the system still auto-verifies on Sourcify and the source code still shows up on BscScan via Sourcify-backed publishing.

For Base specifically:

- `INDEXER_ETHERSCAN_API_KEY` uses the multichain Etherscan V2 endpoint
- `INDEXER_BASESCAN_API_KEY` uses BaseScan directly
- if only a BaseScan key is present, the worker now falls back to Base's native explorer API instead of incorrectly sticking to the Etherscan V2 URL

## Required env

See `apps/indexer/.env.example`.

Important keys:

- `INDEXER_AUTO_VERIFY_ENABLED=1`
- `INDEXER_AUTO_VERIFY_INTERVAL_MS=60000`
- `INDEXER_AUTO_VERIFY_MIN_CONFIRMATIONS=2`
- `INDEXER_AUTO_VERIFY_MAX_TARGETS_PER_RUN=6`
- `INDEXER_AUTO_VERIFY_BOOTSTRAP_OFFICIAL=1`
- `INDEXER_SOURCIFY_SERVER_URL=https://sourcify.dev/server`
- `INDEXER_ETHERSCAN_API_URL=https://api.etherscan.io/v2/api`
- `INDEXER_BSCSCAN_API_URL=https://api.bscscan.com/api` (optional)
- `INDEXER_BASESCAN_API_URL=https://api.basescan.org/api` (optional)
- `INDEXER_ETHERSCAN_API_KEY=` (optional)
- `INDEXER_BSCSCAN_API_KEY=` (optional)
- `INDEXER_BASESCAN_API_KEY=` (optional)

## Manual one-off run

You can force one sweep locally or in a job with:

```bash
pnpm --filter @autonomous314/indexer verify:once
```

## Runtime visibility

`GET /health` now includes verifier state:

- whether verification is enabled
- next scan block
- number of tracked / pending / verified targets
- recent target outcomes

## Notes

- No factory redeploy is needed for this feature.
- This solves the automation layer, not the on-chain bytecode.
- Launch verification reconstructs constructor args from the factory creation tx and the factory config at the creation block.
- On public RPCs that prune old logs, the worker now skips historical launch log backfill when the factory still has `0` launches, then continues from the live head.
