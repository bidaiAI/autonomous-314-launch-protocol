# Reference Indexer

Bounded-cost reference indexer for the Autonomous 314 Launch Protocol.

## Purpose

The indexer provides protocol-native history that an external DEX cannot provide before graduation:

- launch registry snapshots
- protocol trade history
- segmented OHLCV candles
- graduation state transitions
- post-graduation canonical V2 pair activity

## Cost model

This is intentionally designed as a **cheap protocol reference service**, not a heavy platform backend:

- bounded lookback
- bounded launch list
- bounded activity list per launch
- token-scoped API endpoints
- optional static snapshot output

## Current official profile

- BSC
- PancakeSwap V2
- WBNB / BNB

But the code is being kept generic for EVM chains with a wrapped-native V2-style DEX profile.
