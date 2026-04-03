# V2 downstream checklist (0314 + b314 baseline)

This note records the downstream work needed after the new V2 contract baseline.
It is intentionally practical and implementation-facing.

## What is implemented in contracts now

### `0314`
- pure standard launch
- `receive()` buys during `Bonding314`
- no whitelist
- no token tax

### `b314`
- whitelist commitment launch
- 24 hour whitelist window
- fixed threshold presets: `4 / 6 / 8 BNB`
- fixed slot presets: `0.1 / 0.2 / 0.5 / 1 BNB`
- exact slot-size commit only
- first-come, first-served seat filling
- auto-finalize at threshold
- self-claim allocation on success
- self-claim refund on expiry without threshold
- fallback to normal `Bonding314` after whitelist expiry
- whitelist accounting kept separate from curve accounting until settlement

## Contract surface changes that downstream code must consume

### Factory
- constructor now requires:
  - `owner`
  - `router`
  - `protocolFeeRecipient`
  - `standardDeployer`
  - `whitelistDeployer`
  - `standardCreateFee`
  - `whitelistCreateFee`
  - `graduationQuoteReserve`
- new create entrypoints:
  - `createWhitelistLaunch(...)`
  - `createWhitelistLaunchWithSalt(...)`
- new getters:
  - `standardDeployer()`
  - `whitelistDeployer()`
  - `createFeeForMode(...)`
  - `modeOf(token)`
- canonical create event is now:
  - `LaunchCreated(creator, token, mode, name, symbol, metadataURI)`

### Token base
- `launchMode()`
- `launchSuffix()`
- `whitelistStatus()`
- `whitelistSnapshot()`
- `isWhitelisted(address)`
- `canCommitWhitelist(address)`
- `canClaimWhitelistAllocation(address)`
- `canClaimWhitelistRefund(address)`
- `taxConfig()` currently returns disabled defaults for the 0314+b314 baseline

### New state enum usage
UI/indexer must support:
- `Created`
- `Bonding314`
- `Migrating`
- `DEXOnly`
- `WhitelistCommit`

## Security-sensitive facts frontend must not infer incorrectly

- `b314` is **not** standard 0314 with a cosmetic suffix.
- `receive()` on `b314` during whitelist window means **commit**, not direct buy.
- `receive()` on `b314` after whitelist expiry/finalization means **buy**, because state has moved into `Bonding314`.
- whitelist settlement now applies the same 1% bonding fee split semantics as normal bonding buys.
- whitelist allocation claims set `lastBuyBlock`, so same-block sell cooldown still applies.
- whitelist threshold must remain below the graduation target.

## Frontend work

### ABI refresh
Refresh vendored ABIs in:
- `apps/web/src/artifacts/LaunchFactory.json`
- `apps/web/src/artifacts/LaunchToken.json`

### Create flow
Split create UX by mode:
- `0314`: standard create
- `b314`: whitelist create

Whitelist create UI needs:
- threshold selector (`4 / 6 / 8`)
- slot selector (`0.1 / 0.2 / 0.5 / 1`)
- whitelist address input/import
- seat-count preview
- per-seat token estimate preview

### Routing / verification
Current official verification logic must stop assuming only suffix `0314` is official.
Use:
- `factory` match
- `modeOf(token)`
- `launchMode()`
- `launchSuffix()`

### Workspace UI
`b314` pages need explicit sections for:
- whitelist status
- deadline
- seat count / seats filled
- committed total
- per-seat tokens after finalize
- commit button
- claim allocation button
- claim refund button

## Indexer work

### ABI refresh
Refresh vendored ABIs in:
- `apps/indexer/src/artifacts/LaunchFactory.json`
- `apps/indexer/src/artifacts/LaunchToken.json`

### Snapshot fields
Add at minimum:
- `mode`
- `suffix`
- `whitelistStatus`
- whitelist snapshot summary

### Event handling
Update `LaunchCreated` decoding for the new `mode` field.
Whitelist event ingestion should eventually include:
- `WhitelistConfigured`
- `WhitelistSeatCommitted`
- `WhitelistFinalized`
- `WhitelistExpired`
- `WhitelistRefundClaimed`
- `WhitelistAllocationClaimed`

## Deployment and tooling work

### Deploy scripts
Update V2 deployment scripts to deploy in this order:
1. `LaunchTokenDeployer`
2. `LaunchTokenWhitelistDeployer`
3. `LaunchFactory`

### Vanity tooling
The old on-chain predict helper path was removed from the contracts to keep code size deployable.
Vanity mining must therefore be done off-chain from artifacts + constructor args.

`0314` and `b314` require different init-code builders.

## Audit notes already addressed in the baseline

- whitelist settlement no longer bypasses bonding fee accounting
- whitelist threshold is constrained below graduation target
- whitelist allocation claim now stamps `lastBuyBlock`
- whitelist funds stay out of curve accounting until settlement
- factory mode is now included directly in `LaunchCreated`

## Still intentionally deferred

- taxed modes `1314..9314`
- whitelist+tax family `f314`
- frontend/indexer migration to the new ABIs and mode-aware UI
- README/public docs rewrite for the V2 mode matrix
