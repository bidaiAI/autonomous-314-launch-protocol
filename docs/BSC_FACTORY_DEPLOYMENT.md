# BSC Factory Deployment

This document describes the official BSC deployment path for the open protocol factory.

## Official BSC production profile

- chain: **BSC Mainnet**
- router: `0x10ED43C718714eb63d5aA57B78B54704E256024E`
- protocol fee recipient fallback: `0xC4187bE6b362DF625696d4a9ec5E6FA461CC0314`
- create fee: `0.03 BNB`
- graduation target: `12 BNB`
- desired factory suffix: `0314`

## Official CREATE2 deployment target

- CREATE2 deployer: `0x4e59b44847b379578588920cA78FbF26c0B4956C`
- salt: `0x58dc751d9dc996e4ef6912e2ea0100e65c3c3c811a17deb11f0dc86deaeb3945`
- expected factory address: `0xEFd05ee43A21cc109604050724cEd52ebA200314`

## Environment

Copy:

- `packages/contracts/.env.example`

Fill at least:

- `BSC_RPC_URL`
- `DEPLOYER_PRIVATE_KEY`

## Dry run

Use this first:

```bash
pnpm deploy:bsc:factory:dry
```

This prints:

- predicted factory address
- CREATE2 deployer
- configured owner / treasury / router
- resolved router factory and wrapped native addresses

No transaction is broadcast when `BSC_DEPLOY_DRY_RUN=1`.

## Mainnet deployment

When the dry run output is correct:

```bash
pnpm deploy:bsc:factory
```

The deployment script will:

1. build the `LaunchFactory` init code
2. recompute the expected CREATE2 address
3. verify the CREATE2 deployer exists on-chain
4. verify the target address is still empty
5. broadcast the deployment transaction
6. verify the deployed factory configuration on-chain

## Post-deploy checks

Immediately verify:

- `factory address == 0xEFd05ee43A21cc109604050724cEd52ebA200314`
- `protocolFeeRecipient() == 0xC4187bE6b362DF625696d4a9ec5E6FA461CC0314`
- `createFee() == 0.03 BNB`
- `graduationQuoteReserve() == 12 BNB`
- `router()` equals the official BSC router
- `owner()` equals the configured owner

Then do one smoke launch before public announcement.
