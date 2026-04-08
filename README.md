# Autonomous 314 Launch Protocol

[English](./README.md) | [简体中文](./README.zh-CN.md)

[![License: MIT](https://img.shields.io/badge/license-MIT-0f172a.svg)](./LICENSE)
![EVM Generic](https://img.shields.io/badge/core-EVM%20generic-2563eb.svg)
![BSC Official Profile](https://img.shields.io/badge/official%20profile-BSC-f59e0b.svg)
![Creator First](https://img.shields.io/badge/fees-0.7%25%20creator%20%7C%200.3%25%20protocol-10b981.svg)
![Open Protocol](https://img.shields.io/badge/model-open%20protocol-7c3aed.svg)

An open-source, deplatformed **EVM-native** onchain launch protocol with a built-in bonding market, designed to return token launches and liquidity back to the market itself. Pre-graduation trading lives inside the launch contract itself, and graduation hands liquidity off to a canonical V2-style DEX without requiring a centralized launch platform to remain online.

**Official frontend:** [https://auto314.cc](https://auto314.cc)

## Start here

If you are reading this repo for integration work, start here:

- **Protocol integration:** [`docs/INTEGRATION.md`](docs/INTEGRATION.md)
- **Metadata / socials / images:** [`docs/LAUNCH_METADATA.md`](docs/LAUNCH_METADATA.md)

## Official channels

- **Official X:** [@auto314cc](https://x.com/auto314cc)
- **Official Telegram channel:** [@Autonomous314](https://t.me/Autonomous314)
- **Official alerts channel:** [@auto314_Alert](https://t.me/auto314_Alert)

> Not another launchpad website — a self-contained launch protocol where the contract itself is the market, the reserve system, and the graduation engine.

## One-line thesis

Launches should not need a platform to exist.

Autonomous 314 is built around a simple thesis:

- the market should live in the contract
- the graduation path should live in the contract
- the project should keep most of the launch fee surface
- the frontend should be replaceable
- the protocol should still function if the official website disappears

## Protocol goals

Autonomous 314 is built with four concrete goals:

1. **Make launches platform-independent**
   - a project should still be launchable and tradable even if the official frontend disappears
2. **Return launch economics to the market and the project side**
   - the protocol should be sustainable, but launch trading fees should not be designed around platform extraction
3. **Reduce launch-stage fragility**
   - avoid the most obvious weaknesses of older 314-style markets, especially around fragmented markets and messy graduation handoffs
4. **Publish a reusable open EVM primitive**
   - not just a website, but a protocol other frontends, wallets, bots, and platforms can adopt

## Why Autonomous 314 is structurally different

The point of this protocol is not just "launch tokens on BSC". The point is to change **where the market logic lives** and **who depends on whom**.

- **Contract-native market, not frontend-native market**
  - before graduation, trading happens inside the launch contract itself instead of relying on a platform UI or off-chain swap backend
- **Graduation as a state transition, not a platform operation**
  - the handoff to the canonical V2 pair is part of the contract lifecycle, not an admin workflow
- **Single pre-grad venue by design**
  - transfer restrictions intentionally keep early price discovery inside one canonical market path instead of encouraging fragmented side pools
- **Launch families as protocol primitives**
  - `0314`, `b314`, `1314..9314`, and `f314` are protocol-level families with different execution surfaces, not just frontend presets
- **Creator-first fee surface**
  - pre-grad fees are structurally biased toward the creator side rather than maximizing platform rent
- **Replaceable interface layer**
  - the official frontend is a reference implementation; wallets, bots, aggregators, and white-label sites can integrate directly without asking for permission
- **Low-backend operating model**
  - execution lives on-chain, while the server mainly handles indexing, charts, and presentation, which keeps the protocol cheaper to run than a platform-owned trading engine

In short:

> **Autonomous 314 is not a launchpad website with contracts attached. It is a launch protocol where contracts carry the market, the reserve logic, and the graduation path.**

## Core capabilities

At a functional level, the protocol already provides:

- **factory-based launch deployment**
  - deploys new launch instances with immutable profile parameters
- **contract-native pre-grad trading**
  - the launch contract itself runs the market before graduation
- **single-market pre-grad flow**
  - ordinary transfers are restricted before graduation to reduce side-market fragmentation
- **graduation to a canonical V2-style DEX**
  - 20% token reserve plus immutable quote target seeds the canonical pair
- **post-grad hard cutover**
  - after graduation, 314 is permanently disabled and the token behaves like a normal transferable asset
- **market-first fee accounting**
  - 1% total fee = 0.7% creator + 0.3% protocol, applied only inside the built-in pre-grad market
- **abandoned creator-fee resolution**
  - abandoned pre-grad launches can eventually sweep unclaimable creator fees into the protocol vault
- **reference integration stack**
  - a reference frontend, a bounded-cost indexer, and a local demo flow are included
- **official vanity create flow**
  - the reference frontend locally mines a `CREATE2` salt so official launches default to addresses ending in `0314`
- **creator anti-MEV create entrypoints**
  - `0314` and `1314..9314` support factory-level `create + atomic buy`, while `b314` and `f314` support `create + atomic whitelist seat commit`
- **rich launch metadata flow**
  - the create UI supports description, image, website, and social links while keeping only `metadataURI` on-chain
- **mode-based launch families**
  - `0314`, `b314`, `1314..9314`, and `f314` are first-class protocol families instead of ad hoc frontend presets
- **protocol-ops batch tooling**
  - the factory can batch-claim protocol fees and batch-sweep abandoned creator fees across many launches

See [`docs/LAUNCH_METADATA.md`](docs/LAUNCH_METADATA.md) for the recommended metadata schema.

### Third-party integration quick links

- **Protocol surface:** [`docs/INTEGRATION.md`](docs/INTEGRATION.md)
- **Metadata schema:** [`docs/LAUNCH_METADATA.md`](docs/LAUNCH_METADATA.md)

Recommended reading order:

1. `INTEGRATION.md`
2. `LAUNCH_METADATA.md`

## Launch families and suffixes

The protocol is now organized as a small launch-family kit instead of a single launch flavor:

| Family | Suffix | Whitelist | Tax | Creator anti-MEV path | Typical use |
|---|---|---:|---:|---|---|
| Standard | `0314` | No | No | `create + atomic buy` | cleanest default launch |
| Whitelist | `b314` | Yes | No | `create + atomic whitelist seat commit` | fixed-seat whitelist / presale launch |
| Taxed standard | `1314..9314` | No | Yes (`1%..9%`) | `create + atomic buy` | post-grad tokenomics with buy/sell tax |
| Whitelist + tax | `f314` | Yes | Yes | `create + atomic whitelist seat commit` | whitelist launch that later enables post-grad tax |

Important suffix rules:

- `1314..9314` directly encode the standard-family tax rate
- `f314` only means **whitelist + tax family**; the actual tax rate must be read from `taxConfig()`
- `b314` and `f314` can open immediately or at a configured `whitelistOpensAt` up to `3 days` after creation
- whitelist families use **fixed seats**, not variable-size presale allocations
- whitelist address count must be **at least the seat count and at most 3x the seat count**
- each approved address can commit **one exact seat amount once**; any other amount is rejected by revert
- when the threshold is reached, the whitelist finalizes and **every filled seat receives the same token allocation per seat**
- delayed-open whitelist families intentionally disable atomic creator seat commit
- batch ops such as protocol fee sweeping and claiming are protocol tooling, not end-user UI features

## 5-minute launch platform kit

Autonomous 314 is not only a protocol for one official site. It is intended to be a **launch platform kit**:

- deploy a factory profile
- point a frontend at that factory
- run a lightweight indexer or even a static snapshot flow
- launch, trade, graduate, and index without building a separate swap backend

In other words, the goal is that anyone can stand up a usable meme launch platform in minutes, with lower backend cost and more launch modes than typical closed launchpad websites.

## Why the server load stays low

One of the core design goals is to avoid turning the protocol into a heavy backend business.

The protocol keeps the most important execution path **on-chain**:

- creation happens through the factory
- pre-grad trading happens inside the launch contract
- graduation happens inside the launch contract
- post-grad trading happens on the canonical V2 DEX

That means the server is **not** responsible for:

- running the market
- holding user balances
- matching orders
- executing swaps
- manually graduating launches

The reference server is intentionally lightweight. It mainly does:

- launch list aggregation
- activity normalization
- segmented candle generation
- metadata upload helpers for the reference UI

In practical terms, this means the backend pressure is usually much lower than a typical platform launchpad, because:

- there is no custom swap engine to operate
- there is no custody layer
- there is no off-chain orderbook
- there is no heavy launch orchestration daemon

The real pressure surface is mostly **RPC read pressure**, not server-side business logic pressure.

### What can become the bottleneck

If the protocol grows, the main scaling pressure points are:

- archive/RPC log reads
- launch list indexing windows
- chart generation across many launches
- metadata hosting and image delivery

These are operationally much cheaper than running a proprietary trading engine, but they still need sensible limits, caching, and pagination.

### Current operational model

The current reference stack already reflects this low-backend philosophy:

- frontend can read critical truth directly from chain
- indexer responses are bounded and cached
- activity and chart endpoints are token-scoped
- metadata publishing is optional helper functionality, not protocol truth

So the short answer is:

> **server pressure is not high by design; the protocol pushes execution on-chain and keeps the backend as a lightweight indexing and presentation layer.**

## Governance posture after deployment

The factory still uses `Ownable` for treasury / deployer administration. The intended production posture is:

1. deploy
2. verify treasury and deployer addresses
3. transfer ownership to a timelock, or renounce ownership if no further governance is desired

Until that happens, deployments should not be described as governance-final.

## What problem this solves

This protocol is designed to solve a specific class of launch problems:

- creators should not need to rent access to a platform just to get a market
- pre-grad trading should not depend on a centralized UI remaining online
- graduation should not be a manual platform operation
- the protocol should expose clear integration points for third parties
- the launch flow should be understandable as a contract system, not hidden platform logic

## Why this exists

Most launch platforms normalize platform rent:

- they own the user flow
- they own discovery
- they often capture the full launch fee surface
- and projects depend on the platform UI to exist as a usable market

Autonomous 314 takes the opposite view:

- the **launch contract itself** is the market, reserve system, and graduation state machine
- the protocol is **open and composable**, so anyone can build their own frontend, wallet flow, or indexer on top
- the economics are designed to return more of the fee surface to the project and the market, instead of being fully extracted by a platform
- the official frontend is a **reference implementation**, not the gatekeeper

## What makes it different

Compared with a typical launchpad model, Autonomous 314 is intentionally opinionated:

- **contract-native market before graduation** instead of forcing all discovery and execution through a platform-owned pool manager
- **single-market pre-grad flow** instead of encouraging fragmented trading venues before the token is ready for a public DEX market
- **market-first fee split** instead of platform-first rent extraction
- **graduation as a contract state transition** instead of a platform-controlled operational step
- **open integration surface** so wallets, bots, indexers, or white-label frontends can integrate the protocol without asking for permission

## Non-goals

This protocol does **not** try to be all things at once.

It is not trying to:

- replace every off-chain UX layer with on-chain logic
- eliminate all MEV on public blockchains
- become a fully general AMM framework
- force all deployments to use one official frontend or one official indexer
- turn the official website into a mandatory gatekeeper

## Who this is for

Autonomous 314 is designed for:

- **creators** who want a launch flow without surrendering the entire fee surface to a platform
- **communities** that want a launch primitive they can run through their own frontend or tooling
- **wallets** that want to integrate launch flows directly
- **builders** who want a reusable EVM launch protocol instead of a closed launch website
- **platforms** that want to adopt an open protocol instead of owning the entire market path

## Protocol model

- **pre-graduation**: protocol-native 314 bonding market
- **graduation**: immutable per-factory quote target + 20% token reserve seeds the canonical V2 pair
- **post-graduation**: 314 permanently disabled, standard ERC-20 transfers enabled
- **LP handling**: minted directly to the dead address
- **fees**: 1% total = 0.3% protocol + 0.7% creator, internal pre-grad market only
- **abandoned creator fees**: if a launch is still pre-graduation after `180 days` and has had no trades for `30 days`, anyone may sweep the unclaimable creator fee vault into the protocol fee vault
- **safety**: quote-side wrapped-native preload is surfaced as a non-canonical opening-state warning rather than a cheap graduation DOS path
- **deployment**: factory supports `CREATE2` salts for vanity suffix search such as `0314`

## Lifecycle

```mermaid
flowchart LR
    A["Factory deploys LaunchToken"] --> B["Bonding314<br/>contract-native market"]
    B --> C["Graduation target reached<br/>partial fill at boundary"]
    C --> D["Canonical V2 pair seeded<br/>20% token reserve + quote target"]
    D --> E["LP burned to dead"]
    E --> F["DEXOnly<br/>314 permanently disabled"]
```

## Architecture at a glance

The system has four practical layers:

1. **Factory**
   - deploys launch instances
   - sets immutable launch profile parameters
   - supports vanity `CREATE2` salts
2. **LaunchToken**
   - runs the pre-grad market
   - tracks reserves and fee vaults
   - owns graduation state transitions
3. **Reference frontend**
   - safe default execution path
   - token workspace, charts, activity, claim actions
4. **Reference indexer**
   - bounded-cost activity and segmented chart APIs
   - optional convenience layer, not the protocol truth source

## State machine

Each launch moves through a narrow, explicit state machine:

- `Created`
  - deployed and initialized
- `Bonding314`
  - contract-native pre-grad market is live
  - ordinary transfers are restricted
- `Migrating`
  - graduation path is executing
  - internal market is freezing and canonical V2 handoff is taking place
- `DEXOnly`
  - 314 is permanently disabled
  - the token behaves like a normal post-launch ERC-20/BEP-20 style asset

## Anti-MEV and market-integrity design

This protocol does **not** claim to eliminate MEV. It does try to reduce the easiest and most damaging launch-stage extraction paths.

Current design choices include:

- **pre-grad transfer lock** to reduce private side markets before graduation
- **1-block sell cooldown** to blunt same-block round-trip behavior
- **explicit buy/sell paths with slippage protection** as the intended execution path
- **partial fill at graduation boundary** so the market cannot overshoot the target in a single trade
- **post-grad hard cutover** so the protocol does not keep a permanent second market alive after DEX launch
- **quote-side preload compatibility** so stray wrapped-native deposits do not trivially DOS graduation, while the frontend still surfaces non-canonical opening state when preload exists
- **mode-specific creator anti-MEV entrypoints** so creators can atomically buy or atomically reserve their own whitelist seat at creation time

The protocol intentionally keeps **native transfer entrypoints** for the families that are meant to feel like 314:

- `0314` and `1314..9314`: before graduation, direct native transfer to the launch contract is a valid bonding-phase buy path
- `b314` and `f314`: direct native transfer during the whitelist window is a valid fixed-seat commit path, but only when the amount exactly matches the configured seat size
- whitelist launches are **seat-based**, not proportional by contribution size: one approved seat equals one equal allocation once the threshold is met
- after graduation, sending native tokens to the launch contract or transferring the token back to the launch contract will revert rather than auto-refund

Reference UIs should still prefer explicit contract calls such as `buy(minTokenOut)` for everyday execution, but integrations must not assume `receive()` is disabled.

## Creator-first economics

One of the protocol's design goals is not to reinforce platform-led extraction from on-chain liquidity, but to return launch, trading, and graduation flow back to the market itself through contracts and open participation.

- **creator share**: `0.7%` (internal pre-grad market only)
- **protocol share**: `0.3%` (internal pre-grad market only)
- **standard/taxed create fee**: `0.01 native`
- **whitelist/whitelist-tax create fee**: `0.03 native`

This means the protocol keeps a small sustainability fee during the internal pre-grad market while routing the majority of that fee back toward the project side.

Very small dust-sized trades are also protected against fee bypass. In practice this means extremely small buys or sells may either pay a minimum 1 wei total fee or become non-executable if the net output would be zero after fees.

### Fee policy

- **creator fee** accrues during pre-grad but is only claimable after graduation
- if a launch is abandoned and never graduates, creator fee does not remain stuck forever
- after `180 days` of age and `30 days` of inactivity, anyone may sweep abandoned creator fees into the protocol fee vault

This keeps the protocol market-first while still giving dead launches a clean terminal state.

## Trust and control assumptions

The protocol is designed to minimize platform dependence, but it is still important to understand the trust boundaries:

- the **launch contract** is the source of truth for pre-grad state
- the **reference frontend** is optional convenience, not protocol authority
- the **reference indexer** is a bounded-cost read layer, not the state authority
- the **canonical DEX handoff** depends on a V2-compatible router/factory/pair model on the target chain
- the **factory profile** determines immutable per-launch parameters such as graduation target

In practice, the protocol aims to reduce platform custody and platform gatekeeping, not pretend that off-chain UX layers no longer matter at all.

## Decentralization stance

Autonomous 314 is designed to fit Web3 values more closely than a closed launch website:

- launches do **not** need a platform backend to exist
- pre-grad trading does **not** depend on an external swap UI
- graduation is handled by the launch contract’s own state machine
- any third party can build:
  - a frontend
  - an indexer
  - a wallet integration
  - a bot integration
  - a white-label launch site

In other words, this repository is meant to be a **self-contained open launch system**, not just another launchpad frontend.

## Positioning

This repository is the **EVM-generic core**.

The current **official launch profile** is:

- chain: **BSC**
- DEX: **PancakeSwap V2**
- wrapped native quote: **WBNB**
- graduation target: **12 BNB**
- curve profile: Flap-aligned token-side shape scaled to the `12 BNB` repo profile
- standard/taxed create fee: **0.01 BNB** (repository V2 default)
- whitelist/whitelist-tax create fee: **0.03 BNB** (repository V2 default)
- default protocol treasury fallback: **`0xC4187bE6b362DF625696d4a9ec5E6FA461CC0314`**

If a factory deployer passes `address(0)` as the protocol fee recipient, the factory falls back to the default treasury above. Deployers can still override it explicitly.

The codebase is being kept generic so the same protocol can be deployed on other EVM chains that provide:

- a wrapped native token
- a V2-compatible factory/router/pair model
- predictable chain configuration for frontend + indexer profiles

## Open-source boundary

This repository is intended to be usable as a protocol, not merely inspected as a code sample.

Included:

- contracts
- tests
- deployment scripts
- local demo
- reference frontend
- reference indexer/API
- protocol and integration docs

Not assumed:

- a mandatory platform backend
- a mandatory official UI
- a mandatory official indexer
- a proprietary market-ops layer to keep launches alive

## What the reference apps are for

This repository includes a reference frontend and a reference indexer, but they exist to demonstrate and standardize integration patterns:

- the **frontend** shows a safe default way to create, trade, claim, and monitor a launch
- the **indexer** shows a bounded-cost way to build activity feeds and segmented charts
- neither component is meant to be the only possible interface

The protocol should remain usable through wallets, scripts, custom UIs, or alternative infrastructure providers.

## Graduation target profiles

- **official BSC profile**: `12 BNB`
- **local/dev/test profile**: lower immutable targets such as `0.2 native` for fast graduation tests

The graduation target is configured at **factory deployment time** and passed into each `LaunchToken` as an immutable value.

For the concrete bonding-curve shape used by the contracts and frontend estimates, use the official profile values already reflected in the contracts and frontend:

- `virtualTokenReserve = 107,036,752`
- `virtualQuoteReserve ≈ 4.60555128 BNB`

## Workspace layout

- `packages/contracts` — Solidity contracts, tests, scripts
- `apps/web` — reference frontend
- `apps/indexer` — bounded-cost reference indexer/API
- `docs` — protocol and integration docs

## Third-party integration quick start

If you are integrating Autonomous 314 into another product, use this reading path:

- **Wallets / trading bots**
  - [docs/INTEGRATION.md](./docs/INTEGRATION.md) — full protocol integration surface
- **Frontends / indexers**
  - [docs/INTEGRATION.md](./docs/INTEGRATION.md) — contract reads, state rules, and API usage
- **Metadata resolvers / social-link hydration**
  - [docs/LAUNCH_METADATA.md](./docs/LAUNCH_METADATA.md) — metadata schema for images and social links

Recommended reading order:

1. `INTEGRATION.md`
2. `LAUNCH_METADATA.md`

## Local demo

You do **not** need a public testnet faucet for end-to-end testing.

```bash
pnpm demo:local
```

This starts a local Hardhat chain, deploys a demo factory with a `0.2 native` graduation target, starts the indexer API, and launches the reference web app.

## Official BSC deployment

- **Factory:** `0xa5d62930AA7CDD332B6bF1A32dB0cC7095FC0314`
- **Chain:** BNB Smart Chain
- **Router:** PancakeSwap V2 Router `0x10ED43C718714eb63d5aA57B78B54704E256024E`
- **Modes:** `0314 / b314 / 1314..9314 / f314`
- **Support deployers:** `0x8FcAf0Fe7e49245d3f28f04e7b91978aBdD38A71` / `0x6E70b0eCcF42D2d8358daD89Fe37cfA1F8c8a9F2` / `0x9a5CD709C9B0a18bD7BD5C8a2f637cbE5087D1B9` / `0xcDc3D935b2349CF282e5517a8126B0fA890631e5`
- **Support deployer txs:** `0xe7bf7a28e85e222a5387ef4ae520262217ff65be75d023fa8534c497f4119d36` / `0xcd77bf0e98327158f16c1645a9c2f0bc8b6c5589862ecc8344ef831723856140` / `0x29e4824246581158804daa1d86aaba675f04f1e497166eac9961872f394bdd82` / `0x18bc4724f5275a3fc4fd2e4c476c9e8c1d140b5a4d3eceffbdec8e8d5e024260`
- **Factory deployment tx / block:** `0xf77b68c21d31c51f0dbbffb5756f233c9a6718d49f549c262220d92a875afc06` @ `91258253`
- **Whitelist-taxed deployer bind tx / block:** `0xa61eb496afb880fda09cb5f5915905cb72a912eb1f1dc78fd4c4908a460a4ab1` @ `91258260`
- **Deployment salt:** `0xdda123f499c5f7f6d817abb3686e99857361bf6990923787dd4d8c5aef555afd`
- **Create fees:** standard/tax `0.01 BNB`, whitelist/f314 `0.03 BNB`
- **Graduation target:** `12 BNB`
- **Curve profile:** `virtualTokenReserve = 107,036,752` and `virtualQuoteReserve ≈ 4.60555128 BNB` under the official 12 BNB profile
- **Source verification:** the production indexer bootstraps official factory/deployer verification and auto-submits every new launch to Sourcify; that already surfaces verified source on BscScan, while explorer API keys remain optional as an extra verification path.

The reference web app is intended to be deployed from the monorepo root on Vercel using [`vercel.json`](./vercel.json). The reference indexer/API is intended to be deployed from the monorepo root on Railway using [`railway.json`](./railway.json).

## Quick start

```bash
pnpm install
pnpm build
pnpm test
pnpm demo:local
```

After that you can open the local reference frontend and run a full create → trade → graduate flow without a public faucet.

## Vanity suffix strategy

The protocol uses suffixes as **mode identity markers** first, and vanity/branding only second.

Recommended priority:

1. **official factory** — best effort to end with `0314`
2. **standard launches** — `0314`
3. **whitelist launches** — `b314`
4. **taxed standard launches** — `1314..9314`
5. **whitelist + tax launches** — `f314`
6. **public protocol treasury / ops EOAs** — optional vanity if useful for branding

Bundled helpers:

```bash
pnpm vanity:eoa -- --suffix 0314
pnpm vanity:factory -- --suffix 0314 ...
pnpm vanity:launch -- --suffix 0314 ...
```

Operational guidance:

- use vanity mining for the **official factory** if you want a canonical, memorable protocol address
- do **not** force vanity mining on every creator launch
- for creator launches, only mine a suffix when the creator explicitly cares about it

Important caveat:

- launch vanity results only remain valid for the **exact final launch parameters and launch family**
- if you change factory address, creator, name, symbol, metadata URI, router, fee recipient, or graduation target, the predicted vanity launch address changes too

This is why the repository treats `0314` as a **best-effort identity layer**, not a hard dependency for protocol correctness.

## Current status

The repository already includes:

- core launch contracts
- tests for the main graduation and fee paths
- a reference frontend
- a reference indexer/API
- a local demo flow with low graduation target for fast iteration

The current official operating profile is **BSC-first**, while the codebase itself is kept **EVM-generic**.

The repository baseline now includes the full V2 family design:

- `0314`
- `b314`
- `1314..9314`
- `f314`
- protocol batch ops for sweeping and claiming fee surfaces at scale

## Build and test

```bash
pnpm build
pnpm test
pnpm --filter @autonomous314/contracts gas:report
```

## Open-source status

This repository is being prepared as a public open-source protocol repo:

- contracts + tests included
- reference frontend included
- reference indexer included
- local demo included
- BSC is the first official runtime profile

## Long-term direction

The aim is not to become another gatekeeping launch website.

The aim is to make this protocol good enough that:

- creators can launch without surrendering the full fee surface to a platform
- communities can run their own frontend or indexer
- wallets can integrate launches directly
- other platforms can adopt the protocol instead of owning the whole market flow

If this succeeds, the value of the system comes from open adoption, composability, and credible market-first economics — not from forcing every launch through a centralized funnel.

## FAQ

### Is this just another launchpad?

No. The aim is to make the launch contract itself carry the critical market and graduation logic, while the frontend and indexer remain replaceable.

### Does this remove MEV?

No. It reduces some of the easiest launch-stage extraction paths, but it does not claim to eliminate all MEV on public blockchains.

### Can this work without the official frontend?

Yes. That is one of the core design goals. The official frontend is a reference implementation, not a required gatekeeper. For direct third-party integration, start with [`docs/INTEGRATION.md`](./docs/INTEGRATION.md).

### Why give creators more than the protocol?

Because this system is explicitly designed to return launches and liquidity to the market itself. The protocol should be sustainable, but it should not normalize the assumption that platforms deserve the majority of launch fees.

### Is this only for BSC?

No. The codebase is written as an EVM-generic core. BSC is simply the first official runtime profile.
