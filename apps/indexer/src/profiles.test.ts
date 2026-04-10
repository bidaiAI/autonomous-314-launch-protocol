import test from "node:test";
import assert from "node:assert/strict";
import { resolveIndexerProfile } from "./profiles";

test("resolveIndexerProfile exposes the Base chain profile", () => {
  const profile = resolveIndexerProfile(8453);

  assert.equal(profile.chainId, 8453);
  assert.equal(profile.chainLabel, "Base");
  assert.equal(profile.nativeSymbol, "ETH");
  assert.equal(profile.wrappedNativeSymbol, "WETH");
  assert.equal(profile.dexName, "QuickSwap V2");
  assert.equal(profile.defaultRpcUrl, "https://mainnet.base.org");
  assert.equal(profile.explorerApiUrl, "https://api.basescan.org/api");
  assert.match(profile.nativeUsdPriceApiUrl, /ids=ethereum&vs_currencies=usd/);
});

test("resolveIndexerProfile keeps BNB Chain as the default fallback", () => {
  const profile = resolveIndexerProfile(999999);

  assert.equal(profile.chainId, 56);
  assert.equal(profile.chainLabel, "BNB Smart Chain");
});
