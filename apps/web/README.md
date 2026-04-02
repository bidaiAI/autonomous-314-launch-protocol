# Reference Web App

Reference frontend for the Autonomous 314 Launch Protocol.

## Purpose

This app is **not** the protocol itself. It is the official reference UI for:

- launch list / status board
- launch detail workspace
- buy / sell panel with `minOut`
- graduation progress
- post-graduation canonical DEX handoff
- segmented candle chart driven by indexed protocol + DEX events

## Runtime model

- **live trading-critical state** is read from chain
- **history / activity / chart** is read from the optional indexer API
- the displayed graduation target comes from the deployed factory/token configuration
- local/dev environments may use a lower immutable target such as `0.2 native`

## Profiles

The frontend supports multiple chain profiles, while the current official deployment profile is:

- BSC
- PancakeSwap V2
- WBNB / BNB
- 12 BNB graduation target
