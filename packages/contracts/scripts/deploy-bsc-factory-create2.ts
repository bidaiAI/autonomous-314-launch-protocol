import crypto from "crypto";
import { ethers, network } from "hardhat";

const DEFAULT_CREATE2_DEPLOYER = "0x4e59b44847b379578588920cA78FbF26c0B4956C";
const DEFAULT_ROUTER = "0x10ED43C718714eb63d5aA57B78B54704E256024E";
const DEFAULT_PROTOCOL_RECIPIENT = "0xC4187bE6b362DF625696d4a9ec5E6FA461CC0314";
const DEFAULT_OWNER = DEFAULT_PROTOCOL_RECIPIENT;
const DEFAULT_STANDARD_CREATE_FEE = "0.01";
const DEFAULT_WHITELIST_CREATE_FEE = "0.03";
const DEFAULT_GRADUATION_TARGET = "12";
const DEFAULT_SUFFIX = "0314";
const BSC_WHITELIST_THRESHOLDS = [ethers.parseEther("4"), ethers.parseEther("6"), ethers.parseEther("8")];
const BSC_WHITELIST_SLOT_SIZES = [
  ethers.parseEther("0.1"),
  ethers.parseEther("0.2"),
  ethers.parseEther("0.5"),
  ethers.parseEther("1")
];

function optionalAddress(value: string | undefined) {
  if (!value || !value.trim()) return null;
  return ethers.getAddress(value.trim());
}

function requiredAddress(value: string | undefined, fallback: string, label: string) {
  try {
    return ethers.getAddress(value && value.trim() ? value : fallback);
  } catch {
    throw new Error(`Invalid ${label}`);
  }
}

function requiredEther(value: string | undefined, fallback: string, label: string) {
  try {
    return ethers.parseEther(value && value.trim() ? value : fallback);
  } catch {
    throw new Error(`Invalid ${label}`);
  }
}

function requiredSuffix(value: string | undefined, fallback: string) {
  const suffix = (value && value.trim() ? value : fallback).toLowerCase();
  if (!/^[0-9a-f]+$/.test(suffix)) {
    throw new Error("Invalid BSC_FACTORY_SUFFIX");
  }
  return suffix;
}

function requiredHex32(value: string | undefined, label: string) {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || !/^0x[0-9a-f]{64}$/.test(normalized)) {
    throw new Error(`Invalid ${label}`);
  }
  return normalized;
}

function optionalPrivateKey(value: string | undefined) {
  const normalized = value?.trim();
  if (!normalized) return null;
  if (!/^0x[0-9a-fA-F]{64}$/.test(normalized)) {
    throw new Error("Invalid deployer private key");
  }
  return normalized;
}

function buildFactoryDeployTxRequest(
  factory: Awaited<ReturnType<typeof ethers.getContractFactory>>,
  args: {
    owner: string;
    router: string;
    protocolFeeRecipient: string;
    standardDeployer: string;
    whitelistDeployer: string;
    taxedDeployer: string;
    whitelistTaxedDeployer: string;
    standardCreateFee: bigint;
    whitelistCreateFee: bigint;
    graduationTarget: bigint;
    whitelistThresholdPresets: bigint[];
    whitelistSlotSizePresets: bigint[];
  }
) {
  return factory.getDeployTransaction(
    args.owner,
    args.router,
    args.protocolFeeRecipient,
    args.standardDeployer,
    args.whitelistDeployer,
    args.taxedDeployer,
    args.whitelistTaxedDeployer,
    args.standardCreateFee,
    args.whitelistCreateFee,
    args.graduationTarget,
    args.whitelistThresholdPresets,
    args.whitelistSlotSizePresets
  );
}

function findVanitySalt(create2Deployer: string, initCodeHash: string, suffix: string) {
  let attempts = 0;
  const started = Date.now();

  for (;;) {
    const salt = `0x${crypto.randomBytes(32).toString("hex")}`;
    const predicted = ethers.getCreate2Address(create2Deployer, salt, initCodeHash);
    attempts += 1;

    if (predicted.toLowerCase().endsWith(suffix)) {
      return {
        salt,
        predicted,
        attempts,
        elapsedMs: Date.now() - started
      };
    }
  }
}

async function waitForCode(
  provider: typeof ethers.provider,
  address: string,
  label: string,
  attempts = 10,
  delayMs = 1500
) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const code = await provider.getCode(address);
    if (code !== "0x") {
      return code;
    }
    if (attempt < attempts) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw new Error(`${label} deployment succeeded but no code was found at ${address} after ${attempts} checks`);
}

