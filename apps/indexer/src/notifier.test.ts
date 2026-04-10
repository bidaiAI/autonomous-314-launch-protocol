import test from "node:test";
import assert from "node:assert/strict";
import {
  detectEventsForTest,
  formatTelegramNotificationForTest,
  formatXNotificationForTest,
  launchMarketCapUsdForTest
} from "./notifier";
import type { LaunchWorkspaceSnapshot } from "./schema";

function makeLaunch(overrides: Partial<LaunchWorkspaceSnapshot> = {}): LaunchWorkspaceSnapshot {
  return {
    token: "0x0000000000000000000000000000000000000314",
    creator: "0x000000000000000000000000000000000000c0de",
    name: "Autonomous Test",
    symbol: "AUTO",
    totalSupply: (1_000_000_000n * 10n ** 18n).toString(),
    mode: 1,
    modeLabel: "Standard0314",
    suffix: "0314",
    metadataURI: "https://example.com/meta.json",
    state: "Bonding314",
    pair: "0x0000000000000000000000000000000000000000",
    graduationQuoteReserve: "12000000000000000000",
    currentPriceQuotePerToken: "100000000000000",
    graduationProgressBps: 5000,
    remainingQuoteCapacity: "6000000000000000000",
    pairPreloadedQuote: "0",
    pairClean: true,
    pairGraduationCompatible: true,
    protocolFeeAccrued: "0",
    creatorFeeAccrued: "0",
    protocolClaimable: "0",
    creatorClaimable: "0",
    whitelistStatus: "0",
    whitelistSnapshot: null,
    taxConfig: null,
    dexTokenReserve: "0",
    dexQuoteReserve: "0",
    recentActivity: [],
    segmentedChart: {
      bondingCandles: [],
      dexCandles: [],
      graduationTimestampMs: null
    },
    ...overrides
  };
}

test("launchMarketCapUsd calculates the quoted USD market cap", () => {
  const launch = makeLaunch({
    currentPriceQuotePerToken: "100000000000000"
  });

  assert.ok(Math.abs((launchMarketCapUsdForTest(launch, 600) ?? 0) - 60_000_000) < 0.1);
});

test("detectEvents emits threshold crossing and graduation only after baseline", async () => {
  const tracked = new Map();
  const base = makeLaunch({
    currentPriceQuotePerToken: "100000000000"
  });
  assert.equal((await detectEventsForTest(tracked, [base], 600, async () => ({
    image: null,
    website: null,
    twitter: null,
    telegram: null,
    discord: null
  }), false)).length, 0);

  const crossed = makeLaunch({
    currentPriceQuotePerToken: "200000000000",
    recentActivity: [
      {
        kind: "graduated",
        token: base.token,
        marketAddress: "0x0000000000000000000000000000000000000dex",
        txHash: "0x0000000000000000000000000000000000000000000000000000000000000314",
        blockNumber: 1n,
        logIndex: 0,
        timestampMs: 1,
        source: "system",
        phase: "migrating",
        quoteAmountContributed: "1",
        preloadedQuoteAmount: "0",
        tokenAmount: "1",
        liquidityBurned: "1"
      }
    ],
    state: "DEXOnly",
    pair: "0x0000000000000000000000000000000000000dex"
  });

  const events = await detectEventsForTest(tracked, [crossed], 600);
  assert.ok(events.some((event) => event.kind === "marketCap" && event.thresholdUsd === 100_000));
  assert.ok(events.some((event) => event.kind === "graduated"));
});

test("notification formatters include app links and stay concise for X", async () => {
  const launch = makeLaunch({
    state: "DEXOnly",
    pair: "0x0000000000000000000000000000000000000dex",
    recentActivity: [
      {
        kind: "graduated",
        token: "0x0000000000000000000000000000000000000314",
        marketAddress: "0x0000000000000000000000000000000000000dex",
        txHash: "0x0000000000000000000000000000000000000000000000000000000000000314",
        blockNumber: 1n,
        logIndex: 0,
        timestampMs: 1,
        source: "system",
        phase: "migrating",
        quoteAmountContributed: "1",
        preloadedQuoteAmount: "0",
        tokenAmount: "1",
        liquidityBurned: "1"
      }
    ]
  });
  const tracked = new Map<string, any>();
  await detectEventsForTest(tracked, [makeLaunch()], 600);
  const events = await detectEventsForTest(tracked, [launch], 600);
  const [event] = events.filter((entry) => entry.kind === "graduated");
  const xText = formatXNotificationForTest(event!);
  const telegramText = formatTelegramNotificationForTest(event!);

  assert.ok(xText.includes("https://auto314.cc/c/56/launch/"));
  assert.ok(xText.includes("[BSC]"));
  assert.ok(telegramText.includes("Chain: BNB Smart Chain"));
  assert.ok(telegramText.includes("Contract: 0x0000000000000000000000000000000000000314"));
  assert.ok(xText.length < 280);
});

test("created notification shows whitelist fields with human-readable values", async () => {
  const tracked = new Map<string, any>();
  await detectEventsForTest(tracked, [makeLaunch()], 600);

  const [created] = await detectEventsForTest(
    tracked,
    [makeLaunch({
      token: "0x0000000000000000000000000000000000001314",
      modeLabel: "WhitelistB314",
      state: "WhitelistCommit",
      whitelistStatus: "1",
      whitelistSnapshot: {
        status: "1",
        opensAt: "1775580000",
        deadline: "1775666400",
        threshold: "4000000000000000000",
        slotSize: "1000000000000000000",
        seatCount: "4",
        seatsFilled: "1",
        committedTotal: "1000000000000000000",
        tokensPerSeat: "0"
      }
    })],
    600
  );

  assert.equal(created?.kind, "created");
  const telegramText = formatTelegramNotificationForTest(created!);
  const xText = formatXNotificationForTest(created!);
  assert.ok(telegramText.includes("Mode: WhitelistB314"));
  assert.ok(telegramText.includes("Chain: BNB Smart Chain"));
  assert.ok(telegramText.includes("Seats: 4"));
  assert.ok(telegramText.includes("Slot size: 1 BNB"));
  assert.ok(telegramText.includes("Threshold: 4 BNB"));
  assert.ok(xText.includes("[BSC]"));
});
