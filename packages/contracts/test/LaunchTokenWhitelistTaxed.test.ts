import { expect } from "chai";
import { ethers, network } from "hardhat";

describe("LaunchTokenWhitelistTaxed", function () {
  const GRADUATION_TARGET = ethers.parseEther("12");
  const THRESHOLD = ethers.parseEther("4");
  const SLOT = ethers.parseEther("1");

  async function buildWhitelistTaxedInitCode(params: {
    name: string;
    symbol: string;
    metadataURI: string;
    creator: string;
    factory: string;
    protocolFeeRecipient: string;
    router: string;
    graduationQuoteReserve: bigint;
    whitelistThreshold: bigint;
    whitelistSlotSize: bigint;
    whitelistAddresses: string[];
    taxBps: number;
    burnShareBps: number;
    treasuryShareBps: number;
    treasuryWallet: string;
  }) {
    const WhitelistTaxed = await ethers.getContractFactory("LaunchTokenWhitelistTaxed");
    const deployTx = await WhitelistTaxed.getDeployTransaction({
      name: params.name,
      symbol: params.symbol,
      metadataURI: params.metadataURI,
      creator: params.creator,
      factory: params.factory,
      protocolFeeRecipient: params.protocolFeeRecipient,
      router: params.router,
      graduationQuoteReserve: params.graduationQuoteReserve,
      whitelistThreshold: params.whitelistThreshold,
      whitelistSlotSize: params.whitelistSlotSize,
      whitelistAddresses: params.whitelistAddresses,
      launchModeId: 12,
      taxBps: params.taxBps,
      burnShareBps: params.burnShareBps,
      treasuryShareBps: params.treasuryShareBps,
      treasuryWallet: params.treasuryWallet,
    });

    return deployTx.data!;
  }

  async function deployFixture() {
    const [deployer, creator, protocol, treasury] = await ethers.getSigners();
    const whitelistCommitters = Array.from({ length: 4 }, () => ethers.Wallet.createRandom().connect(ethers.provider));

    for (const wallet of whitelistCommitters) {
      await deployer.sendTransaction({ to: wallet.address, value: ethers.parseEther("5") });
    }

    const [buyer, buyer2, buyer3, buyer4] = whitelistCommitters;

    const MockWNATIVE = await ethers.getContractFactory("MockERC20");
    const wbnb = await MockWNATIVE.deploy("Wrapped Native", "WNATIVE");
    await wbnb.waitForDeployment();

    const MockFactory = await ethers.getContractFactory("MockDexV2Factory");
    const mockFactory = await MockFactory.deploy();
    await mockFactory.waitForDeployment();

    const MockRouter = await ethers.getContractFactory("MockDexV2Router");
    const mockRouter = await MockRouter.deploy(await mockFactory.getAddress(), await wbnb.getAddress());
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

    const GenericDeployer = await ethers.getContractFactory("LaunchCreate2Deployer");
    const whitelistTaxedDeployer = await GenericDeployer.deploy();
    await whitelistTaxedDeployer.waitForDeployment();

    const LaunchFactory = await ethers.getContractFactory("LaunchFactory");
    const launchFactory = await LaunchFactory.deploy(
      creator.address,
      await mockRouter.getAddress(),
      protocol.address,
      await standardDeployer.getAddress(),
      await whitelistDeployer.getAddress(),
      await taxedDeployer.getAddress(),
      await whitelistTaxedDeployer.getAddress(),
      ethers.parseEther("0.01"),
      ethers.parseEther("0.03"),
      GRADUATION_TARGET
    );
    await launchFactory.waitForDeployment();
    await whitelistTaxedDeployer.setFactory(await launchFactory.getAddress());

    const initCode = await buildWhitelistTaxedInitCode({
      name: "WhitelistTax314",
      symbol: "F314",
      metadataURI: "ipfs://f314",
      creator: creator.address,
      factory: await launchFactory.getAddress(),
      protocolFeeRecipient: protocol.address,
      router: await mockRouter.getAddress(),
      graduationQuoteReserve: GRADUATION_TARGET,
      whitelistThreshold: THRESHOLD,
      whitelistSlotSize: SLOT,
      whitelistAddresses: whitelistCommitters.map((wallet) => wallet.address),
      taxBps: 500,
      burnShareBps: 5000,
      treasuryShareBps: 5000,
      treasuryWallet: treasury.address,
    });

    const tx = await launchFactory.connect(creator).createWhitelistTaxLaunch(
      "WhitelistTax314",
      "F314",
      "ipfs://f314",
      {
        whitelistThreshold: THRESHOLD,
        whitelistSlotSize: SLOT,
        whitelistAddresses: whitelistCommitters.map((wallet) => wallet.address),
      },
      {
        taxBps: 500,
        burnShareBps: 5000,
        treasuryShareBps: 5000,
        treasuryWallet: treasury.address,
      },
      initCode,
      { value: ethers.parseEther("0.03") }
    );
    const receipt = await tx.wait();
    const tokenAddress = receipt!.logs.find((log) => "fragment" in log && log.fragment?.name === "LaunchCreated")!.args
      .token as string;
    const token = await ethers.getContractAt("LaunchTokenWhitelistTaxed", tokenAddress);

    const pairAddress = await token.pair();
    const pair = await ethers.getContractAt("MockDexV2Pair", pairAddress);

    return { deployer, buyer, buyer2, buyer3, buyer4, treasury, token, pair };
  }

  it("does not apply transfer tax during whitelist allocation claims", async function () {
    const { buyer, buyer2, buyer3, buyer4, treasury, token } = await deployFixture();
    const dead = "0x000000000000000000000000000000000000dEaD";

    await buyer.sendTransaction({ to: await token.getAddress(), value: SLOT });
    await buyer2.sendTransaction({ to: await token.getAddress(), value: SLOT });
    await buyer3.sendTransaction({ to: await token.getAddress(), value: SLOT });
    await buyer4.sendTransaction({ to: await token.getAddress(), value: SLOT });

    expect(await token.state()).to.equal(1n);

    const deadBefore = await token.balanceOf(dead);
    const treasuryBefore = await token.balanceOf(treasury.address);

    await token.connect(buyer).claimWhitelistAllocation();

    expect(await token.balanceOf(dead)).to.equal(deadBefore);
    expect(await token.balanceOf(treasury.address)).to.equal(treasuryBefore);
  });

  it("applies tax only after graduation when transferring to the pair", async function () {
    const { deployer, buyer, buyer2, buyer3, buyer4, treasury, token, pair } = await deployFixture();
    const dead = "0x000000000000000000000000000000000000dEaD";

    await buyer.sendTransaction({ to: await token.getAddress(), value: SLOT });
    await buyer2.sendTransaction({ to: await token.getAddress(), value: SLOT });
    await buyer3.sendTransaction({ to: await token.getAddress(), value: SLOT });
    await buyer4.sendTransaction({ to: await token.getAddress(), value: SLOT });
    await token.connect(buyer).claimWhitelistAllocation();

    await deployer.sendTransaction({ to: buyer.address, value: ethers.parseEther("20") });
    await token.connect(buyer).buy(0, { value: ethers.parseEther("20") });
    expect(await token.state()).to.equal(3n);

    const sellAmount = (await token.balanceOf(buyer.address)) / 10n;
    const deadBefore = await token.balanceOf(dead);
    const treasuryBefore = await token.balanceOf(treasury.address);

    await token.connect(buyer).transfer(await pair.getAddress(), sellAmount);

    const expectedTax = sellAmount * 500n / 10_000n;
    const expectedBurn = expectedTax / 2n;
    const expectedTreasury = expectedTax - expectedBurn;

    expect(await token.balanceOf(dead)).to.equal(deadBefore + expectedBurn);
    expect(await token.balanceOf(treasury.address)).to.equal(treasuryBefore + expectedTreasury);
  });
});
