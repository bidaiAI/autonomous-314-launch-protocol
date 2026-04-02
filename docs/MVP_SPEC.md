# MVP Specification (Frozen Baseline)

## Core product

- Protocol scope: EVM-compatible launch protocol with a wrapped-native quote asset and a canonical V2-style DEX handoff
- Official runtime profile: BSC + PancakeSwap V2
- Launch mode before graduation: protocol-native 314 bonding market
- Launch mode after graduation: canonical V2 DEX only
- LP: burned to dead address
- Deployment mode: factory-created launch contracts with optional `CREATE2` salt path for vanity suffix search

## Fixed economic parameters

- Total supply: `1,000,000,000`
- Sale reserve: `80%`
- LP reserve: `20%`
- Official BSC factory graduation target: `12 BNB`
- Local/dev/test graduation target may use a lower immutable deployment value (for example `0.2 native`) to speed up graduation testing
- Pre-graduation fee: `1%`
  - Protocol fee vault: `0.5%`
  - Creator fee vault: `0.5%`
- Creator fee claim: only after graduation
- Pre-graduation transfer policy: ordinary transfers disabled
- Pre-graduation sell cooldown: `1 block`
- Explicit buy path: `buy(minOut)` for self only
- Raw 314 path: direct native transfer to contract still routes to buy during `Bonding314`

## State machine

- `Created`
- `Bonding314`
- `Migrating`
- `DEXOnly`

## Security-sensitive rules

- `curveQuoteReserve` is the only quote reserve used for pricing and graduation checks
- contract total native balance must never be used directly as pricing state
- last buy must support partial fill so `curveQuoteReserve` cannot exceed the deployment's immutable graduation target
- post-graduation 314 must be permanently disabled
- strict fee vault separation from curve reserve
- graduation pair must be checked before migration
- pre-graduation trade recipients must not be used to bypass transfer locks
- preloaded wrapped-native quote in the graduation pair is treated as external donation and must not block graduation by itself
- only pair LP initialization or token-side pollution should block graduation

## MVP residual risks to track

- pair pollution / griefing around wrapped-native quote before migration
- exact graduation boundary rounding
- vault accounting invariants
- frontend/indexer must construct pre-graduation candles from protocol events
