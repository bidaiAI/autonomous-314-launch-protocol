import { mkdir, writeFile } from "fs/promises";
import path from "path";
import { ethers } from "hardhat";

const CREATE_FEE = ethers.parseEther(process.env.LOCAL_DEMO_CREATE_FEE_NATIVE ?? process.env.LOCAL_DEMO_CREATE_FEE_BNB ?? "0.01");
const GRADUATION_TARGET = ethers.parseEther(process.env.LOCAL_DEMO_GRADUATION_TARGET_NATIVE ?? process.env.LOCAL_DEMO_GRADUATION_TARGET_BNB ?? "0.2");
const WHITELIST_THRESHOLDS = [ethers.parseEther("4"), ethers.parseEther("6"), ethers.parseEther("8")];
const WHITELIST_SLOT_SIZES = [
  ethers.parseEther("0.1"),
  ethers.parseEther("0.2"),
  ethers.parseEther("0.5"),
  ethers.parseEther("1")
];
const LOCAL_RPC_URL = process.env.LOCAL_DEMO_RPC_URL ?? "http://127.0.0.1:8545";
const INDEXER_API_URL = process.env.LOCAL_DEMO_INDEXER_API_URL ?? "http://127.0.0.1:8787";
const DEMO_CHAIN_ID = 31337;

async function main() {
  const [owner, protocol] = await ethers.getSigners();

  const MockWNATIVE = await ethers.getContractFactory("MockERC20");
  const wrappedNative = await MockWNATIVE.deploy("Wrapped Native", "WNATIVE");
  await wrappedNative.waitForDeployment();

  const MockFactory = await ethers.getContractFactory("MockDexV2Factory");
  const mockFactory = await MockFactory.deploy();
  await mockFactory.waitForDeployment();

  const MockRouter = await ethers.getContractFactory("MockDexV2Router");
  const mockRouter = await MockRouter.deploy(await mockFactory.getAddress(), await wrappedNative.getAddress());
  await mockRouter.waitForDeployment();

  const StandardDeployer = await ethers.getContractFactory("LaunchTokenDeployer");
  const standardDeployer = await StandardDeployer.deploy();
  await standardDeployer.waitForDeployment();

  const WhitelistDeployer = await ethers.getContractFactory("LaunchTokenWhitelistDeployer");
  const whitelistDeployer = await WhitelistDeployer.deploy();
  await whitelistDeployer.waitForDeployment();

  const TaxedDeployer = await ethers.getContractFactory("LaunchTokenTaxedDeployer");
  const taxedDeployer = await TaxedDeployer.deploy();
  await taxedDeployer.waitForDeployment();

  const WhitelistTaxedDeployer = await ethers.getContractFactory("LaunchCreate2Deployer");
  const whitelistTaxedDeployer = await WhitelistTaxedDeployer.deploy();
  await whitelistTaxedDeployer.waitForDeployment();

  const LaunchFactory = await ethers.getContractFactory("LaunchFactory");
  const launchFactory = await LaunchFactory.deploy(
    owner.address,
    await mockRouter.getAddress(),
    protocol.address,
    await standardDeployer.getAddress(),
    await whitelistDeployer.getAddress(),
    await taxedDeployer.getAddress(),
    await whitelistTaxedDeployer.getAddress(),
    CREATE_FEE,
    CREATE_FEE,
    GRADUATION_TARGET,
    WHITELIST_THRESHOLDS,
    WHITELIST_SLOT_SIZES
  );
  await launchFactory.waitForDeployment();
  await whitelistTaxedDeployer.setFactory(await launchFactory.getAddress());

  const workspaceRoot = path.resolve(__dirname, "../../..");
  const demoDir = path.join(workspaceRoot, ".demo");
  const demoOutputPath = path.join(demoDir, "local-demo.json");
  const webEnvPath = path.join(workspaceRoot, "apps/web/.env.local");
  const indexerEnvPath = path.join(workspaceRoot, "apps/indexer/.env.local");

  const payload = {
    network: "hardhat",
    chainId: DEMO_CHAIN_ID,
    rpcUrl: LOCAL_RPC_URL,
    factory: await launchFactory.getAddress(),
    router: await mockRouter.getAddress(),
    dexFactory: await mockFactory.getAddress(),
    wrappedNative: await wrappedNative.getAddress(),
    owner: owner.address,
    protocolFeeRecipient: protocol.address,
    createFee: ethers.formatEther(CREATE_FEE),
    graduationQuoteReserve: ethers.formatEther(GRADUATION_TARGET),
    generatedAtMs: Date.now()
  };

  const webEnv = [
    `VITE_RPC_URL=${LOCAL_RPC_URL}`,
    `VITE_CHAIN_ID=${DEMO_CHAIN_ID}`,
    `VITE_FACTORY_ADDRESS=${payload.factory}`,
    "VITE_TOKEN_ADDRESS=",
    `VITE_INDEXER_API_URL=${INDEXER_API_URL}`,
    "VITE_INDEXER_SNAPSHOT_URL=/data/indexer-snapshot.json"
  ].join("\n");

  const indexerEnv = [
    `INDEXER_RPC_URL=${LOCAL_RPC_URL}`,
    `INDEXER_CHAIN_ID=${DEMO_CHAIN_ID}`,
    `INDEXER_FACTORY_ADDRESS=${payload.factory}`,
    "INDEXER_LOOKBACK_BLOCKS=50000",
    "INDEXER_LAUNCH_LIMIT=25",
    "INDEXER_ACTIVITY_LIMIT=40",
    "INDEXER_OUTPUT_PATH=../web/public/data/indexer-snapshot.json",
    "INDEXER_PORT=8787",
    "INDEXER_CACHE_TTL_MS=15000"
  ].join("\n");

  await mkdir(demoDir, { recursive: true });
  await writeFile(demoOutputPath, JSON.stringify(payload, null, 2));
  await writeFile(webEnvPath, `${webEnv}\n`);
  await writeFile(indexerEnvPath, `${indexerEnv}\n`);

  console.log(
    JSON.stringify(
      {
        ...payload,
        demoOutputPath,
        webEnvPath,
        indexerEnvPath
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
