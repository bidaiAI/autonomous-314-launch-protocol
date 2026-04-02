# Autonomous 314 Launch Protocol

Open-source **EVM-native** launch protocol with a protocol-owned pre-graduation 314 market and a canonical V2-style DEX handoff.

## Protocol model

- **pre-graduation**: protocol-native 314 bonding market
- **graduation**: immutable per-factory quote target + 20% token reserve seeds the canonical V2 pair
- **post-graduation**: 314 permanently disabled, standard ERC-20 transfers enabled
- **LP handling**: minted directly to the dead address
- **fees**: 1% total = 0.5% protocol + 0.5% creator
- **safety**: quote-side wrapped-native preload is donation-compatible and does not block graduation by itself
- **deployment**: factory supports `CREATE2` salts for vanity suffix search such as `0314`

## Positioning

This repository is the **EVM-generic core**.

The current **official launch profile** is:

- chain: **BSC**
- DEX: **PancakeSwap V2**
- wrapped native quote: **WBNB**
- graduation target: **12 BNB**
- create fee: **0.03 BNB**

The codebase is being kept generic so the same protocol can be deployed on other EVM chains that provide:

- a wrapped native token
- a V2-compatible factory/router/pair model
- predictable chain configuration for frontend + indexer profiles

## Graduation target profiles

- **official BSC profile**: `12 BNB`
- **local/dev/test profile**: lower immutable targets such as `0.2 native` for fast graduation tests

The graduation target is configured at **factory deployment time** and passed into each `LaunchToken` as an immutable value.

## Workspace layout

- `/Users/bidao/Projects/314新协议/packages/contracts` — Solidity contracts, tests, scripts
- `/Users/bidao/Projects/314新协议/apps/web` — reference frontend
- `/Users/bidao/Projects/314新协议/apps/indexer` — bounded-cost reference indexer/API
- `/Users/bidao/Projects/314新协议/docs` — protocol, integration, and demo docs

## Local demo

You do **not** need a public testnet faucet for end-to-end testing.

```bash
pnpm demo:local
```

This starts a local Hardhat chain, deploys a demo factory with a `0.2 native` graduation target, starts the indexer API, and launches the reference web app.

See:

- `/Users/bidao/Projects/314新协议/docs/LOCAL_DEMO.md`

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
