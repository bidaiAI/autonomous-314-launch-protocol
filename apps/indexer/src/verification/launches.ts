import { decodeFunctionData, getAddress, type Hex, type PublicClient } from "viem";
import { launchFactoryAbi } from "../abi";
import { encodeConstructorArguments, launchContractIdentifierForMode } from "./specs";

export type LaunchVerificationIntent = {
  address: `0x${string}`;
  contractIdentifier: string;
  creationTransactionHash: `0x${string}`;
  constructorArguments: Hex;
  label: string;
  source: "launch";
};

type FactoryVerificationContext = {
  factory: `0x${string}`;
  router: `0x${string}`;
  protocolFeeRecipient: `0x${string}`;
  graduationQuoteReserve: bigint;
};

type WhitelistConfigInput = {
  whitelistThreshold: bigint;
  whitelistSlotSize: bigint;
  whitelistOpensAt: bigint;
  whitelistAddresses: readonly `0x${string}`[];
};

type TaxConfigInput = {
  taxBps: number;
  burnShareBps: number;
  treasuryShareBps: number;
  treasuryWallet: `0x${string}`;
};

const launchCreatedEvent = launchFactoryAbi.find(
  (entry) => entry.type === "event" && entry.name === "LaunchCreated"
) as (typeof launchFactoryAbi)[number] | undefined;

if (!launchCreatedEvent || launchCreatedEvent.type !== "event") {
  throw new Error("LaunchCreated event missing from LaunchFactory ABI");
}

const standardCreateFunctions = new Set([
  "createLaunch",
  "createLaunchWithSalt",
  "createLaunchAndBuy",
  "createLaunchAndBuyWithSalt"
]);
const whitelistCreateFunctions = new Set([
  "createWhitelistLaunch",
  "createWhitelistLaunchWithSalt",
  "createWhitelistLaunchAndCommit",
  "createWhitelistLaunchAndCommitWithSalt"
]);
const taxedCreateFunctions = new Set([
  "createTaxLaunch",
  "createTaxLaunchWithSalt",
  "createTaxLaunchAndBuy",
  "createTaxLaunchAndBuyWithSalt"
]);
const whitelistTaxedCreateFunctions = new Set([
  "createWhitelistTaxLaunch",
  "createWhitelistTaxLaunchWithSalt",
  "createWhitelistTaxLaunchAndCommit",
  "createWhitelistTaxLaunchAndCommitWithSalt"
]);

export async function fetchLaunchVerificationIntents(
  client: PublicClient,
  params: {
    factoryAddress: `0x${string}`;
    fromBlock: bigint;
    toBlock: bigint;
    batchBlocks: bigint;
  }
): Promise<LaunchVerificationIntent[]> {
  if (params.fromBlock > params.toBlock) return [];

  const contextCache = new Map<string, FactoryVerificationContext>();
  const intents: LaunchVerificationIntent[] = [];

  for (const log of await getLaunchCreatedLogs(client, params)) {
    const decodedLog = log as {
      args: {
        creator: `0x${string}`;
        token: `0x${string}`;
        mode: number | bigint;
        symbol: string;
      };
      transactionHash?: `0x${string}`;
      blockNumber?: bigint;
    };
    const txHash = log.transactionHash;
    const blockNumber = log.blockNumber;
    if (!txHash || blockNumber === null || blockNumber === undefined) continue;

    const creator = getAddress(String(decodedLog.args.creator));
    const token = getAddress(String(decodedLog.args.token));
    const mode = Number(decodedLog.args.mode ?? 0);
    const contractIdentifier = launchContractIdentifierForMode(mode);
    const cacheKey = blockNumber.toString();
    let factoryContext = contextCache.get(cacheKey);
    if (!factoryContext) {
      factoryContext = await readFactoryVerificationContext(client, params.factoryAddress, blockNumber);
      contextCache.set(cacheKey, factoryContext);
    }

    const transaction = await client.getTransaction({ hash: txHash });
    const decoded = decodeFunctionData({
      abi: launchFactoryAbi,
      data: transaction.input
    });

    const constructorArguments = buildLaunchConstructorArguments({
      functionName: decoded.functionName,
      args: decoded.args ?? [],
      creator,
      factoryContext,
      mode
    });

    intents.push({
      address: token,
      contractIdentifier,
      creationTransactionHash: txHash,
      constructorArguments,
      label: `${String(decodedLog.args.symbol)} @ ${token}`,
      source: "launch"
    });
  }

  return intents;
}

async function readFactoryVerificationContext(
  client: PublicClient,
  factoryAddress: `0x${string}`,
  blockNumber: bigint
): Promise<FactoryVerificationContext> {
  const [router, protocolFeeRecipient, graduationQuoteReserve] = (await Promise.all([
    client.readContract({
      address: factoryAddress,
      abi: launchFactoryAbi,
      functionName: "router",
      blockNumber
    }),
    client.readContract({
      address: factoryAddress,
      abi: launchFactoryAbi,
      functionName: "protocolFeeRecipient",
      blockNumber
    }),
    client.readContract({
      address: factoryAddress,
      abi: launchFactoryAbi,
      functionName: "graduationQuoteReserve",
      blockNumber
    })
  ])) as [`0x${string}`, `0x${string}`, bigint];

  return {
    factory: factoryAddress,
    router: getAddress(router),
    protocolFeeRecipient: getAddress(protocolFeeRecipient),
    graduationQuoteReserve
  };
}

