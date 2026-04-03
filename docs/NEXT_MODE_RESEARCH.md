# Next mode research: Pure314, WL314, and taxed suffix profiles

This note captures the **next-step design direction** being evaluated for Autonomous 314. It is intentionally separate from the current implementation docs so that planned behavior is not confused with what is already live onchain.

## 1. Guiding principle

The protocol should remain:

- **creator-first**
- **open-source and forkable**
- **cheap to operate**
- **not dependent on a hosted swap**
- **usable as a protocol kit, not only as one platform**

The strongest positioning is:

> anyone should be able to stand up a meme launch frontend around this protocol in minutes, because the launch contract itself provides the pre-grad market and graduation path.

## 2. Restore the 314 essence

The pure 314 experience should keep the classic property:

- sending native currency directly to the launch contract should execute a buy

That means the long-term protocol direction should **not** permanently disable `receive()`.

### Implication

If `receive()` is restored:

- every buy-path restriction must apply to **both** `buy(...)` and `receive()`
- whitelist checks cannot live only in explicit function calls
- anti-bot rules must treat raw transfer buys and explicit buys consistently

## 3. Mode taxonomy and vanity suffix policy

The proposed mode identity is:

- **`0314`** — standard launch, no post-grad tax
- **`1314`** — taxed launch, 1% post-grad pair tax
- **`5314`** — taxed launch, 5% post-grad pair tax
- **`9314`** — taxed launch, 9% post-grad pair tax
- **`b314`** — whitelist launch

This is a **mode taxonomy**, not just vanity for vanity’s sake. The suffix should communicate launch behavior.

## 4. Standard mode (`0314`)

The clean baseline mode should remain the most neutral:

- no whitelist
- no post-grad token tax
- creator-first protocol fee split stays as-is during the bonding phase
- direct native transfer buy should be valid

This mode is the cleanest for auditors, integrators, and third-party frontends.

## 5. Whitelist mode (`b314`)

Whitelist mode is considered acceptable if it is explicitly bounded.

### Recommended rules

- whitelist affects **buy access only**
- whitelist is only active while:
  - the token is still in `Bonding314`
  - graduation progress is **below 60%**
- whitelist can be **permanently disabled**
- once disabled, it cannot be re-enabled
- once the launch reaches 60%, whitelist becomes irrelevant automatically

### Why this is still “clean enough”

Whitelist logic adds governance flavor, so it should not be forced into the standard mode.

The best protocol posture is:

- `0314` = clean default
- `b314` = explicitly gated early-access mode

### Implementation note

If whitelist mode exists and `receive()` is supported, whitelist enforcement must happen in a shared internal gate used by:

- `buy(...)`
- `receive()`

### Merkle root vs mapping

`whitelistRoot` is not automatically a backdoor. The real trust question is:

- who can update it
- how many times it can change
- whether it can be turned back on after being disabled

Using a Merkle root is still the better protocol-style approach than storing a large mutable address mapping onchain.

## 6. Taxed modes (`1314`, `5314`, `9314`)

Taxed modes should not distort the bonding phase.

### Recommended rule

Tax only becomes active in **`DEXOnly`**.

That means:

- **pre-grad:** no token tax
- **post-grad:** token tax applies only to pair interactions

### Transfer policy

For taxed modes:

- pair buy/sell can be taxed
- wallet-to-wallet transfers should remain untaxed

This keeps the token usable while still supporting the post-grad tokenomics users expect from taxed meme tokens.

### Why not tax pre-grad

Pre-grad already has:

- protocol fee accounting
- graduation reserve logic
- single-market constraints
- anti-bot timing rules

Adding token tax on top of the bonding phase would make pricing, fee reasoning, and graduation behavior substantially more complex.

## 7. Should this mean multiple factories?

The current recommendation is:

- **one canonical factory**
- **multiple launch modes / implementations**

Not:

- one factory for standard
- another factory for taxed

### Why

A single factory keeps:

- discovery cleaner
- integration simpler
- official identity clearer
- protocol adoption easier

The factory can expose a mode choice while still producing deterministic, mode-aware launch contracts.

## 8. Recommended implementation layering

Do **not** keep piling everything into one ever-larger launch contract.

Instead, move toward:

- `LaunchTokenStandard`
- `LaunchTokenWhitelist`
- `LaunchTokenTaxed`
- optional combined mode later if truly needed

All should share the same broad lifecycle model, but keep the riskier optional features isolated.

## 9. Why this helps the “protocol, not platform” goal

This direction makes the repo more like a launch protocol kit:

- one factory
- one reference frontend
- one lightweight indexer
- multiple launch modes

That means third parties can stand up their own meme launch sites without:

- building a swap first
- inventing a bonding system first
- inventing a graduation flow first

## 10. Current status

As of this note:

- these suffix-to-mode rules are **design decisions under active evaluation**
- they are **not yet fully implemented in the deployed contracts**
- docs for the live protocol should still describe the current deployed behavior, not this future mode split
