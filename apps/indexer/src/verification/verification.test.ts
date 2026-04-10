import test from "node:test";
import assert from "node:assert/strict";
import { decodeFunctionData, encodeDeployData, encodeFunctionData, getAddress } from "viem";
import { launchFactoryAbi } from "../abi";
import { buildLaunchConstructorArguments } from "./launches";
import {
  constructorInputCount,
  encodeConstructorArguments,
  extractConstructorArgumentsFromCreationInput,
  findSolidityMetadataStartForTest,
  loadContractBuildSpec
} from "./specs";

test("rebuilds standard launch constructor arguments from factory call data", () => {
  const creator = getAddress("0x1111111111111111111111111111111111111111");
  const factory = getAddress("0x2222222222222222222222222222222222222222");
  const protocolFeeRecipient = getAddress("0x3333333333333333333333333333333333333333");
  const router = getAddress("0x4444444444444444444444444444444444444444");
  const txData = encodeFunctionData({
    abi: launchFactoryAbi,
    functionName: "createLaunchAndBuyWithSalt",
    args: ["Auto", "AUTO", "ipfs://meta", "0x" + "11".repeat(32), 123n]
  });
  const decoded = decodeFunctionData({ abi: launchFactoryAbi, data: txData });

  const constructorArguments = buildLaunchConstructorArguments({
    functionName: decoded.functionName,
    args: decoded.args ?? [],
    creator,
    factoryContext: {
      factory,
      protocolFeeRecipient,
      router,
      graduationQuoteReserve: 12n * 10n ** 18n
    },
    mode: 1
  });

  const expected = encodeConstructorArguments("contracts/LaunchToken.sol:LaunchToken", [
    {
      name: "Auto",
      symbol: "AUTO",
      metadataURI: "ipfs://meta",
      creator,
      factory,
      protocolFeeRecipient,
      router,
      graduationQuoteReserve: 12n * 10n ** 18n,
      launchModeId: 1
    }
  ]);

  assert.equal(constructorArguments, expected);
});

test("rebuilds whitelist taxed launch constructor arguments from factory call data", () => {
  const creator = getAddress("0x1111111111111111111111111111111111111111");
  const factory = getAddress("0x2222222222222222222222222222222222222222");
  const protocolFeeRecipient = getAddress("0x3333333333333333333333333333333333333333");
  const router = getAddress("0x4444444444444444444444444444444444444444");
  const whitelistAddresses = [
    getAddress("0x5555555555555555555555555555555555555555"),
    getAddress("0x6666666666666666666666666666666666666666")
  ] as const;

  const txData = encodeFunctionData({
    abi: launchFactoryAbi,
    functionName: "createWhitelistTaxLaunchWithSalt",
    args: [
      "WL Tax",
      "F314",
      "ipfs://wl-tax",
      {
        whitelistThreshold: 4n * 10n ** 18n,
        whitelistSlotSize: 1n * 10n ** 18n,
        whitelistOpensAt: 0n,
        whitelistAddresses
      },
      {
        taxBps: 300,
        burnShareBps: 6000,
        treasuryShareBps: 4000,
        treasuryWallet: getAddress("0x7777777777777777777777777777777777777777")
      },
      "0x1234",
      "0x" + "22".repeat(32)
    ]
  });
  const decoded = decodeFunctionData({ abi: launchFactoryAbi, data: txData });

  const constructorArguments = buildLaunchConstructorArguments({
    functionName: decoded.functionName,
    args: decoded.args ?? [],
    creator,
    factoryContext: {
      factory,
      protocolFeeRecipient,
      router,
      graduationQuoteReserve: 12n * 10n ** 18n
    },
    mode: 12
  });

  const expected = encodeConstructorArguments(
    "contracts/LaunchTokenWhitelistTaxed.sol:LaunchTokenWhitelistTaxed",
    [
      {
        name: "WL Tax",
        symbol: "F314",
        metadataURI: "ipfs://wl-tax",
        creator,
        factory,
        protocolFeeRecipient,
        router,
        graduationQuoteReserve: 12n * 10n ** 18n,
        whitelistThreshold: 4n * 10n ** 18n,
        whitelistSlotSize: 1n * 10n ** 18n,
        whitelistOpensAt: 0n,
        whitelistAddresses,
        launchModeId: 12,
        taxBps: 300,
        burnShareBps: 6000,
        treasuryShareBps: 4000,
        treasuryWallet: getAddress("0x7777777777777777777777777777777777777777")
      }
    ]
  );

  assert.equal(constructorArguments, expected);
});