export function buildLaunchConstructorArguments(params: {
  functionName: string;
  args: readonly unknown[];
  creator: `0x${string}`;
  factoryContext: FactoryVerificationContext;
  mode: number;
}): Hex {
  const { functionName, args, creator, factoryContext, mode } = params;
  const contractIdentifier = launchContractIdentifierForMode(mode);

  if (standardCreateFunctions.has(functionName)) {
    const [name, symbol, metadataURI] = args as readonly [string, string, string, ...unknown[]];
    return encodeConstructorArguments(contractIdentifier, [
      {
        name,
        symbol,
        metadataURI,
        creator,
        factory: factoryContext.factory,
        protocolFeeRecipient: factoryContext.protocolFeeRecipient,
        router: factoryContext.router,
        graduationQuoteReserve: factoryContext.graduationQuoteReserve,
        launchModeId: 1
      }
    ]);
  }

  if (whitelistCreateFunctions.has(functionName)) {
    const [name, symbol, metadataURI, whitelistThreshold, whitelistSlotSize, whitelistOpensAt, whitelistAddresses] =
      args as readonly [string, string, string, bigint, bigint, bigint, readonly `0x${string}`[], ...unknown[]];
    return encodeConstructorArguments(contractIdentifier, [
      {
        name,
        symbol,
        metadataURI,
        creator,
        factory: factoryContext.factory,
        protocolFeeRecipient: factoryContext.protocolFeeRecipient,
        router: factoryContext.router,
        graduationQuoteReserve: factoryContext.graduationQuoteReserve,
        whitelistThreshold,
        whitelistSlotSize,
        whitelistOpensAt,
        whitelistAddresses,
        launchModeId: 2
      }
    ]);
  }

  if (taxedCreateFunctions.has(functionName)) {
    const [name, symbol, metadataURI, taxBps, burnShareBps, treasuryShareBps, treasuryWallet] = args as readonly [
      string,
      string,
      string,
      number,
      number,
      number,
      `0x${string}`,
      ...unknown[]
    ];
    return encodeConstructorArguments(contractIdentifier, [
      {
        name,
        symbol,
        metadataURI,
        creator,
        factory: factoryContext.factory,
        protocolFeeRecipient: factoryContext.protocolFeeRecipient,
        router: factoryContext.router,
        graduationQuoteReserve: factoryContext.graduationQuoteReserve,
        launchModeId: taxedModeId(Number(taxBps)),
        taxBps: Number(taxBps),
        burnShareBps: Number(burnShareBps),
        treasuryShareBps: Number(treasuryShareBps),
        treasuryWallet: getAddress(treasuryWallet)
      }
    ]);
  }

  if (whitelistTaxedCreateFunctions.has(functionName)) {
    const [name, symbol, metadataURI, whitelistConfig, taxConfig] = args as readonly [
      string,
      string,
      string,
      WhitelistConfigInput,
      TaxConfigInput,
      Hex,
      ...unknown[]
    ];
    return encodeConstructorArguments(contractIdentifier, [
      {
        name,
        symbol,
        metadataURI,
        creator,
        factory: factoryContext.factory,
        protocolFeeRecipient: factoryContext.protocolFeeRecipient,
        router: factoryContext.router,
        graduationQuoteReserve: factoryContext.graduationQuoteReserve,
        whitelistThreshold: whitelistConfig.whitelistThreshold,
        whitelistSlotSize: whitelistConfig.whitelistSlotSize,
        whitelistOpensAt: whitelistConfig.whitelistOpensAt,
        whitelistAddresses: whitelistConfig.whitelistAddresses,
        launchModeId: 12,
        taxBps: Number(taxConfig.taxBps),
        burnShareBps: Number(taxConfig.burnShareBps),
        treasuryShareBps: Number(taxConfig.treasuryShareBps),
        treasuryWallet: getAddress(taxConfig.treasuryWallet)
      }
    ]);
  }

  throw new Error(`Unsupported factory create function for verification: ${functionName}`);
}

async function getLaunchCreatedLogs(
  client: PublicClient,
  params: {
    factoryAddress: `0x${string}`;
    fromBlock: bigint;
    toBlock: bigint;
    batchBlocks: bigint;
  }
) {
  const batchBlocks = params.batchBlocks > 0n ? params.batchBlocks : 2_000n;
  const logs: Array<{
    transactionHash?: `0x${string}`;
    blockNumber?: bigint;
    logIndex?: number;
    args: {
      creator: `0x${string}`;
      token: `0x${string}`;
      mode: number | bigint;
      symbol: string;
    };
  }> = [];
  let cursor = params.fromBlock;

  while (cursor <= params.toBlock) {
    const end = cursor + batchBlocks - 1n > params.toBlock ? params.toBlock : cursor + batchBlocks - 1n;
    try {
      const chunk = await client.getLogs({
        address: params.factoryAddress,
        event: launchCreatedEvent as any,
        fromBlock: cursor,
        toBlock: end,
        strict: false
      });
      logs.push(...(chunk as unknown as typeof logs));
      cursor = end + 1n;
    } catch (error) {
      if (batchBlocks <= 50n) throw error;
      const narrowed = await getLaunchCreatedLogs(client, {
        ...params,
        fromBlock: cursor,
        toBlock: end,
        batchBlocks: batchBlocks / 2n
      });
      logs.push(...narrowed);
      cursor = end + 1n;
    }
  }

  return logs.sort((a, b) => {
    const blockDelta = Number((a.blockNumber ?? 0n) - (b.blockNumber ?? 0n));
    if (blockDelta !== 0) return blockDelta;
    return (a.logIndex ?? 0) - (b.logIndex ?? 0);
  });
}

function taxedModeId(taxBps: number) {
  if (taxBps < 100 || taxBps > 900 || taxBps % 100 !== 0) {
    throw new Error(`Unsupported tax mode for verification: ${taxBps}`);
  }
  return taxBps / 100 + 2;
}
