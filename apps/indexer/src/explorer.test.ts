import test from "node:test";
import assert from "node:assert/strict";
import {
  explorerApiNeedsChainId,
  explorerUsesLegacyConstructorArgKey,
  resolveExplorerApiUrl,
  withExplorerBaseParams,
  withExplorerVerificationParams
} from "./explorer";

test("resolveExplorerApiUrl prefers BscScan for BNB Chain when both URLs are configured", () => {
  const apiUrl = resolveExplorerApiUrl({
    chainId: 56,
    bscScanApiUrl: "https://api.bscscan.com/api",
    etherscanApiUrl: "https://api.etherscan.io/v2/api"
  });

  assert.equal(apiUrl, "https://api.bscscan.com/api");
});

test("resolveExplorerApiUrl prefers Etherscan V2 when a multichain key is configured", () => {
  const apiUrl = resolveExplorerApiUrl({
    chainId: 56,
    bscScanApiUrl: "https://api.bscscan.com/api",
    etherscanApiUrl: "https://api.etherscan.io/v2/api",
    preferMultichainApi: true
  });

  assert.equal(apiUrl, "https://api.etherscan.io/v2/api");
});

test("resolveExplorerApiUrl prefers Etherscan for non-BNB chains", () => {
  const apiUrl = resolveExplorerApiUrl({
    chainId: 1,
    bscScanApiUrl: "https://api.bscscan.com/api",
    baseScanApiUrl: "https://api.basescan.org/api",
    etherscanApiUrl: "https://api.etherscan.io/v2/api"
  });

  assert.equal(apiUrl, "https://api.etherscan.io/v2/api");
});

test("resolveExplorerApiUrl prefers BaseScan for Base when configured", () => {
  const apiUrl = resolveExplorerApiUrl({
    chainId: 8453,
    baseScanApiUrl: "https://api.basescan.org/api",
    etherscanApiUrl: "https://api.etherscan.io/v2/api"
  });

  assert.equal(apiUrl, "https://api.basescan.org/api");
});

test("resolveExplorerApiUrl falls back to the Base default explorer when only a BaseScan key is configured", () => {
  const apiUrl = resolveExplorerApiUrl({
    chainId: 8453,
    defaultApiUrl: "https://api.basescan.org/api",
    etherscanApiUrl: "https://api.etherscan.io/v2/api",
    hasBaseScanApiKey: true
  });

  assert.equal(apiUrl, "https://api.basescan.org/api");
});

test("resolveExplorerApiUrl falls back to the BscScan default explorer when only a BscScan key is configured", () => {
  const apiUrl = resolveExplorerApiUrl({
    chainId: 56,
    defaultApiUrl: "https://api.bscscan.com/api",
    etherscanApiUrl: "https://api.etherscan.io/v2/api",
    hasBscScanApiKey: true
  });

  assert.equal(apiUrl, "https://api.bscscan.com/api");
});

test("resolveExplorerApiUrl falls back to the chain default when no explorer env is configured", () => {
  const apiUrl = resolveExplorerApiUrl({
    chainId: 8453,
    defaultApiUrl: "https://api.basescan.org/api"
  });

  assert.equal(apiUrl, "https://api.basescan.org/api");
});

test("withExplorerBaseParams only adds chainid for v2 explorer APIs", () => {
  assert.equal(explorerApiNeedsChainId("https://api.etherscan.io/v2/api"), true);
  assert.equal(explorerApiNeedsChainId("https://api.bscscan.com/api"), false);

  const v2 = withExplorerBaseParams({
    apiUrl: "https://api.etherscan.io/v2/api",
    apiKey: "key",
    chainId: 56,
    query: { module: "contract" }
  });
  assert.equal(v2.chainid, "56");

  const legacy = withExplorerBaseParams({
    apiUrl: "https://api.bscscan.com/api",
    apiKey: "key",
    chainId: 56,
    query: { module: "contract" }
  });
  assert.equal("chainid" in legacy, false);
});

test("withExplorerVerificationParams includes BscScan legacy constructorArguements alias", () => {
  assert.equal(explorerUsesLegacyConstructorArgKey("https://api.bscscan.com/api"), true);
  assert.equal(explorerUsesLegacyConstructorArgKey("https://api.basescan.org/api"), true);
  assert.equal(explorerUsesLegacyConstructorArgKey("https://api.etherscan.io/v2/api"), false);

  const bsc = withExplorerVerificationParams({
    apiUrl: "https://api.bscscan.com/api",
    apiKey: "key",
    chainId: 56,
    constructorArguments: "abcd",
    query: { module: "contract", action: "verifysourcecode" }
  });
  assert.equal(bsc.constructorArguments, "abcd");
  assert.equal(bsc.constructorArguements, "abcd");

  const eth = withExplorerVerificationParams({
    apiUrl: "https://api.etherscan.io/v2/api",
    apiKey: "key",
    chainId: 56,
    constructorArguments: "abcd",
    query: { module: "contract", action: "verifysourcecode" }
  });
  assert.equal(eth.constructorArguments, "abcd");
  assert.equal("constructorArguements" in eth, false);
});