test("extracts constructor args from top-level deployment input for official contracts", () => {
  const spec = loadContractBuildSpec("contracts/LaunchFactory.sol:LaunchFactory");
  const deployData = encodeDeployData({
    abi: spec.abi,
    bytecode: spec.bytecode,
    args: [
      getAddress("0x9999999999999999999999999999999999999999"),
      getAddress("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
      getAddress("0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"),
      getAddress("0xcccccccccccccccccccccccccccccccccccccccc"),
      getAddress("0xdddddddddddddddddddddddddddddddddddddddd"),
      getAddress("0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"),
      getAddress("0xffffffffffffffffffffffffffffffffffffffff"),
      10n ** 16n,
      3n * 10n ** 16n,
      12n * 10n ** 18n,
      [4n, 6n, 8n],
      [1n * 10n ** 17n, 2n * 10n ** 17n, 5n * 10n ** 17n, 1n * 10n ** 18n]
    ]
  });

  const extracted = extractConstructorArgumentsFromCreationInput(
    "contracts/LaunchFactory.sol:LaunchFactory",
    deployData
  );

  assert.equal(extracted, `0x${deployData.slice(spec.bytecode.length)}`);
});

test("extracts constructor args when only the solidity metadata hash differs", () => {
  const spec = loadContractBuildSpec("contracts/LaunchTokenDeployer.sol:LaunchTokenDeployer");
  const metadataStart = findSolidityMetadataStartForTest(spec.bytecode);
  assert.notEqual(metadataStart, null);

  const metadataIndex = (metadataStart ?? 0) + 20;
  const current = spec.bytecode[metadataIndex];
  assert.ok(current);
  const replacement = current === "0" ? "1" : "0";
  const creationInput = (
    `${spec.bytecode.slice(0, metadataIndex)}${replacement}${spec.bytecode.slice(metadataIndex + 1)}`
  ) as `0x${string}`;

  const extracted = extractConstructorArgumentsFromCreationInput(
    "contracts/LaunchTokenDeployer.sol:LaunchTokenDeployer",
    creationInput
  );

  assert.equal(extracted, "0x");
});

test("still rejects creation input mismatches before the solidity metadata section", () => {
  const spec = loadContractBuildSpec("contracts/LaunchTokenDeployer.sol:LaunchTokenDeployer");
  const metadataStart = findSolidityMetadataStartForTest(spec.bytecode);
  assert.notEqual(metadataStart, null);
  assert.ok((metadataStart ?? 0) > 10);

  const mismatchIndex = (metadataStart ?? 12) - 6;
  const current = spec.bytecode[mismatchIndex];
  assert.ok(current);
  const replacement = current === "0" ? "1" : "0";
  const creationInput = (
    `${spec.bytecode.slice(0, mismatchIndex)}${replacement}${spec.bytecode.slice(mismatchIndex + 1)}`
  ) as `0x${string}`;

  assert.throws(() =>
    extractConstructorArgumentsFromCreationInput(
      "contracts/LaunchTokenDeployer.sol:LaunchTokenDeployer",
      creationInput
    )
  );
});

test("detects zero-arg bootstrap deployers correctly", () => {
  assert.equal(
    constructorInputCount("contracts/LaunchTokenDeployer.sol:LaunchTokenDeployer"),
    0
  );
  assert.equal(
    constructorInputCount("contracts/LaunchCreate2Deployer.sol:LaunchCreate2Deployer"),
    0
  );
  assert.equal(
    constructorInputCount("contracts/LaunchFactory.sol:LaunchFactory"),
    12
  );
});

test("uses the legacy 10-input LaunchFactory artifact for the official BSC bootstrap runtime", { concurrency: false }, () => {
  const previousChainId = process.env.INDEXER_CHAIN_ID;
  const previousFactoryAddress = process.env.INDEXER_FACTORY_ADDRESS;

  process.env.INDEXER_CHAIN_ID = "56";
  process.env.INDEXER_FACTORY_ADDRESS = "0xa5d62930AA7CDD332B6bF1A32dB0cC7095FC0314";

  try {
    assert.equal(
      constructorInputCount("contracts/LaunchFactory.sol:LaunchFactory"),
      10
    );

    const encoded = encodeConstructorArguments("contracts/LaunchFactory.sol:LaunchFactory", [
      getAddress("0x9999999999999999999999999999999999999999"),
      getAddress("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
      getAddress("0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"),
      getAddress("0xcccccccccccccccccccccccccccccccccccccccc"),
      getAddress("0xdddddddddddddddddddddddddddddddddddddddd"),
      getAddress("0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"),
      getAddress("0xffffffffffffffffffffffffffffffffffffffff"),
      10n ** 16n,
      3n * 10n ** 16n,
      12n * 10n ** 18n
    ]);

    assert.match(encoded, /^0x[0-9a-f]+$/);
  } finally {
    if (previousChainId === undefined) {
      delete process.env.INDEXER_CHAIN_ID;
    } else {
      process.env.INDEXER_CHAIN_ID = previousChainId;
    }

    if (previousFactoryAddress === undefined) {
      delete process.env.INDEXER_FACTORY_ADDRESS;
    } else {
      process.env.INDEXER_FACTORY_ADDRESS = previousFactoryAddress;
    }
  }
});
