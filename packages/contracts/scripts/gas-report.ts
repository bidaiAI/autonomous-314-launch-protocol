import { ethers, network } from "hardhat";

const CREATE_FEE = ethers.parseEther("0.03");
const GRADUATION_TARGET = ethers.parseEther(process.env.GAS_REPORT_GRADUATION_TARGET_NATIVE ?? process.env.GAS_REPORT_GRADUATION_TARGET_BNB ?? "0.2");
const FIRST_BUY = GRADUATION_TARGET / 4n;
const OVERBUY = GRADUATION_TARGET * 5n;

function formatNative(value: bigint) {
  return ethers.formatEther(value);
}

function formatGasCost(gasUsed: bigint, gasPriceGwei: bigint) {
  const gasPriceWei = gasPriceGwei * 10n ** 9n;
  const totalWei = gasUsed * gasPriceWei;
  return `${formatNative(totalWei)} native @ ${gasPriceGwei} gwei`;
}

async function main() {
  const [owner, protocol, creator, trader] = await ethers.getSigners();

  const MockWNATIVE = await ethers.getContractFactory("MockERC20");
  const wbnb = await MockWNATIVE.deploy("Wrapped Native", "WNATIVE");
  await wbnb.waitForDeployment();

  const MockFactory = await ethers.getContractFactory("MockDexV2Factory");
  const mockFactory = await MockFactory.deploy();
  await mockFactory.waitForDeployment();

  const MockRouter = await ethers.getContractFactory("MockDexV2Router");
  const mockRouter = await MockRouter.deploy(await mockFactory.getAddress(), await wbnb.getAddress());
  await mockRouter.waitForDeployment();

  const LaunchFactory = await ethers.getContractFactory("LaunchFactory");
  const launchFactory = await LaunchFactory.deploy(
    owner.address,
    await mockRouter.getAddress(),
    protocol.address,
    CREATE_FEE,
    GRADUATION_TARGET
  );
  await launchFactory.waitForDeployment();

  const factoryDeployReceipt = await launchFactory.deploymentTransaction()?.wait();
  if (!factoryDeployReceipt) {
    throw new Error("Missing factory deployment receipt");
  }

  const createReceipt = await (
    await launchFactory.connect(creator).createLaunch("GasToken", "GAS", "ipfs://gas", {
      value: CREATE_FEE
    })
  ).wait();

  if (!createReceipt) {
    throw new Error("Missing create launch receipt");
  }

  const launchCreatedLog = createReceipt.logs.find((log) => "fragment" in log && log.fragment?.name === "LaunchCreated");
  if (!launchCreatedLog || !("args" in launchCreatedLog)) {
    throw new Error("Missing LaunchCreated log");
  }

  const tokenAddress = launchCreatedLog.args.token as string;
  const launchToken = await ethers.getContractAt("LaunchToken", tokenAddress);

  const firstBuyReceipt = await (
    await launchToken.connect(trader).buy(0, {
      value: FIRST_BUY
    })
  ).wait();
  if (!firstBuyReceipt) {
    throw new Error("Missing first buy receipt");
  }

  await network.provider.send("evm_mine");

  const traderBalance = await launchToken.balanceOf(trader.address);
  const sellAmount = traderBalance / 10n;

  const sellReceipt = await (await launchToken.connect(trader).sell(sellAmount, 0)).wait();
  if (!sellReceipt) {
    throw new Error("Missing sell receipt");
  }

  const graduationReceipt = await (
    await launchToken.connect(trader).buy(0, {
      value: OVERBUY
    })
  ).wait();
  if (!graduationReceipt) {
    throw new Error("Missing graduation buy receipt");
  }

  const rows = [
    { label: "LaunchFactory deploy", gasUsed: factoryDeployReceipt.gasUsed },
    { label: "createLaunch (deploy new launch)", gasUsed: createReceipt.gasUsed },
    { label: `first buy (${ethers.formatEther(FIRST_BUY)} native)`, gasUsed: firstBuyReceipt.gasUsed },
    { label: "sell (10% of balance)", gasUsed: sellReceipt.gasUsed },
    { label: "graduation buy (includes LP mint)", gasUsed: graduationReceipt.gasUsed }
  ];

  console.log("\nAutonomous 314 gas report");
  console.log("====================================");
  console.table(
    rows.map((row) => ({
      operation: row.label,
      gasUsed: row.gasUsed.toString(),
      costAt1Gwei: formatGasCost(row.gasUsed, 1n),
      costAt3Gwei: formatGasCost(row.gasUsed, 3n),
      costAt5Gwei: formatGasCost(row.gasUsed, 5n)
    }))
  );

  console.log("\nNotes:");
  console.log("- createLaunch includes actual LaunchToken deployment through the factory.");
  console.log(`- createLaunch gas does NOT include the separate ${ethers.formatEther(CREATE_FEE)} native create fee economics.`);
  console.log(`- gas report graduation target: ${ethers.formatEther(GRADUATION_TARGET)} native.`);
  console.log("- graduation buy includes the final bonding trade plus graduation + pair mint + LP burn flow.");
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