async function deploySupportDeployer(
  name: "LaunchTokenDeployer" | "LaunchTokenWhitelistDeployer" | "LaunchTokenTaxedDeployer" | "LaunchCreate2Deployer",
  existingAddress: string | null,
  deployer: Awaited<ReturnType<typeof ethers.getSigners>>[number],
  provider: typeof ethers.provider,
  dryRun: boolean,
  deployerAddress: string,
  nonceCursor: { value: bigint }
) {
  if (existingAddress) {
    return { address: existingAddress, predictedOnly: dryRun, txHash: null as string | null };
  }

  const predicted = ethers.getCreateAddress({
    from: deployerAddress,
    nonce: nonceCursor.value
  });

  if (dryRun) {
    nonceCursor.value += 1n;
    return { address: predicted, predictedOnly: true, txHash: null as string | null };
  }

  const Factory = await ethers.getContractFactory(name);
  const deployTx = await Factory.getDeployTransaction();
  if (!deployTx.data) {
    throw new Error(`Failed to build ${name} deployment transaction`);
  }

  const estimatedGas = await provider.estimateGas({
    from: deployerAddress,
    data: deployTx.data
  });
  const tx = await deployer.sendTransaction({
    data: deployTx.data,
    nonce: nonceCursor.value,
    gasLimit: (estimatedGas * 12n) / 10n
  });
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) {
    throw new Error(`${name} deployment transaction failed`);
  }

  await waitForCode(provider, predicted, name);

  nonceCursor.value += 1n;
  return { address: predicted, predictedOnly: false, txHash: tx.hash };
}

