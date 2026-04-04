# BSC Factory Deployment

This document describes the official BSC V2 deployment path for the open protocol factory.

## Official BSC production profile

- chain: **BSC Mainnet**
- official V2 factory: `0x09261904bf6f7Ce23dee2058379A49DF53B80314`
- router: `0x10ED43C718714eb63d5aA57B78B54704E256024E`
- protocol fee recipient fallback: `0xC4187bE6b362DF625696d4a9ec5E6FA461CC0314`
- standard/tax create fee: `0.01 BNB`
- whitelist/f314 create fee: `0.03 BNB`
- graduation target: `12 BNB`
- desired factory suffix: `0314`
- deployment block: `90349719`

## Official BSC V2 deployed addresses

- `LaunchTokenDeployer`: `0x502C1605B17E2c0B67Dd4C855E095989945aB3cc`
- `LaunchTokenWhitelistDeployer`: `0xA45921Dc733188c8C68D017984224E0EC125b095`
- `LaunchTokenTaxedDeployer`: `0xf0Ef9342fB2866580F4d428E6FF00E5394E15182`
- `LaunchCreate2Deployer` (`f314`): `0x8Cb985D86eAdF6D92d9204338583332e2A8313F0`

## Official BSC V2 deployment transactions

- `LaunchTokenDeployer`: `0xf3db0561d4127f74fdbda277bdd791c3368d67e3d948f5ac101b262b9779be1c`
- `LaunchTokenWhitelistDeployer`: `0x9cd44989e0c8d354b399484d8ac8b4f7ac4d171b5ffb53f3bde033cd5fb14b24`
- `LaunchTokenTaxedDeployer`: `0x422185e15681df7b4dad4219f226f47dea52f4bc9acc836b6adec3185fc78292`
- `LaunchCreate2Deployer` bind-capable deployer: `0xfba459d79375de614babf7718a6350da0d413834ce8c44a345ef9fd354102102`
- `LaunchFactory` CREATE2 deployment: `0x0d214b1511a7266106cc15d7a425fb8dd6fed15d2a400906530d05cb23953645`
- `LaunchCreate2Deployer.setFactory(...)`: `0xb8e852843553de0bbdb8f6ac8c632ab81d2ccb558848aa259e1362fd146e7518`

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
