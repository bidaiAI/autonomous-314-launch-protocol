# V2 downstream checklist (0314 / b314 / 1314–9314 / f314)

This note records the downstream work needed after the new V2 contract baseline.
It is intentionally practical and implementation-facing.

## What is implemented in contracts now

### `0314`
- pure standard launch
- `receive()` buys during `Bonding314`
- no whitelist
- no token tax
- creator path: `create + atomic buy`

### `b314`
- whitelist commitment launch
- whitelist opens immediately or at a configured `whitelistOpensAt`
- open time may be delayed by up to `3 days`
- 24 hour whitelist window counted from `whitelistOpensAt`
- fixed threshold presets: `4 / 6 / 8 BNB`
- fixed slot presets: `0.1 / 0.2 / 0.5 / 1 BNB`
- exact slot-size commit only
- first-come, first-served seat filling
- auto-finalize at threshold
- self-claim allocation on success
- self-claim refund on expiry without threshold
- fallback to normal `Bonding314` after whitelist expiry
- whitelist accounting kept separate from curve accounting until settlement
- creator path: `create + atomic whitelist seat commit`
- delayed-open launches must use plain create; atomic seat commit is only valid for immediate-open launches

### `1314 .. 9314`
- standard launch family with post-grad tax
- suffix encodes tax rate `1% .. 9%`
- tax only applies in `DEXOnly`
- only pair buys/sells are taxed
- wallet-to-wallet transfers stay untaxed
- creator path: `create + atomic buy`

### `f314`
- whitelist + tax family
- whitelist lifecycle matches `b314`
- suffix identifies the family, not the exact tax rate
- exact tax config must be read from `taxConfig()`
- creator path: `create + atomic whitelist seat commit`
- delayed-open launches must use plain create; atomic seat commit is only valid for immediate-open launches

## Contract surface changes that downstream code must consume

### Factory
- constructor now requires:
  - `owner`
  - `router`
  - `protocolFeeRecipient`
  - `standardDeployer`
  - `whitelistDeployer`
  - `taxedDeployer`
  - `whitelistTaxedDeployer`
  - `standardCreateFee`
  - `whitelistCreateFee`
  - `graduationQuoteReserve`
- new create entrypoints:
  - `createLaunchAndBuy(...)`
  - `createLaunchAndBuyWithSalt(...)`
  - `createWhitelistLaunch(...)`
  - `createWhitelistLaunchWithSalt(...)`
  - `createWhitelistLaunchAndCommit(...)`
  - `createWhitelistLaunchAndCommitWithSalt(...)`
  - `createTaxLaunch(...)`
  - `createTaxLaunchWithSalt(...)`
  - `createTaxLaunchAndBuy(...)`
  - `createTaxLaunchAndBuyWithSalt(...)`
  - `createWhitelistTaxLaunch(...)`
  - `createWhitelistTaxLaunchWithSalt(...)`
  - `createWhitelistTaxLaunchAndCommit(...)`
  - `createWhitelistTaxLaunchAndCommitWithSalt(...)`
  - `batchClaimProtocolFees(...)`
  - `batchSweepAbandonedCreatorFees(...)`
- new getters:
  - `standardDeployer()`
  - `whitelistDeployer()`
  - `taxedDeployer()`
  - `whitelistTaxedDeployer()`
  - `createFeeForMode(...)`
  - `modeOf(token)`
  - `pendingModeOf(token)`
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
- `taxConfig()` returns disabled defaults for zero-tax families and real config for taxed families

### New state enum usage
UI/indexer must support:
- `Created`
- `Bonding314`
- `Migrating`
- `DEXOnly`
- `WhitelistCommit`

## Security-sensitive facts frontend must not infer incorrectly

- `b314` is **not** standard 0314 with a cosmetic suffix.
- `0314` now has a creator anti-MEV path via factory-level `create + atomic buy`.
- `b314` has the equivalent creator anti-MEV path via `create + atomic whitelist seat commit`.
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
- `0314`: standard create, plus atomic creator buy
- `b314`: whitelist create, plus atomic creator seat commit
- `1314..9314`: taxed standard create, plus atomic creator buy
- `f314`: whitelist+tax create, plus atomic creator seat commit

Whitelist create UI needs:
- threshold selector (`4 / 6 / 8`)
- slot selector (`0.1 / 0.2 / 0.5 / 1`)
- optional UTC open time selector (`now .. now + 3 days`)
- whitelist address input/import
- seat-count preview
- per-seat token estimate preview
- creator-seat autofill explanation when using the atomic commit path
- explicit copy that delayed-open launches disable atomic creator seat commit

Taxed create UI needs:
- family/rate selector (`1314..9314` or `f314`)
- `taxBps`
- `burnShareBps`
- `treasuryShareBps`
- `treasuryWallet`
- clear copy that tax only activates after graduation and only on pair transfers

### Routing / verification
Current official verification logic must stop assuming only suffix `0314` is official.
Use:
- `factory` match
- `modeOf(token)`
- `launchMode()`
- `launchSuffix()`
- and for `f314`, `taxConfig()`

### Workspace UI
`b314` / `f314` pages need explicit sections for:
- whitelist status
- whitelist open time
- deadline
- seat count / seats filled
- committed total
- per-seat tokens after finalize
- commit button
- claim allocation button
- claim refund button

Taxed pages need:
- `taxConfig.enabled`
- `taxConfig.active`
- tax rate
- burn share
- treasury share
- treasury wallet

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
- `whitelistOpensAt`
- whitelist snapshot summary
- `taxConfig`

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
3. `LaunchTokenTaxedDeployer`
4. `LaunchCreate2Deployer` (used as the `whitelistTaxedDeployer` registry target for `f314`)
5. `LaunchFactory`

### Vanity tooling
The old on-chain predict helper path was removed from the contracts to keep code size deployable.
Vanity mining must therefore be done off-chain from artifacts + constructor args.

`0314`, `b314`, `1314..9314`, and `f314` require mode-specific create2 prediction logic.
For `f314`, raw `initCode` must be assembled off-chain and predicted against the generic `whitelistTaxedDeployer` create2 target.

## Audit notes already addressed in the baseline

- whitelist settlement no longer bypasses bonding fee accounting
- whitelist threshold is constrained below graduation target
- whitelist allocation claim now stamps `lastBuyBlock`
- delayed whitelist opens are supported for `b314` / `f314`
- delayed-open whitelist launches explicitly reject atomic creator seat commit

## Deployment hardening

- `Ownable` factory controls still exist for deployer / treasury management
- after production deployment, finalize the treasury and deployer addresses, then:
  - transfer ownership to a timelock, **or**
  - renounce ownership if no further governance is desired
- do not market a deployment as immutable governance if owner control has not yet been removed or timelocked
- whitelist funds stay out of curve accounting until settlement
- factory mode is now included directly in `LaunchCreated`

## Still intentionally deferred

- richer whitelist event timelines in the reference frontend
- ops/keeper scripts for batch sweep + batch claim
- README/public docs polish for the full “5-minute launch platform kit” narrative
