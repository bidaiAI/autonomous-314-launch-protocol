# Curve Profile

This note records the bonding-curve profile now used by the repository so the contracts, frontend estimates, and deployment docs all describe the same shape.

## Source-of-truth rationale

The current target is:

- keep the repo's official BSC graduation target at `12 BNB`
- keep the repo's fixed token split of:
  - total supply `1,000,000,000`
  - sale reserve `800,000,000`
  - LP reserve `200,000,000`
- align the token-side curve shape to the latest **official Flap BNB curve**

Official references consulted:

- Flap bonding curve: <https://docs.flap.sh/flap/developers/basic-and-mechanism/bonding-curve>
- Flap DEX migration: <https://docs.flap.sh/flap/developers/basic-and-mechanism/list-on-dex>
- Pump fees: <https://pump.fun/docs/fees>
- Pump mayhem mode disclaimer: <https://pump.fun/docs/mayhem-mode-disclaimer>

Pump's official docs confirm the standard `1,000,000,000` token profile, but they do **not** publicly document the exact bonding-curve equation. Because of that, the concrete curve formula in this repo is aligned to the official Flap documentation and then scaled to the repo's `12 BNB` graduation profile.

## Implemented curve

The contracts price against **effective reserves**:

- `effectiveQuoteReserve = curveQuoteReserve + virtualQuoteReserve`
- `effectiveTokenReserve = saleTokenReserve + lpTokenReserve + virtualTokenReserve`

The current implementation uses:

- `virtualTokenReserve = 107,036,752`
- `virtualQuoteReserve = graduationQuoteReserve * (LP_TOKEN_RESERVE + virtualTokenReserve) / SALE_TOKEN_RESERVE`

For the official BSC `12 BNB` profile, that means:

- `virtualQuoteReserve = 4.60555128 BNB`
- `virtualTokenReserve = 107,036,752 tokens`

In continuous form, the official `12 BNB` profile is:

- `(x + 107,036,752) * (y + 4.60555128) = 5,098,514,530.18064256`

Where:

- `x` = remaining sale-side token inventory
- `y` = quote already accumulated in the bonding reserve

At the graduation boundary:

- `x = 200,000,000`
- `y = 12`

So the bonding phase cleanly hands off to a DEX pair seeded with:

- `200,000,000` tokens
- `12 BNB`

## Why this is a scale, not a literal copy

The official Flap BNB curve uses the same token-side virtual reserve `107,036,752`, but its quote-side threshold is higher than this repo's official `12 BNB` graduation target.

This repo intentionally keeps `12 BNB` as the official BSC production threshold, so only the **quote-side scale** is adjusted. That preserves:

- the repo's existing graduation target
- the repo's 80% sale / 20% LP token split
- the Flap-aligned token-side curve shape

## Verification coverage

The repo now verifies all of the following in tests:

- the `1 -> 11 BNB` dynamic buy path
- the reverse `11 -> 1 BNB` sell-back path
- buy/sell symmetry under the implemented invariant math
- the `12th` net-`1 BNB` step triggering graduation exactly

See:

- `packages/contracts/test/LaunchTokenCurveProfile.test.ts`

## Deployment consequence

Because this changes launch-token bytecode and pricing constants, the official BSC factory/support deployers must be redeployed before public use.

There are currently **no launched tokens** on the existing pre-launch factory profile, so the previous factory can be replaced outright instead of being preserved as a live canonical deployment.
