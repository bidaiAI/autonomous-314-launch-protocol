# Local Demo Guide

This repo supports a **local fast-graduation demo profile** so you can test the full launch flow without using a public testnet faucet.

## Profile

- chain: local Hardhat (`31337`)
- create fee: `0.03 native`
- graduation target: `0.2 native`

The official BSC production profile remains `12 BNB`, but local demo uses `0.2 native` to reach graduation quickly.

## One-command local stack

From the workspace root:

```bash
pnpm demo:local
```

This will:

1. start a local Hardhat node on `http://127.0.0.1:8545`
2. deploy local demo contracts
3. write local demo config to `.demo/local-demo.json`
4. write `.env.local` files for:
   - `apps/web/.env.local`
   - `apps/indexer/.env.local`
5. start the indexer API on `http://127.0.0.1:8787`
6. start the web app on `http://127.0.0.1:4173`

## Manual flow

If you prefer separate terminals:

### Terminal 1

```bash
pnpm demo:node
```

### Terminal 2

```bash
pnpm demo:prepare
```

### Terminal 3

```bash
INDEXER_RPC_URL=http://127.0.0.1:8545 \
INDEXER_CHAIN_ID=31337 \
INDEXER_FACTORY_ADDRESS=<factory-address> \
pnpm serve:indexer
```

### Terminal 4

```bash
VITE_RPC_URL=http://127.0.0.1:8545 \
VITE_CHAIN_ID=31337 \
VITE_FACTORY_ADDRESS=<factory-address> \
VITE_INDEXER_API_URL=http://127.0.0.1:8787 \
pnpm dev:web
```

## Demo notes

- connect your wallet to the local Hardhat network (`chainId 31337`)
- current trading state still reads directly from chain
- activity and segmented charts read from the indexer API when available
- post-graduation DEX activity is limited by the mock local pair implementation

## Output artifact

The deployment step writes:

- `.demo/local-demo.json`

This contains:

- factory address
- router address
- mock dex factory
- mock wrapped-native token
- protocol recipient
- create fee
- graduation target
