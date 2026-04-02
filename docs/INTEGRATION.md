# Autonomous 314 Protocol Integration Guide

This document describes how third-party frontends, wallets, bots, and indexers should integrate with the open launch protocol.

The **protocol core is EVM-generic**. Examples in this document use the **official BSC profile**:

- native asset: `BNB`
- wrapped native asset: `WBNB`
- canonical DEX: `PancakeSwap V2`

## 1. Canonical architecture

- **Factory**: `packages/contracts/contracts/LaunchFactory.sol`
- **Launch token**: `packages/contracts/contracts/LaunchToken.sol`

Each launch has a single token contract that behaves as:

1. `Bonding314` before graduation
2. `Migrating` during LP handoff
3. `DEXOnly` after graduation

The canonical graduation path is:

- immutable protocol contribution configured per factory deployment
- fixed `20%` token reserve
- canonical V2 pair mint
- LP burned to `0x000000000000000000000000000000000000dEaD`

The **official BSC production profile** uses `12 BNB`.

Local/dev/test deployments may intentionally use a lower immutable target such as `0.2 native` for faster graduation testing.

## 2. Frontend defaults

### Required safe defaults

Third-party UIs should default to:

- `buy(minTokenOut)` instead of raw native transfer
- `sell(tokenAmount, minQuoteOut)` with explicit preview
- showing graduation progress
- showing pair compatibility
- showing creator/protocol claim permissions

### What should not be the default UI path

Do **not** make “send the native asset directly to the token contract” the default buy flow.

The protocol still supports native `receive()` for 314 compatibility, but it has no slippage parameter and should be treated as an advanced/manual path.

## 3. State-driven UI rules

### `Bonding314`

Show:

- buy/sell actions
- `currentPriceQuotePerToken()`
- `displayGraduationProgressBps()`
- `remainingQuoteCapacity()`
- `canSell(account)` / `sellUnlockBlock(account)`
- `isPairGraduationCompatible()`
- `pairPreloadedQuote()`
- `creatorFeeSweepReady()`
- `createdAt()` / `lastTradeAt()`

Hide/disable:

- creator fee claim
- generic token transfer UI

### `Migrating`

Show:

- graduation in progress state
- pair address
- explorer links

Hide/disable:

- buy
- sell
- claim

### `DEXOnly`

Show:

- DEX price from `currentPriceQuotePerToken()`
- pair reserves from `dexReserves()`
- pair link
- creator claim if caller is creator and `creatorClaimable() > 0`

Hide/disable:

- protocol 314 buy/sell actions

## 4. Important read methods

### Factory

- `router()`
- `protocolFeeRecipient()`
- `createFee()` — current default official factory setting: `0.03 BNB`
- `graduationQuoteReserve()` — current official production profile: `12 BNB`
- `accruedProtocolCreateFees()`
- `totalLaunches()`
- `allLaunches(index)`
- `launchesOf(creator)`
- `predictLaunchAddress(...)`

If a factory deployer supplies `address(0)` for the protocol fee recipient, the contract falls back to the built-in default treasury:

- `0xC4187bE6b362DF625696d4a9ec5E6FA461CC0314`

### Launch token

- `state()`
- `pair()`
- `creator()`
- `metadataURI()`
- `currentPriceQuotePerToken()`
- `displayGraduationProgressBps()`
- `remainingQuoteCapacity()`
- `previewBuy(grossQuoteIn)`
- `previewSell(tokenAmount)`
- `canSell(account)`
- `sellUnlockBlock(account)`
- `isPairClean()`
- `isPairGraduationCompatible()`
- `pairPreloadedQuote()`
- `protocolClaimable()`
- `creatorClaimable()`
- `creatorFeeSweepReady()`
- `createdAt()`
- `lastTradeAt()`
- `dexReserves()`
- `pairSnapshot()`
- `accountedNativeBalance()`
- `unexpectedNativeBalance()`

## 5. Donation-compatible graduation

The protocol accepts quote-side WBNB preloads as donation-compatible.

This means:

- preloaded WBNB in the pair does **not** block graduation by itself
- existing LP initialization **does** block graduation
- token-side pair pollution **does** block graduation

Integrators should therefore distinguish:

1. **clean pair**
2. **pair has quote donation but still compatible**
3. **pair is not graduation-compatible**

Do not assume that post-graduation DEX quote reserve equals exactly `12 BNB`.

Instead, treat the quote side as:

- production default: `12 BNB`
- otherwise: whatever immutable `graduationQuoteReserve()` the deployed factory/token was configured with

Instead:

- `Graduated.quoteAmountContributed` = protocol-provided quote
- `Graduated.preloadedQuoteAmount` = quote already present in pair before canonical mint

## 6. Event semantics

### Factory

#### `LaunchCreated`

- `creator`
- `token`
- `name`
- `symbol`
- `metadataURI`

Use this as the canonical new-launch event.

### Launch token

#### `BuyExecuted`

Contains:

- buyer
- gross quote used
- net quote added to curve reserve
- protocol fee (`0.3%`)
- creator fee (`0.7%`)
- refund amount
- token out
- post-trade curve quote reserve
- post-trade sale token reserve

#### `SellExecuted`

Contains:

- seller
- token in
- gross quote out
- net quote out
- protocol fee (`0.3%`)
- creator fee (`0.7%`)
- post-trade curve quote reserve
- post-trade sale token reserve

#### `Graduated`

Contains:

- pair
- token amount contributed by protocol
- quote amount contributed by protocol
- quote amount preloaded before canonical mint
- LP amount burned

This event is the canonical handoff marker from bonding-phase indexing to pair-phase indexing.

#### `CreatorFeesSwept`

Contains:

- caller that triggered the sweep
- creator fee amount moved into the protocol fee vault

This event only occurs while the launch is still in `Bonding314`, the launch is at least `180 days` old, and there have been no trades for at least `30 days`.

## 7. Indexer rules

### Pre-graduation candles

Build pre-grad trades and candles from:

- `BuyExecuted`
- `SellExecuted`

### Post-graduation candles

After `Graduated`, build DEX candles from canonical pair activity:

- `Swap`

Do **not** treat `Mint` / `Burn` / `Sync` as ordinary user trades.

Do **not** fake a continuous OHLC series across bonding and DEX phases. Instead:

- keep pre-grad candles protocol-sourced
- switch chart source at the graduation block
- render `Graduated` as a system milestone marker

### Unified activity feed

For a unified launch timeline, merge:

- protocol trades from `BuyExecuted` / `SellExecuted`
- the `Graduated` milestone
- post-grad canonical pair `Swap` events

Recommended metadata on each timeline item:

- `source`: `protocol` | `system` | `dex`
- `phase`: `bonding` | `migrating` | `dexOnly`

This keeps graduation readable without pretending it is just another trade.

## 8. Low-cost serving model

To keep infrastructure costs bounded, the reference implementation prefers:

- a lightweight indexer job
- bounded launch coverage
- bounded recent activity per launch
- static JSON snapshot output
- frontend fallback to direct chain reads for fresh single-token state

Recommended pattern:

1. run the indexer on a schedule or as a cheap worker
2. write a compact snapshot JSON file
3. serve that snapshot from static storage/CDN
4. let the frontend use the snapshot for launch lists, recent activity, and segmented charts
5. keep writes and critical live state reads on-chain

This avoids an always-hot unbounded backend while preserving a good UX.

## 9. Dynamic API mode with bounded cost

If you prefer a live API instead of static snapshots, keep it bounded:

- use a short in-memory cache TTL
- cap launch count per response
- cap recent activity length per launch
- expose token-scoped endpoints instead of one huge global feed

Recommended read-only endpoints:

- `GET /health`
- `GET /snapshot`
- `GET /launches?limit=25`
- `GET /launches/:token` (lightweight metadata / indexed lifecycle context)
- `GET /launches/:token/activity?limit=40`
- `GET /launches/:token/chart`

This gives dynamic reads without turning the protocol into an unbounded analytics platform.

Recommended frontend data split:

- **live chain reads** for current token state, previews, claimable amounts, cooldown checks, and pair compatibility
- **token-scoped API reads** for launch lists, recent activity, and segmented candles
- **static snapshot fallback** if the dynamic API is unavailable

In other words, use the API for history and discovery, but keep trading-critical state pinned to on-chain reads.

Recommended freshness fields on API responses:

- `generatedAtMs`
- `indexedToBlock`

These help frontends show history/chart freshness without treating cached API data as current trading truth.

### Donation data

Donation changes may happen outside the launch token event stream.

If you want live donation visibility before graduation, also monitor:

- WBNB transfers to the pair
- pair reserve changes

If not, you can still rely on:

- `pairPreloadedQuote()`
- `Graduated.preloadedQuoteAmount`

## 8. Safe product messaging

Recommended language:

- “single-market bonding before graduation”
- “DEX-only after graduation”
- “reduces short-horizon bot efficiency”
- “improves relative fairness for human participants”

Avoid claiming:

- “no MEV”
- “bot-proof”
- “absolutely fair”