async function main() {
  const create2Deployer = requiredAddress(
    process.env.BSC_CREATE2_DEPLOYER,
    DEFAULT_CREATE2_DEPLOYER,
    "BSC_CREATE2_DEPLOYER"
  );
  const owner = requiredAddress(process.env.BSC_FACTORY_OWNER, DEFAULT_OWNER, "BSC_FACTORY_OWNER");
  const router = requiredAddress(process.env.BSC_FACTORY_ROUTER, DEFAULT_ROUTER, "BSC_FACTORY_ROUTER");
  const protocolFeeRecipient = requiredAddress(
    process.env.BSC_PROTOCOL_FEE_RECIPIENT,
    DEFAULT_PROTOCOL_RECIPIENT,
    "BSC_PROTOCOL_FEE_RECIPIENT"
  );
  const standardCreateFee = requiredEther(
    process.env.BSC_STANDARD_CREATE_FEE_NATIVE ?? process.env.BSC_CREATE_FEE_NATIVE,
    DEFAULT_STANDARD_CREATE_FEE,
    "BSC_STANDARD_CREATE_FEE_NATIVE"
  );
  const whitelistCreateFee = requiredEther(
    process.env.BSC_WHITELIST_CREATE_FEE_NATIVE,
    DEFAULT_WHITELIST_CREATE_FEE,
    "BSC_WHITELIST_CREATE_FEE_NATIVE"
  );
  const graduationTarget = requiredEther(
    process.env.BSC_GRADUATION_TARGET_NATIVE,
    DEFAULT_GRADUATION_TARGET,
    "BSC_GRADUATION_TARGET_NATIVE"
  );
  const desiredSuffix = requiredSuffix(process.env.BSC_FACTORY_SUFFIX, DEFAULT_SUFFIX);
  const dryRun = process.env.BSC_DEPLOY_DRY_RUN === "1";
  const provider = ethers.provider;
  const deployerPrivateKey =
    optionalPrivateKey(process.env.BSC_DEPLOYER_PRIVATE_KEY) ??
    optionalPrivateKey(process.env.DEPLOYER_PRIVATE_KEY);
  const deployer = deployerPrivateKey
    ? new ethers.Wallet(deployerPrivateKey, provider)
    : (await ethers.getSigners())[0];
  const networkInfo = await provider.getNetwork();

  if (!dryRun && network.name !== "bsc") {
    throw new Error(`Refusing to broadcast on network "${network.name}". Use --network bsc or set BSC_DEPLOY_DRY_RUN=1.`);
  }
  if (!dryRun && networkInfo.chainId !== 56n) {
    throw new Error(`Unexpected chainId ${networkInfo.chainId}. Expected 56 for BSC mainnet.`);
  }

  const startNonce = await provider.getTransactionCount(deployer.address, "latest");
  const nonceCursor = { value: BigInt(startNonce) };

  const configuredStandardDeployer = optionalAddress(process.env.BSC_STANDARD_DEPLOYER_ADDRESS);
  const configuredWhitelistDeployer = optionalAddress(process.env.BSC_WHITELIST_DEPLOYER_ADDRESS);
  const configuredTaxedDeployer = optionalAddress(process.env.BSC_TAXED_DEPLOYER_ADDRESS);
  const configuredWhitelistTaxedDeployer = optionalAddress(process.env.BSC_WHITELIST_TAXED_DEPLOYER_ADDRESS);

  const standardDeployer = await deploySupportDeployer(
    "LaunchTokenDeployer",
    configuredStandardDeployer,
    deployer,
    provider,
    dryRun,
    deployer.address,
    nonceCursor
  );
  const whitelistDeployer = await deploySupportDeployer(
    "LaunchTokenWhitelistDeployer",
    configuredWhitelistDeployer,
    deployer,
    provider,
    dryRun,
    deployer.address,
    nonceCursor
  );
  const taxedDeployer = await deploySupportDeployer(
    "LaunchTokenTaxedDeployer",
    configuredTaxedDeployer,
    deployer,
    provider,
    dryRun,
    deployer.address,
    nonceCursor
  );
  const whitelistTaxedDeployer = await deploySupportDeployer(
    "LaunchCreate2Deployer",
    configuredWhitelistTaxedDeployer,
    deployer,
    provider,
    dryRun,
    deployer.address,
    nonceCursor
  );

  const LaunchFactory = await ethers.getContractFactory("LaunchFactory");
  const deployTxRequest = await buildFactoryDeployTxRequest(LaunchFactory, {
    owner,
    router,
    protocolFeeRecipient,
    standardDeployer: standardDeployer.address,
    whitelistDeployer: whitelistDeployer.address,
    taxedDeployer: taxedDeployer.address,
    whitelistTaxedDeployer: whitelistTaxedDeployer.address,
    standardCreateFee,
    whitelistCreateFee,
    graduationTarget,
    whitelistThresholdPresets: BSC_WHITELIST_THRESHOLDS,
    whitelistSlotSizePresets: BSC_WHITELIST_SLOT_SIZES
  });

  const initCode = deployTxRequest.data;
  if (!initCode) {
    throw new Error("Failed to build LaunchFactory init code");
  }
  const initCodeHash = ethers.keccak256(initCode);

  const providedSalt = process.env.BSC_FACTORY_CREATE2_SALT?.trim()
    ? requiredHex32(process.env.BSC_FACTORY_CREATE2_SALT, "BSC_FACTORY_CREATE2_SALT")
    : null;
  const expectedFactoryAddressFromEnv = process.env.BSC_EXPECTED_FACTORY_ADDRESS?.trim()
    ? ethers.getAddress(process.env.BSC_EXPECTED_FACTORY_ADDRESS.trim())
    : null;

  const vanity =
    providedSalt
      ? {
          salt: providedSalt,
          predicted: ethers.getCreate2Address(create2Deployer, providedSalt, initCodeHash),
          attempts: 0,
          elapsedMs: 0
        }
      : findVanitySalt(create2Deployer, initCodeHash, desiredSuffix);

  if (expectedFactoryAddressFromEnv && vanity.predicted.toLowerCase() !== expectedFactoryAddressFromEnv.toLowerCase()) {
    throw new Error(`Predicted factory ${vanity.predicted} does not match expected ${expectedFactoryAddressFromEnv}`);
  }

  const summary = {
    network: network.name,
    chainId: Number(networkInfo.chainId),
    deployer: deployer.address,
    create2Deployer,
    owner,
    router,
    protocolFeeRecipient,
    standardCreateFee: ethers.formatEther(standardCreateFee),
    whitelistCreateFee: ethers.formatEther(whitelistCreateFee),
    graduationTarget: ethers.formatEther(graduationTarget),
    supportDeployers: {
      standardDeployer: standardDeployer.address,
      whitelistDeployer: whitelistDeployer.address,
      taxedDeployer: taxedDeployer.address,
      whitelistTaxedDeployer: whitelistTaxedDeployer.address
    },
    supportDeploymentTxs: {
      standardDeployer: standardDeployer.txHash,
      whitelistDeployer: whitelistDeployer.txHash,
      taxedDeployer: taxedDeployer.txHash,
      whitelistTaxedDeployer: whitelistTaxedDeployer.txHash
    },
    initCodeHash,
    desiredSuffix,
    salt: vanity.salt,
    predictedFactory: vanity.predicted,
    vanityAttempts: vanity.attempts,
    vanityElapsedMs: vanity.elapsedMs,
    dryRun
  };

  console.log(JSON.stringify(summary, null, 2));

  const routerCode = await provider.getCode(router);
  if (routerCode === "0x") {
    console.log(
      JSON.stringify(
        {
          dexFactory: null,
          wrappedNative: null,
          routerIntrospection: "skipped because no router code was found on the active network"
        },
        null,
        2
      )
    );
    if (dryRun) return;
    throw new Error(`No router code found at ${router}`);
  }

  const routerContract = new ethers.Contract(
    router,
    ["function factory() view returns (address)", "function WETH() view returns (address)"],
    provider
  );
  const [dexFactory, wrappedNative] = await Promise.all([routerContract.factory(), routerContract.WETH()]);
  console.log(JSON.stringify({ dexFactory, wrappedNative }, null, 2));

  if (dryRun) return;

  const universalDeployerCode = await provider.getCode(create2Deployer);
  if (universalDeployerCode === "0x") {
    throw new Error(`No code found at CREATE2 deployer ${create2Deployer}`);
  }

  const existingFactoryCode = await provider.getCode(vanity.predicted);
  if (existingFactoryCode !== "0x") {
    throw new Error(`Factory already deployed at ${vanity.predicted}`);
  }

  const calldata = ethers.concat([vanity.salt, initCode]);
  const estimatedGas = await provider.estimateGas({
    from: deployer.address,
    to: create2Deployer,
    data: calldata
  });
  const tx = await deployer.sendTransaction({
    to: create2Deployer,
    data: calldata,
    gasLimit: (estimatedGas * 12n) / 10n
  });
  console.log(`Broadcasted factory deployment tx: ${tx.hash}`);
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) {
    throw new Error("Factory deployment transaction failed");
  }

  const deployedFactory = await ethers.getContractAt("LaunchFactory", vanity.predicted);

  const whitelistTaxedDeployerContract = await ethers.getContractAt(
    "LaunchCreate2Deployer",
    whitelistTaxedDeployer.address
  );
  const currentFactory = await whitelistTaxedDeployerContract.factory();
  if (currentFactory === ethers.ZeroAddress) {
    const bindTx = await whitelistTaxedDeployerContract.setFactory(vanity.predicted);
    console.log(`Broadcasted whitelist-taxed deployer bind tx: ${bindTx.hash}`);
    const bindReceipt = await bindTx.wait();
    if (!bindReceipt || bindReceipt.status !== 1) {
      throw new Error("Failed to bind whitelistTaxedDeployer to factory");
    }
  } else if (currentFactory.toLowerCase() !== vanity.predicted.toLowerCase()) {
    throw new Error(
      `whitelistTaxedDeployer already bound to ${currentFactory}, expected ${vanity.predicted}`
    );
  }

  const [
    ownerOnChain,
    routerOnChain,
    recipientOnChain,
    standardCreateFeeOnChain,
    whitelistCreateFeeOnChain,
    graduationTargetOnChain,
    standardDeployerOnChain,
    whitelistDeployerOnChain,
    taxedDeployerOnChain,
    whitelistTaxedDeployerOnChain
  ] = await Promise.all([
    deployedFactory.owner(),
    deployedFactory.router(),
    deployedFactory.protocolFeeRecipient(),
    deployedFactory.standardCreateFee(),
    deployedFactory.whitelistCreateFee(),
    deployedFactory.graduationQuoteReserve(),
    deployedFactory.standardDeployer(),
    deployedFactory.whitelistDeployer(),
    deployedFactory.taxedDeployer(),
    deployedFactory.whitelistTaxedDeployer()
  ]);

  console.log(
    JSON.stringify(
      {
        deploymentTxHash: tx.hash,
        gasUsed: receipt.gasUsed.toString(),
        factory: vanity.predicted,
        ownerOnChain,
        routerOnChain,
        recipientOnChain,
        standardCreateFeeOnChain: ethers.formatEther(standardCreateFeeOnChain),
        whitelistCreateFeeOnChain: ethers.formatEther(whitelistCreateFeeOnChain),
        graduationTargetOnChain: ethers.formatEther(graduationTargetOnChain),
        standardDeployerOnChain,
        whitelistDeployerOnChain,
        taxedDeployerOnChain,
        whitelistTaxedDeployerOnChain
      },
      null,
      2
    )
  );
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
