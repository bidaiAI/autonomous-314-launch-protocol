# Autonomous 314 — Base Runtime Profile

Last updated: **2026-04-10**

This page documents the **Base chain deployment profile** for Autonomous 314.

It is a **separate single-chain runtime** from the BNB Smart Chain deployment.
Use it when you deploy or integrate the Base instance of the protocol.

## Public network values

- **Chain:** Base
- **Chain ID:** `8453`
- **Native asset:** `ETH`
- **Wrapped native asset:** `WETH`
- **Canonical DEX:** QuickSwap V2
- **Recommended RPC:** `https://mainnet.base.org`
- **Explorer API:** `https://api.basescan.org/api`

## Base deployment parameters

- **Create fee (standard / taxed):** `0.005 ETH`
- **Create fee (whitelist / f314):** `0.01 ETH`
- **Graduation target:** `4 ETH`
- **Whitelist thresholds:** `1 / 2 / 3 ETH`
- **Whitelist seat sizes:** `0.04 / 0.1 / 0.2 / 0.5 ETH`
- **Whitelist max seats:** `80`

## Official Base deployment

- **Factory:** `0x6fDE83bB814AC79D1267695d532e2Dd9d16A0314`
- **Factory deployment tx:** `0x66f47b312f40ccff7c22f52bffc0b4610c0c091e42d5ea3409a3e4926b2f6814`
- **Factory deployment block:** `44505311`
- **Deployment salt:** `0x910c5bb21b8b4100fd60a57155745d3aefb496aa859fc088f8136be56ca8ef31`

### Official Base support deployers

| Contract | Address | Deployment tx | Block |
|---|---|---|---|
| LaunchTokenDeployer | `0xc6611f07a35222095A78Be7fa6e5f5E3B9585e83` | `0x971a8396501b0687b3cc3090c8e413fcc9df5fd0a57ff8d0355d27b2022863d4` | `44504892` |
| LaunchTokenWhitelistDeployer | `0x502C1605B17E2c0B67Dd4C855E095989945aB3cc` | `0x34972b27827172cef5e3058da9f69a7f596f281412f6e18d4a87f95760e3c20f` | `44505296` |
| LaunchTokenTaxedDeployer | `0xA45921Dc733188c8C68D017984224E0EC125b095` | `0xb6086624c3eaf66d3011caa02f30c3319c093fd2b932251e84aec202bb27f3e2` | `44505302` |
| LaunchCreate2Deployer | `0xf0Ef9342fB2866580F4d428E6FF00E5394E15182` | `0xaf3eb01d437c08bea997c039492e1bb51e2c546988e2e02c7f16986526075920` | `44505306` |

### Create2 bind

- **Whitelist-taxed deployer bind tx:** `0xe51199a3da00cbd95c019c88f201ad390644f12393d4705bb3b2d4a3cdcc4341`
- **Whitelist-taxed deployer bind block:** `44505314`

## Indexer defaults

### Current public Base indexer

- **Indexer base URL:** `https://indexer-base-production.up.railway.app`
- **Indexer health:** `https://indexer-base-production.up.railway.app/health`

For a dedicated Base indexer deployment:

- `INDEXER_CHAIN_ID=8453`
- `INDEXER_RPC_URL=https://mainnet.base.org`
- `INDEXER_NATIVE_USD_PRICE_API_URL=https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd`
- `INDEXER_ETHERSCAN_API_URL=https://api.basescan.org/api`
- `INDEXER_BASESCAN_API_URL=https://api.basescan.org/api`
- `INDEXER_PUBLIC_BASE_URL=<base-indexer-public-origin>`
- `INDEXER_SOCIAL_NOTIFY_BASE_URL=<base-frontend-origin>`
- `INDEXER_METADATA_PUBLIC_ORIGINS=<base-frontend-origin>`
- `INDEXER_CORS_ORIGIN=<base-frontend-origin>`

The Base indexer should run as an **independent deployment**, not as a mixed-chain aggregator.

Base official bootstrap targets are now known. You can enable:

- `INDEXER_AUTO_VERIFY_BOOTSTRAP_OFFICIAL=1`

For social rollout, keep notifications disabled until the dedicated Base public URLs are configured:

- `INDEXER_SOCIAL_NOTIFY_ENABLED=0`

## Frontend env keys

The current frontend only exposes the Base runtime when these values are configured:

- `VITE_BASE_RPC_URL`
- `VITE_BASE_FACTORY_ADDRESS`
- `VITE_BASE_INDEXER_API_URL`
- `VITE_BASE_INDEXER_SNAPSHOT_URL`

If `VITE_BASE_FACTORY_ADDRESS` is blank, the Base selector stays hidden so the public UI does not expose a half-configured chain.

## Notes

- Base uses the same launch families as the rest of the protocol:
  - `0314` — standard
  - `b314` — whitelist
  - `1314..9314` — taxed standard
  - `f314` — whitelist + tax
- The Base deployment keeps the same protocol semantics, but uses its own router, factory, deployers, and indexer.
- The Base public UI and Base indexer deployment can now use these addresses directly without changing the BNB Chain runtime.
