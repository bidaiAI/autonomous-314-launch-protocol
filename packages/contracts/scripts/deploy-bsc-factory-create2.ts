import fs from "fs";
import path from "path";
import { ethers, network } from "hardhat";

const DEFAULT_CREATE2_DEPLOYER = "0x4e59b44847b379578588920cA78FbF26c0B4956C";
const DEFAULT_ROUTER = "0x10ED43C718714eb63d5aA57B78B54704E256024E";
const DEFAULT_PROTOCOL_RECIPIENT = "0xC4187bE6b362DF625696d4a9ec5E6FA461CC0314";
const DEFAULT_OWNER = DEFAULT_PROTOCOL_RECIPIENT;
const DEFAULT_CREATE_FEE = "0.03";
const DEFAULT_GRADUATION_TARGET = "12";
const DEFAULT_SALT = "0x58dc751d9dc996e4ef6912e2ea0100e65c3c3c811a17deb11f0dc86deaeb3945";
const DEFAULT_EXPECTED_FACTORY = "0xEFd05ee43A21cc109604050724cEd52ebA200314";

function requiredAddress(value: string | undefined, fallback: string, label: string) {
  try {
    return ethers.getAddress(value && value.trim() ? value : fallback);
  } catch {
    throw new Error(`Invalid ${label}`);
  }
}

function requiredHex32(value: string | undefined, fallback: string, label: string) {
  const candidate = (value && value.trim() ? value : fallback).toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(candidate)) {
    throw new Error(`Invalid ${label}`);
  }
  return candidate;
}

function requiredEther(value: string | undefined, fallback: string, label: string) {
  try {
    return ethers.parseEther(value && value.trim() ? value : fallback);
  } catch {
    throw new Error(`Invalid ${label}`);
  }
}

async function main() {
  const create2Deployer = requiredAddress(process.env.BSC_CREATE2_DEPLOYER, DEFAULT_CREATE2_DEPLOYER, "BSC_CREATE2_DEPLOYER");
  const owner = requiredAddress(process.env.BSC_FACTORY_OWNER, DEFAULT_OWNER, "BSC_FACTORY_OWNER");
  const router = requiredAddress(process.env.BSC_FACTORY_ROUTER, DEFAULT_ROUTER, "BSC_FACTORY_ROUTER");
  const protocolFeeRecipient = requiredAddress(
    process.env.BSC_PROTOCOL_FEE_RECIPIENT,
    DEFAULT_PROTOCOL_RECIPIENT,
    "BSC_PROTOCOL_FEE_RECIPIENT"
  );
  const salt = requiredHex32(process.env.BSC_FACTORY_CREATE2_SALT, DEFAULT_SALT, "BSC_FACTORY_CREATE2_SALT");
  const expectedFactoryAddress = requiredAddress(
    process.env.BSC_EXPECTED_FACTORY_ADDRESS,
    DEFAULT_EXPECTED_FACTORY,
    "BSC_EXPECTED_FACTORY_ADDRESS"
  );
  const createFee = requiredEther(process.env.BSC_CREATE_FEE_NATIVE, DEFAULT_CREATE_FEE, "BSC_CREATE_FEE_NATIVE");
  const graduationTarget = requiredEther(
    process.env.BSC_GRADUATION_TARGET_NATIVE,
    DEFAULT_GRADUATION_TARGET,
    "BSC_GRADUATION_TARGET_NATIVE"
  );
  const dryRun = process.env.BSC_DEPLOY_DRY_RUN === "1";

  const [deployer] = await ethers.getSigners();
  const provider = ethers.provider;
  const networkInfo = await provider.getNetwork();

  if (!dryRun && network.name !== "bsc") {
    throw new Error(`Refusing to broadcast on network "${network.name}". Use --network bsc or set BSC_DEPLOY_DRY_RUN=1.`);
  }

  if (!dryRun && networkInfo.chainId !== 56n) {
    throw new Error(`Unexpected chainId ${networkInfo.chainId}. Expected 56 for BSC mainnet.`);
  }

  const LaunchFactory = await ethers.getContractFactory("LaunchFactory");
  const deployTxRequest = await LaunchFactory.getDeployTransaction(
    owner,
    router,
    protocolFeeRecipient,
    createFee,
    graduationTarget
  );

  const initCode = deployTxRequest.data;
  if (!initCode) {
    throw new Error("Failed to build LaunchFactory init code");
  }

  const initCodeHash = ethers.keccak256(initCode);
  const predictedFactory = ethers.getCreate2Address(create2Deployer, salt, initCodeHash);

  if (predictedFactory.toLowerCase() !== expectedFactoryAddress.toLowerCase()) {
    throw new Error(`Predicted factory ${predictedFactory} does not match expected ${expectedFactoryAddress}`);
  }

  const summary = {
    network: network.name,
    chainId: Number(networkInfo.chainId),
    deployer: deployer.address,
    create2Deployer,
    owner,
    router,
    protocolFeeRecipient,
    createFee: ethers.formatEther(createFee),
    graduationTarget: ethers.formatEther(graduationTarget),
    salt,
    initCodeHash,
    predictedFactory,
    dryRun
  };

  console.log(JSON.stringify(summary, null, 2));

  if (dryRun) {
    console.log(
      JSON.stringify(
        {
          routerIntrospection: "skipped in dry run unless you execute against a real BSC RPC/network"
        },
        null,
        2
      )
    );
    return;
  }

  const routerContract = new ethers.Contract(
    router,
    ["function factory() view returns (address)", "function WETH() view returns (address)"],
    provider
  );

  const [dexFactory, wrappedNative] = await Promise.all([
    routerContract.factory(),
    routerContract.WETH()
  ]);

  console.log(
    JSON.stringify(
      {
        dexFactory,
        wrappedNative
      },
      null,
      2
    )
  );

  const create2DeployerCode = await provider.getCode(create2Deployer);
  if (create2DeployerCode === "0x") {
    throw new Error(`No code found at CREATE2 deployer ${create2Deployer}`);
  }

  const existingFactoryCode = await provider.getCode(predictedFactory);
  if (existingFactoryCode !== "0x") {
    throw new Error(`Factory already deployed at ${predictedFactory}`);
  }

  const calldata = ethers.concat([salt, initCode]);
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

  console.log(`Broadcasted deployment tx: ${tx.hash}`);
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) {
    throw new Error("Factory deployment transaction failed");
  }

  const deployedCode = await provider.getCode(predictedFactory);
  if (deployedCode === "0x") {
    throw new Error(`Factory code missing at ${predictedFactory} after deployment`);
  }

  const deployedFactory = await ethers.getContractAt("LaunchFactory", predictedFactory);
  const [ownerOnChain, routerOnChain, recipientOnChain, createFeeOnChain, graduationTargetOnChain] = await Promise.all([
    deployedFactory.owner(),
    deployedFactory.router(),
    deployedFactory.protocolFeeRecipient(),
    deployedFactory.createFee(),
    deployedFactory.graduationQuoteReserve()
  ]);

  console.log(
    JSON.stringify(
      {
        deploymentTxHash: tx.hash,
        gasUsed: receipt.gasUsed.toString(),
        factory: predictedFactory,
        ownerOnChain,
        routerOnChain,
        recipientOnChain,
        createFeeOnChain: ethers.formatEther(createFeeOnChain),
        graduationTargetOnChain: ethers.formatEther(graduationTargetOnChain)
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
