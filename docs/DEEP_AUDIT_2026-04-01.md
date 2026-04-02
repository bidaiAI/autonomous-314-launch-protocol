# Deep Audit Report — 2026-04-01

## Executive summary

This audit reviewed the current open-source protocol implementation in:

- `/Users/bidao/Projects/314新协议/packages/contracts/contracts/LaunchToken.sol`
- `/Users/bidao/Projects/314新协议/packages/contracts/contracts/LaunchFactory.sol`
- supporting frontend/indexer integration surfaces

The codebase is **materially stronger than a typical old-style 314 implementation**:

- pre-grad transfer lock exists
- graduation is atomic
- post-grad 314 is permanently disabled
- reserve accounting is separated from incidental native balance
- key state-changing fee flows are `nonReentrant`
- abandoned creator fees have bounded terminal handling

I did **not** find a direct critical outsider fund-drain or trivial auth-bypass path in the current code.

However, I do **not** recommend deploying to mainnet without first addressing a short list of correctness and integration issues.

## Severity summary

- **High:** 1
- **Medium:** 5
- **Low:** 3

## Must-fix before BSC mainnet

1. **High** — Quote-side preload can rewrite the canonical post-grad DEX opening state  
2. **Medium** — Bonding preview/getter APIs remain callable and misleading after `DEXOnly`  
3. **Medium** — Raw native-transfer buy path remains live without slippage protection  
4. **Medium** — Factory fee-recipient rotation can redirect already-accrued create fees  

## Can likely defer until after first rollout

5. **Medium** — Claim flows can lock fees if recipients cannot receive native currency  
6. **Medium** — Default `createLaunch()` address prediction is race-sensitive under concurrency  
7. **Medium** — Bounded indexer can hide real launches and lose graduation context outside its lookback window  
8. **Low** — `LaunchToken` constructor still allows some bad direct-deploy configurations  
9. **Low** — Factory remains governance-mutable for future launches

---

## H-1 — Quote-side preload can change the real DEX opening state

**Severity:** High

**Files / lines**

- `/Users/bidao/Projects/314新协议/packages/contracts/contracts/LaunchToken.sol:495-522`
- `/Users/bidao/Projects/314新协议/packages/contracts/contracts/LaunchToken.sol:548-563`

### Finding

Graduation currently allows quote-side wrapped-native preload in the canonical pair as long as:

- `pair.totalSupply() == 0`
- token-side balance is still clean
- token-side reserves are still zero

That preserves liveness, but it also means the real post-grad pair opens with:

- `protocol quote contribution + preloaded quote`

instead of the canonical quoted target alone.

### Impact

This does **not** look like an immediate drain bug, but it **does** break the clean economic promise that “12 BNB graduation” uniquely defines the initial DEX state.

Consequences:

- the true DEX opening price can be externally shifted
- post-grad charts and scanners can see a manipulated opening state
- a participant who accumulated pre-grad inventory can donate quote and create a more favorable post-grad dump environment
- the official UI and docs can say “graduation target reached” while the actual pair opens with a different quote base

### Recommendation

Choose one of these explicitly:

1. **Strict canonical handoff**
   - require quote-side preload to also be zero
   - revert graduation if quote-side preload exceeds zero
   - downside: reintroduces a DoS surface

2. **Donation-compatible with explicit bound**
   - allow only dust / small tolerance
   - revert above threshold
   - expose a `canonical` vs `nonCanonical` graduation marker in API/UI/events

If mainnet launch is near, the best compromise is:

- **set a preload cap**
- **surface preload amount in UI/indexer**
- **treat above-threshold preload as non-canonical or revert**

---

## M-1 — Bonding preview/getter APIs remain misleading after `DEXOnly`

**Severity:** Medium

**Files / lines**

- `/Users/bidao/Projects/314新协议/packages/contracts/contracts/LaunchToken.sol:244-305`
- `/Users/bidao/Projects/314新协议/packages/contracts/contracts/LaunchToken.sol:307-312`
- `/Users/bidao/Projects/314新协议/apps/web/src/protocol.ts:341-449`
- `/Users/bidao/Projects/314新协议/apps/web/src/protocol.ts:475-503`

### Finding

The protocol already has phase-aware getters such as:

- `currentPriceQuotePerToken()`
- `displayGraduationProgressBps()`
- `dexReserves()`

But several older/bonding-oriented views remain callable regardless of state:

- `previewBuy(...)`
- `previewSell(...)`
- `priceQuotePerToken()`
- `graduationProgressBps()`

After `DEXOnly`, these can still return bonding-style math even though `buy()` / `sell()` revert.

### Impact

- frontends, wallets, or bots can show phantom executable quotes
- post-grad integrations can build incorrect UX around stale bonding math
- third-party adopters can accidentally route users toward non-actionable previews

### Recommendation

Make these APIs explicitly phase-aware:

- either **revert outside `Bonding314`**
- or **return zero/non-actionable values outside `Bonding314`**

At minimum:

- rename/document them as bonding-only helpers
- keep post-grad consumers on `currentPriceQuotePerToken()` and `dexReserves()`

---

## M-2 — Raw native-transfer buy path has no slippage protection

**Severity:** Medium

**Files / lines**

- `/Users/bidao/Projects/314新协议/packages/contracts/contracts/LaunchToken.sol:148-159`
- `/Users/bidao/Projects/314新协议/packages/contracts/contracts/LaunchToken.sol:408-455`

### Finding

`receive()` routes raw native transfers into `_buy(msg.sender, 0)`.

That means direct native-transfer buys have:

- no `minOut`
- no deadline
- no explicit protection against public-mempool price movement

### Impact

- users who or third-party frontends that use raw transfer buys can be front-run into materially worse execution
- risk is worse near the graduation boundary because price moves become larger and partial-fill behavior matters more

### Recommendation

For the official BSC deployment, strongly consider one of:

1. **Disable raw-transfer buys entirely**
2. keep them but behind an explicit profile flag
3. keep them only as a documented advanced/manual path and ensure official integrations never default to them

---

## M-3 — Factory fee-recipient rotation can redirect already-accrued create fees

**Severity:** Medium

**Files / lines**

- `/Users/bidao/Projects/314新协议/packages/contracts/contracts/LaunchFactory.sol:16-18`
- `/Users/bidao/Projects/314新协议/packages/contracts/contracts/LaunchFactory.sol:124-151`

### Finding

`accruedProtocolCreateFees` is a pooled balance, but claim authorization is tied to the **current** `protocolFeeRecipient`.

If the owner rotates `protocolFeeRecipient` before the old balance is claimed, the new recipient can claim historical fees accrued for the previous recipient.

### Impact

- historical create-fee entitlement is not stable
- operational accounting is ambiguous
- owner-driven recipient rotation can effectively redirect previously accrued fee balances

### Recommendation

Safer patterns:

- disallow recipient rotation while `accruedProtocolCreateFees > 0`
- auto-claim / auto-settle old balance before rotating recipient
- bucket balances per recipient
- or make the protocol create-fee recipient immutable in the official deployment

---

## M-4 — Fee claims can become permanently stuck for non-payable recipients

**Severity:** Medium

**Files / lines**

- `/Users/bidao/Projects/314新协议/packages/contracts/contracts/LaunchToken.sol:208-229`
- `/Users/bidao/Projects/314新协议/packages/contracts/contracts/LaunchFactory.sol:124-132`

### Finding

Claims use raw native transfers via `sendValue()`:

- protocol fee claims in `LaunchToken`
- creator fee claims in `LaunchToken`
- protocol create-fee claims in `LaunchFactory`

If an authorized recipient is a contract that rejects plain native currency, claims revert forever.

### Impact

- creator fees can be trapped
- protocol fees can be trapped
- create-fee revenue can be trapped

### Recommendation

Add one of:

- `claimTo(address payable recipient)`
- wrapped-native payout option
- redirectable withdrawal destination

For the official deployment, if you keep current behavior, document that:

- creator should ideally be an EOA or a payable treasury contract
- protocol treasury must accept plain native transfers

---

## M-5 — `createLaunch()` default address prediction is race-sensitive

**Severity:** Medium

**Files / lines**

- `/Users/bidao/Projects/314新协议/packages/contracts/contracts/LaunchFactory.sol:58-65`
- `/Users/bidao/Projects/314新协议/packages/contracts/contracts/LaunchFactory.sol:76-88`

### Finding

The default `createLaunch()` salt depends on:

- `msg.sender`
- `allLaunches.length`
- `block.chainid`

Because `allLaunches.length` is global mutable state, concurrent launch creation changes the derived address.

### Impact

