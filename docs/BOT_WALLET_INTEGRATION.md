# Autonomous 314 Trading Bot & Wallet Integration

This document is the practical companion to [`docs/INTEGRATION.md`](./INTEGRATION.md).

## Start here

Before shipping a wallet or trading-bot integration, make sure you do all of the following:

1. branch execution on `state()`
2. read `launchMode()` / `launchSuffix()`
3. treat whitelist families separately from open-market families
4. route `DEXOnly` flow to the canonical V2 pair, not to pre-grad logic

Use it if you are integrating Autonomous 314 into:

- a **trading bot**
- a **wallet**

If you want the full protocol surface first, read [`docs/INTEGRATION.md`](./INTEGRATION.md), then come back here for the execution and UX rules.

---

## 1. Core integration rule

Autonomous 314 is **state-routed**.

> **Do not integrate Autonomous 314 as a single-venue token.**
>
> A launch can move from contract-native bonding, to whitelist-seat flow, to migration, to canonical V2 DEX trading. If your integration assumes one permanent venue, it will misroute users.

Your bot or wallet must decide the execution path from the token state:

- `Bonding314` → trade against the **launch contract itself**
- `WhitelistCommit` → handle **fixed-seat whitelist semantics**
- `Migrating` → treat as **temporarily non-tradable**
- `DEXOnly` → route to the **canonical V2 DEX pair**

Do **not** assume one permanent trading venue.

That is the most important difference between Autonomous 314 and a normal token-list or DEX-only integration.

---

## 2. Launch families your integration must understand

| Family | Suffix | What it means for integrators |
|---|---|---|
| Standard | `0314` | open pre-grad bonding market, no whitelist, no tax |
| Whitelist | `b314` | fixed-seat whitelist flow before open market |
| Taxed standard | `1314..9314` | normal launch flow, post-grad token has tax config |
| Whitelist + tax | `f314` | whitelist first, taxed tokenomics after graduation |

### What matters for trading bots

- `0314` and `1314..9314` behave like open-market pre-grad launches
- `b314` and `f314` require explicit whitelist handling before open market trading

### What matters for wallets

- show the family clearly
- show whitelist state clearly
- show tax config clearly for taxed families
- do not collapse all families into one generic “buy token” flow

---

## 3. Minimum contract reads

Every serious trading bot or wallet should read at least:

### Factory

- `modeOf(token)`
- `graduationQuoteReserve()`
- `predictLaunchAddress(...)`
- create entrypoints relevant to the family being used

### Launch token

- `state()`
- `launchMode()`
- `launchSuffix()`
- `creator()`
- `metadataURI()`
- `currentPriceQuotePerToken()`
- `displayGraduationProgressBps()`
- `remainingQuoteCapacity()`
- `previewBuy(grossQuoteIn)`
- `previewSell(tokenAmount)`
- `pair()`
- `creatorClaimable()`
- `protocolClaimable()`
- `whitelistSnapshot()` for whitelist families
- `taxConfig()` for taxed families
- `isTaxablePool(pool)` for taxed families
- `dexReserves()` after graduation

For pair cleanliness / preload status, prefer the indexer snapshot fields:

- `pairClean`
- `pairGraduationCompatible`
- `pairPreloadedQuote`

For the full method list, see [`docs/INTEGRATION.md`](./INTEGRATION.md).

---

## 4. Trading bot integration

### 4.1 Pre-graduation routing

Before graduation, the launch contract itself is the market.

A trading bot should:

1. read `state()`
2. confirm the launch family
3. preview with `previewBuy` / `previewSell`
4. submit bounded execution with slippage protection
5. re-check state after inclusion

Do **not** assume a PancakeSwap route before graduation.

### 4.2 Whitelist families

For `b314` and `f314`, bots must treat the launch as a whitelist seat system, not a free-size presale:

- read `whitelistSnapshot()`
- respect `opensAt`
- respect `deadline`
- read `slotSize`
- read `seatCount`
- read `seatsFilled`
- only submit the **exact** seat amount

Important rule:

- one approved address commits one exact seat amount once
- any non-exact contribution should be treated as invalid

### 4.3 During migration

If the token is `Migrating`:

- do not route normal buys or sells
- show or log the pair address if available
- wait until `DEXOnly` before treating the token as a normal DEX asset

### 4.4 After graduation

If the token is `DEXOnly`:

- route via PancakeSwap V2 or the canonical V2 router for that deployment
- use `pair()` as the pair identity
- use `dexReserves()` and normal DEX pricing flows
- for taxed families, treat only **registered taxed pools** as fee-on-transfer venues
- use `isTaxablePool(pool)` if you need to distinguish a taxed pool from an ordinary wallet, vault, or helper contract

### 4.5 Safety rules for bots

- always branch on `state()`
- distinguish whitelist flow from open-market flow
- handle `Migrating` explicitly
- distinguish:
  - clean pair
  - quote-preloaded but compatible pair
  - incompatible pair

---

## 5. Wallet integration

Wallets should treat Autonomous 314 as a **launch primitive with lifecycle state**, not just another ERC-20.

### 5.1 Launch list / discovery

At minimum, show:

- token name / symbol
- launch family
- creator
- graduation progress
- whitelist badge when applicable
- tax badge when applicable
- whether the viewed post-grad pool is registered for tax when applicable

### 5.2 Launch detail page

Show:

- current lifecycle state
- creator address
- contract address
- current price
- graduation progress
- whitelist data when applicable
- tax config for taxed families
- DEX pair link after graduation
- social links from `metadataURI`

### 5.3 Action routing

Wallet action routing should be:

- `Bonding314` → protocol-native buy / sell
- whitelist-active `b314` / `f314` → whitelist-seat UX, not generic buy-any-amount UX
- `Migrating` → disable trade actions
- `DEXOnly` → hand off to canonical V2 DEX flow

### 5.4 Metadata policy

`metadataURI` is useful for UX, but not protocol truth.

Wallets should use metadata for:

- name confirmation
- description
- image
- website / X / Telegram / Discord

But execution truth should still come from contract reads.

---

## 6. Recommended integration architecture

For most teams, a practical architecture is:

1. **event listener**
   - factory + launch-token logs
2. **state cache**
   - latest token lifecycle state
3. **metadata resolver**
   - social links + image
4. **execution router**
   - pre-grad = launch contract
   - post-grad = canonical V2 router

That keeps one token identity while allowing the execution venue to change safely with protocol state.

---

## 7. Reference API usage

The reference indexer is useful for bounded-cost discovery and hydration.

Useful routes:

- `GET /health`
- `GET /snapshot`
- `GET /launches`
- `GET /launches/:token`
- `GET /launches/:token/activity`
- `GET /launches/:token/chart`

Typical usage:

- trading bots → launch discovery and state hydration
- wallets → token detail hydration and chart / activity views

The protocol remains usable directly from contracts, but the reference API can reduce integration time and RPC pressure.

## Related docs

- [`docs/INTEGRATION.md`](./INTEGRATION.md) — full protocol surface and read methods
- [`docs/LAUNCH_METADATA.md`](./LAUNCH_METADATA.md) — metadata schema for images and social links
