# Autonomous 314 — Official Parameters

Last updated: **2026-04-10**

This page is the **canonical public reference** for the current official Autonomous 314 deployment and runtime profile.

If any summary elsewhere differs from this page, treat **this file** as the source of truth.

## Public entrypoints

- **Official frontend:** [https://auto314.cc](https://auto314.cc)
- **Indexer health:** [https://indexer-production-570f.up.railway.app/health](https://indexer-production-570f.up.railway.app/health)
- **Base indexer health:** [https://indexer-base-production.up.railway.app/health](https://indexer-base-production.up.railway.app/health)
- **Repository:** [https://github.com/bidaiAI/autonomous-314-launch-protocol](https://github.com/bidaiAI/autonomous-314-launch-protocol)
- **Official X:** [https://x.com/auto314cc](https://x.com/auto314cc)
- **Official Telegram channel:** [https://t.me/Autonomous314](https://t.me/Autonomous314)
- **Official alerts channel:** [https://t.me/auto314_Alert](https://t.me/auto314_Alert)

## Official BSC runtime profile

- **Chain:** BNB Smart Chain
- **Chain ID:** `56`
- **Native asset:** `BNB`
- **Wrapped native asset:** `WBNB`
- **Canonical DEX:** PancakeSwap V2
- **Router:** `0x10ED43C718714eb63d5aA57B78B54704E256024E`
- **Launch families:** `0314 / b314 / 1314..9314 / f314`
- **Create fee (standard / taxed):** `0.01 BNB`
- **Create fee (whitelist / f314):** `0.03 BNB`
- **Graduation target:** `12 BNB`
- **LP token reserve:** `20%`
- **Pre-grad fee split:** `1% total = 0.7% creator + 0.3% protocol`
- **Protocol treasury fallback:** `0xC4187bE6b362DF625696d4a9ec5E6FA461CC0314`

## Base runtime profile

This is the Base-specific runtime profile for a **separate single-chain deployment**.
It uses the same protocol families and integration surface, but with Base-native values.

- **Chain:** Base
- **Chain ID:** `8453`
- **Native asset:** `ETH`
- **Wrapped native asset:** `WETH`
- **Canonical DEX:** QuickSwap V2
- **Router:** `0x4a012af2b05616Fb390ED32452641C3F04633bb5`
- **Launch families:** `0314 / b314 / 1314..9314 / f314`
- **Create fee (standard / taxed):** `0.005 ETH`
- **Create fee (whitelist / f314):** `0.01 ETH`
- **Graduation target:** `4 ETH`
- **Whitelist thresholds:** `1 / 2 / 3 ETH`
- **Whitelist seat sizes:** `0.04 / 0.1 / 0.2 / 0.5 ETH`
- **Whitelist max seats:** `80`
- **Protocol treasury fallback:** `0xC4187bE6b362DF625696d4a9ec5E6FA461CC0314`

## Official Base factory

- **Factory:** `0x6fDE83bB814AC79D1267695d532e2Dd9d16A0314`
- **Factory deployment tx:** `0x66f47b312f40ccff7c22f52bffc0b4610c0c091e42d5ea3409a3e4926b2f6814`
- **Factory deployment block:** `44505311`
- **Deployment salt:** `0x910c5bb21b8b4100fd60a57155745d3aefb496aa859fc088f8136be56ca8ef31`

## Official Base support deployers

| Contract | Address | Deployment tx | Block |
|---|---|---|---|
| LaunchTokenDeployer | `0xc6611f07a35222095A78Be7fa6e5f5E3B9585e83` | `0x971a8396501b0687b3cc3090c8e413fcc9df5fd0a57ff8d0355d27b2022863d4` | `44504892` |
| LaunchTokenWhitelistDeployer | `0x502C1605B17E2c0B67Dd4C855E095989945aB3cc` | `0x34972b27827172cef5e3058da9f69a7f596f281412f6e18d4a87f95760e3c20f` | `44505296` |
| LaunchTokenTaxedDeployer | `0xA45921Dc733188c8C68D017984224E0EC125b095` | `0xb6086624c3eaf66d3011caa02f30c3319c093fd2b932251e84aec202bb27f3e2` | `44505302` |
| LaunchCreate2Deployer | `0xf0Ef9342fB2866580F4d428E6FF00E5394E15182` | `0xaf3eb01d437c08bea997c039492e1bb51e2c546988e2e02c7f16986526075920` | `44505306` |

### Base Create2 bind

- **Whitelist-taxed deployer bind tx:** `0xe51199a3da00cbd95c019c88f201ad390644f12393d4705bb3b2d4a3cdcc4341`
- **Whitelist-taxed deployer bind block:** `44505314`

## Official factory

- **Factory:** `0xa5d62930AA7CDD332B6bF1A32dB0cC7095FC0314`
- **Factory deployment tx:** `0xf77b68c21d31c51f0dbbffb5756f233c9a6718d49f549c262220d92a875afc06`
- **Factory deployment block:** `91258253`
- **Deployment salt:** `0xdda123f499c5f7f6d817abb3686e99857361bf6990923787dd4d8c5aef555afd`

## Official support deployers

| Contract | Address | Deployment tx |
|---|---|---|
| LaunchTokenDeployer | `0x8FcAf0Fe7e49245d3f28f04e7b91978aBdD38A71` | `0xe7bf7a28e85e222a5387ef4ae520262217ff65be75d023fa8534c497f4119d36` |
| LaunchTokenWhitelistDeployer | `0x6E70b0eCcF42D2d8358daD89Fe37cfA1F8c8a9F2` | `0xcd77bf0e98327158f16c1645a9c2f0bc8b6c5589862ecc8344ef831723856140` |
| LaunchTokenTaxedDeployer | `0x9a5CD709C9B0a18bD7BD5C8a2f637cbE5087D1B9` | `0x29e4824246581158804daa1d86aaba675f04f1e497166eac9961872f394bdd82` |
| LaunchCreate2Deployer | `0xcDc3D935b2349CF282e5517a8126B0fA890631e5` | `0x18bc4724f5275a3fc4fd2e4c476c9e8c1d140b5a4d3eceffbdec8e8d5e024260` |

### Create2 bind

- **Whitelist-taxed deployer bind tx:** `0xa61eb496afb880fda09cb5f5915905cb72a912eb1f1dc78fd4c4908a460a4ab1`
- **Whitelist-taxed deployer bind block:** `91258260`

## Curve profile

The official `12 BNB` profile uses:

- **virtualTokenReserve:** `107,036,752`
- **virtualQuoteReserve:** `4.60555128 BNB`

## Indexer / verification

- **Production indexer factory:** `0xa5d62930AA7CDD332B6bF1A32dB0cC7095FC0314`
- **Production indexer from block:** `91258253`
- **Official bootstrap targets:** factory + 4 support deployers above
- **Verification flow:** production indexer bootstraps official verification and auto-submits new launches to Sourcify and an Etherscan-compatible explorer

As of **2026-04-08**, the official factory and all four support deployers are verified via:

- **Sourcify**
- **BscScan / Etherscan-compatible explorer**

Base uses the same indexer/verification model, with its own bootstrap target set tracked separately in [`./BASE_PROFILE.md`](./BASE_PROFILE.md) and the dedicated Base indexer deployment.

## Notes for integrators

- Use this page for the **current official deployment values**
- Use [`./INTEGRATION.md`](./INTEGRATION.md) for the **contract/API integration surface**
- Use [`./BASE_PROFILE.md`](./BASE_PROFILE.md) for the **Base chain deployment profile**
- Use [`./LAUNCH_METADATA.md`](./LAUNCH_METADATA.md) for the **metadata and social-link schema**