- third-party integrations cannot safely pre-announce or pre-bind metadata to addresses using the default path
- “predicted” addresses are only reliable for the explicit salted flow

### Recommendation

- treat `createLaunch()` as **not address-stable under concurrency**
- recommend `createLaunchWithSalt()` for any workflow that requires prediction
- optionally expose a dedicated creator nonce if you want deterministic prediction without explicit salts

---

## M-6 — Bounded indexer can hide valid launches and lose handoff context

**Severity:** Medium

**Files / lines**

- `/Users/bidao/Projects/314新协议/apps/indexer/src/service.ts:24-133`
- `/Users/bidao/Projects/314新协议/apps/indexer/src/server.ts:58-166`

### Finding

The reference indexer is intentionally bounded by:

- lookback window
- launch limit

This is cost-efficient, but token-specific API consumers can still lose context if:

- the launch is outside the current bounded snapshot
- or the `Graduated` event is older than the lookback window

### Impact

- `/launches/:token` may 404 for a real launch that still exists on-chain
- segmented charts may show post-grad DEX swaps without an observed graduation marker
- downstream consumers can infer false continuity or missing history

### Recommendation

- hydrate token-specific endpoints on demand from chain if absent from bounded snapshot
- or return a structured “outside window / not indexed” response instead of 404
- if `state === DEXOnly` but graduation event is not observed in lookback, surface `graduationObserved=false`

This is **not** a protocol-core blocker, but it matters for production UX.

---

## L-1 — `LaunchToken` direct deployment can still produce bad role configuration

**Severity:** Low

**Files / lines**

- `/Users/bidao/Projects/314新协议/packages/contracts/contracts/LaunchToken.sol:113-146`

### Finding

The constructor validates `graduationQuoteReserve_`, but does not explicitly validate:

- `creator_ != address(0)`
- `protocolFeeRecipient_ != address(0)`

The official `LaunchFactory` path mostly protects against this, but the repo is now positioned as an open protocol and users may try to deploy `LaunchToken` directly.

### Impact

- creator fees may become unclaimable
- protocol fees may become unclaimable
- broken launch instances can exist on-chain unnecessarily

### Recommendation

Either:

- add nonzero checks in the constructor
- or document that direct deployment is unsupported and only factory deployment is valid

---

## L-2 — Factory remains governance-mutable for future launches

**Severity:** Low

**Files / lines**

- `/Users/bidao/Projects/314新协议/packages/contracts/contracts/LaunchFactory.sol:143-151`

### Finding

The factory owner can still change:

- `protocolFeeRecipient`
- `createFee`

This does not affect existing `LaunchToken` immutable parameters, but it **does** affect future launches under the official factory.

### Impact

- official deployment trust remains governance-sensitive
- creators must trust that future fee parameters are not silently changed

### Recommendation

For the official BSC rollout, consider one of:

- freeze owner privileges after deployment
- move ownership to a multisig / timelock
- publish a “new factory per major profile change” policy

---

## Positive findings

The audit also found several strong design choices:

1. **State machine is narrow and one-way**
   - `Bonding314 -> Migrating -> DEXOnly`
2. **Critical public state-changing paths are guarded**
   - buy
   - sell
   - claim
   - sweep
3. **Post-grad 314 shutdown is hard, not soft**
4. **Reserve accounting is separated from incidental native balance**
5. **Creator fee sweep conditions are conservative**
   - `180 days` age
   - `30 days` inactivity

---

## Deploy recommendation

### Recommended before BSC mainnet

- Fix or constrain **H-1**
- Make preview/getter semantics phase-safe (**M-1**)
- Decide official policy for raw native-transfer buys (**M-2**)
- Stabilize create-fee recipient entitlement on rotation (**M-3**)

### Probably acceptable to defer

- claim redirection / wrapped-native payout option (**M-4**)
- address-prediction race-sensitivity documentation (**M-5**)
- bounded indexer fallback behavior (**M-6**)
- constructor nonzero hardening (**L-1**)
- official governance freeze/timelock policy (**L-2**)

---

## Bottom line

This codebase is **not** in the shape of an obviously broken or trivially drainable launch protocol.  
But it is **not yet in the shape of a “ship to mainnet with no reservations” protocol** either.

The main risks are:

- canonical handoff integrity
- stale/misleading post-grad interface semantics
- governance/accounting ambiguity in the factory

If those are tightened, the deployment posture becomes materially stronger."}}
