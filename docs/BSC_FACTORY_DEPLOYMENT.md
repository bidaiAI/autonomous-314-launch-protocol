# BSC Factory Deployment

This document describes the official BSC V2 deployment path for the open protocol factory.

## Official BSC production profile

- chain: **BSC Mainnet**
- official final factory: `0x709FeC578E1745bd8185188606848c0b2dCf0314`
- router: `0x10ED43C718714eb63d5aA57B78B54704E256024E`
- protocol fee recipient fallback: `0xC4187bE6b362DF625696d4a9ec5E6FA461CC0314`
- standard/tax create fee: `0.01 BNB`
- whitelist/f314 create fee: `0.03 BNB`
- graduation target: `12 BNB`
- desired factory suffix: `0314`
- deployment tx: `0xa652222e5e92d501ce3c670cc6da968711a5fc1cf76c3d62aa0addabbb707c55`

## Official BSC final deployed addresses

- `LaunchTokenDeployer`: `0x78624Da9AD4D40712fE60e0C79c33dea9332a04b`
- `LaunchTokenWhitelistDeployer`: `0x9911BAd74700a0d0226477E3aD8DF014Eb77F015`
- `LaunchTokenTaxedDeployer`: `0x572b5B62AFFd3aA1aaC1EB81d1DB05B07EA8B87D`
- `LaunchCreate2Deployer` (`f314`): `0x7bfCD7FCACa202Bb14409C95d7E0d11F832e478B`

## Official BSC final deployment transactions

- `LaunchTokenDeployer`: `0xdce17e0d3dae5839d3def47078d3b6f296998ce4ec09768554276a3af36f384a`
- `LaunchTokenWhitelistDeployer`: `0x967fbe1ac90747c60a0261042d5ef893fc9b72848b521d3a719ff725af5349f7`
- `LaunchTokenTaxedDeployer`: `0x0e121927338345fe794ae8bfcb68245aea2e68745be907888938ad0e1e093915`
- `LaunchCreate2Deployer` bind-capable deployer: `0x9506177ccbfec43f885e5d94b52c1a82d21182dae5d2d5e71c7481f87c16e0d2`
- `LaunchFactory` CREATE2 deployment: `0xa652222e5e92d501ce3c670cc6da968711a5fc1cf76c3d62aa0addabbb707c55`
- `LaunchCreate2Deployer.setFactory(...)`: `0x6af61994ececaffb5e42c1dac3fbaa45a926f675c1e9227e222b5a9eece3d4b6`

## V2 deployment shape

The V2 factory constructor now depends on four support deployers:

- `LaunchTokenDeployer`
- `LaunchTokenWhitelistDeployer`
- `LaunchTokenTaxedDeployer`
- `LaunchCreate2Deployer` (used for `f314`)

The deployment script can either:

1. deploy fresh support deployers first, then mine a `0314` CREATE2 salt for the factory, or
2. reuse pre-deployed support deployers provided via env vars

Because support deployer addresses are constructor inputs, the final V2 factory address must be recomputed from the actual support deployer addresses.

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

- support deployer addresses (predicted in dry run, deployed in live mode)
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

1. resolve or deploy the four support deployers
2. build the V2 `LaunchFactory` init code
3. mine or validate a `0314` CREATE2 salt
4. verify the CREATE2 deployer exists on-chain
5. verify the target address is still empty
6. broadcast the factory deployment transaction
7. bind `LaunchCreate2Deployer.setFactory(factory)` for `f314`
8. verify the deployed factory configuration on-chain

## Post-deploy checks

Immediately verify:

- `protocolFeeRecipient() == 0xC4187bE6b362DF625696d4a9ec5E6FA461CC0314`
- `standardCreateFee() == 0.01 BNB`
- `whitelistCreateFee() == 0.03 BNB`
- `graduationQuoteReserve() == 12 BNB`
- `router()` equals the official BSC router
- `owner()` equals the configured owner
- support deployer addresses match the values printed by the deploy script

Then do one smoke launch before public announcement.
