import { expect } from "chai";
import { ethers } from "hardhat";

function buildStandardArgs(
  creator: string,
  factory: string,
  protocolFeeRecipient: string,
  router: string,
  graduationQuoteReserve: bigint,
  launchModeId = 1,
  name = "Vanity",
  symbol = "VAN",
  metadataURI = "ipfs://vanity"
) {
  return {
    name,
    symbol,
    metadataURI,
    creator,
    factory,
    protocolFeeRecipient,
    router,
    graduationQuoteReserve,
    launchModeId,
  };
}

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
  whitelistOpensAt?: bigint;
  whitelistAddresses: string[];
  launchModeId?: number;
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
    whitelistOpensAt: params.whitelistOpensAt ?? 0n,
    whitelistAddresses: params.whitelistAddresses,
    launchModeId: params.launchModeId ?? 12,
    taxBps: params.taxBps,
    burnShareBps: params.burnShareBps,
    treasuryShareBps: params.treasuryShareBps,
    treasuryWallet: params.treasuryWallet,
  });

  return deployTx.data!;
}

async function latestTimestamp() {
  const block = await ethers.provider.getBlock("latest");
  return BigInt(block?.timestamp ?? 0);
}

describe("LaunchFactory", function () {
  const STANDARD_CREATE_FEE = ethers.parseEther("0.01");
  const WHITELIST_CREATE_FEE = ethers.parseEther("0.03");
  const GRADUATION_TARGET = ethers.parseEther("12");
  const DEFAULT_PROTOCOL_FEE_RECIPIENT = "0xC4187bE6b362DF625696d4a9ec5E6FA461CC0314";
  const BSC_WHITELIST_THRESHOLDS = [ethers.parseEther("4"), ethers.parseEther("6"), ethers.parseEther("8")];
  const BSC_WHITELIST_SLOT_SIZES = [
    ethers.parseEther("0.1"),
    ethers.parseEther("0.2"),
    ethers.parseEther("0.5"),
    ethers.parseEther("1")
  ];
  const BASE_WHITELIST_THRESHOLDS = [ethers.parseEther("1"), ethers.parseEther("2"), ethers.parseEther("3")];
  const BASE_WHITELIST_SLOT_SIZES = [
    ethers.parseEther("0.04"),
    ethers.parseEther("0.1"),
    ethers.parseEther("0.2"),
    ethers.parseEther("0.5")
  ];

  async function deployFixture(options?: {
    standardCreateFee?: bigint;
    whitelistCreateFee?: bigint;
    graduationTarget?: bigint;
    whitelistThresholdPresets?: bigint[];
    whitelistSlotSizePresets?: bigint[];
  }) {
    const [owner, protocol, creator, treasury] = await ethers.getSigners();
    const standardCreateFee = options?.standardCreateFee ?? STANDARD_CREATE_FEE;
    const whitelistCreateFee = options?.whitelistCreateFee ?? WHITELIST_CREATE_FEE;
    const graduationTarget = options?.graduationTarget ?? GRADUATION_TARGET;
    const whitelistThresholdPresets = options?.whitelistThresholdPresets ?? BSC_WHITELIST_THRESHOLDS;
    const whitelistSlotSizePresets = options?.whitelistSlotSizePresets ?? BSC_WHITELIST_SLOT_SIZES;

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
      standardCreateFee,
      whitelistCreateFee,
      graduationTarget,
      whitelistThresholdPresets,
      whitelistSlotSizePresets
    );
    await launchFactory.waitForDeployment();
    await whitelistTaxedDeployer.setFactory(await launchFactory.getAddress());

    return {
      owner,
      protocol,
      creator,
      treasury,
      wbnb,
      mockFactory,
      mockRouter,
      standardDeployer,
      whitelistDeployer,
      taxedDeployer,
      whitelistTaxedDeployer,
      launchFactory,
    };
  }

  it("deploys with basic configuration", async function () {
    const {
      protocol,
      mockRouter,
      standardDeployer,
      whitelistDeployer,
      taxedDeployer,
      whitelistTaxedDeployer,
      launchFactory,
    } = await deployFixture();

    expect(await launchFactory.router()).to.equal(await mockRouter.getAddress());
    expect(await launchFactory.protocolFeeRecipient()).to.equal(protocol.address);
    expect(await launchFactory.graduationQuoteReserve()).to.equal(GRADUATION_TARGET);
    expect(await launchFactory.standardDeployer()).to.equal(await standardDeployer.getAddress());
    expect(await launchFactory.whitelistDeployer()).to.equal(await whitelistDeployer.getAddress());
    expect(await launchFactory.taxedDeployer()).to.equal(await taxedDeployer.getAddress());
    expect(await launchFactory.whitelistTaxedDeployer()).to.equal(await whitelistTaxedDeployer.getAddress());
    expect(await launchFactory.createFee()).to.equal(STANDARD_CREATE_FEE);
    expect(await launchFactory.createFeeForMode(0)).to.equal(0n);
    expect(await launchFactory.createFeeForMode(1)).to.equal(STANDARD_CREATE_FEE);
    expect(await launchFactory.createFeeForMode(2)).to.equal(WHITELIST_CREATE_FEE);
    expect(await launchFactory.createFeeForMode(3)).to.equal(STANDARD_CREATE_FEE);
    expect(await launchFactory.createFeeForMode(11)).to.equal(STANDARD_CREATE_FEE);
    expect(await launchFactory.createFeeForMode(12)).to.equal(WHITELIST_CREATE_FEE);
    expect(await launchFactory.isAllowedWhitelistThreshold(ethers.parseEther("4"))).to.equal(true);
    expect(await launchFactory.isAllowedWhitelistSlotSize(ethers.parseEther("0.1"))).to.equal(true);
  });

  it("supports a base-style whitelist preset profile without changing BSC defaults", async function () {
    const { launchFactory, creator, mockRouter, standardDeployer, whitelistDeployer, taxedDeployer, whitelistTaxedDeployer } =
      await deployFixture({
        standardCreateFee: ethers.parseEther("0.005"),
        whitelistCreateFee: ethers.parseEther("0.01"),
        graduationTarget: ethers.parseEther("4"),
        whitelistThresholdPresets: BASE_WHITELIST_THRESHOLDS,
        whitelistSlotSizePresets: BASE_WHITELIST_SLOT_SIZES
      });

    expect(await launchFactory.createFee()).to.equal(ethers.parseEther("0.005"));
    expect(await launchFactory.createFeeForMode(2)).to.equal(ethers.parseEther("0.01"));
    expect(await launchFactory.graduationQuoteReserve()).to.equal(ethers.parseEther("4"));
    expect(await launchFactory.router()).to.equal(await mockRouter.getAddress());
    expect(await launchFactory.isAllowedWhitelistThreshold(ethers.parseEther("1"))).to.equal(true);
    expect(await launchFactory.isAllowedWhitelistThreshold(ethers.parseEther("3"))).to.equal(true);
    expect(await launchFactory.isAllowedWhitelistThreshold(ethers.parseEther("4"))).to.equal(false);
    expect(await launchFactory.isAllowedWhitelistSlotSize(ethers.parseEther("0.04"))).to.equal(true);
    expect(await launchFactory.isAllowedWhitelistSlotSize(ethers.parseEther("0.5"))).to.equal(true);
    expect(await launchFactory.isAllowedWhitelistSlotSize(ethers.parseEther("0.02"))).to.equal(false);

    const whitelistAddresses = Array.from({ length: 25 }, () => ethers.Wallet.createRandom().address);
    const tx = await launchFactory.connect(creator).createWhitelistLaunch(
      "Base Seats",
      "BSEAT",
      "ipfs://base-seats",
      ethers.parseEther("1"),
      ethers.parseEther("0.04"),
      0,
      whitelistAddresses,
      { value: ethers.parseEther("0.01") }
    );
    const receipt = await tx.wait();
    const launchCreatedLog = receipt!.logs.find((log) => "fragment" in log && log.fragment?.name === "LaunchCreated");
    expect(launchCreatedLog).to.not.equal(undefined);
    expect(await launchFactory.whitelistDeployer()).to.equal(await whitelistDeployer.getAddress());
    expect(await launchFactory.standardDeployer()).to.equal(await standardDeployer.getAddress());
    expect(await launchFactory.taxedDeployer()).to.equal(await taxedDeployer.getAddress());
    expect(await launchFactory.whitelistTaxedDeployer()).to.equal(await whitelistTaxedDeployer.getAddress());
  });

  it("falls back to the default protocol fee recipient when zero is passed", async function () {
    const [owner] = await ethers.getSigners();

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
      ethers.ZeroAddress,
      await standardDeployer.getAddress(),
      await whitelistDeployer.getAddress(),
      await taxedDeployer.getAddress(),
      await whitelistTaxedDeployer.getAddress(),
      STANDARD_CREATE_FEE,
      WHITELIST_CREATE_FEE,
      GRADUATION_TARGET,
      BSC_WHITELIST_THRESHOLDS,
      BSC_WHITELIST_SLOT_SIZES
    );
    await launchFactory.waitForDeployment();
    await whitelistTaxedDeployer.setFactory(await launchFactory.getAddress());

    expect(await launchFactory.protocolFeeRecipient()).to.equal(DEFAULT_PROTOCOL_FEE_RECIPIENT);
    expect(await launchFactory.DEFAULT_PROTOCOL_FEE_RECIPIENT()).to.equal(DEFAULT_PROTOCOL_FEE_RECIPIENT);
  });

  it("reconciles forced native into protocol create fees", async function () {
    const { creator, launchFactory, protocol } = await deployFixture();

    const ForceSend = await ethers.getContractFactory("ForceSend");
    const forceSend = await ForceSend.deploy({ value: ethers.parseEther("0.15") });
    await forceSend.waitForDeployment();
    await forceSend.boom(await launchFactory.getAddress());

    await expect(launchFactory.connect(creator).reconcileUnexpectedNative())
      .to.emit(launchFactory, "UnexpectedNativeReconciled")
      .withArgs(creator.address, ethers.parseEther("0.15"));

    expect(await launchFactory.accruedProtocolCreateFees()).to.equal(ethers.parseEther("0.15"));

    const recipientBalanceBefore = await ethers.provider.getBalance(creator.address);
    await launchFactory.connect(protocol).claimProtocolCreateFeesTo(creator.address);
    expect(await ethers.provider.getBalance(creator.address)).to.equal(recipientBalanceBefore + ethers.parseEther("0.15"));
    expect(await launchFactory.accruedProtocolCreateFees()).to.equal(0n);
  });

  it("lets support deployers recover forced native to their immutable owner", async function () {
    const { creator, owner, standardDeployer, whitelistDeployer, taxedDeployer, whitelistTaxedDeployer } =
      await deployFixture();

    const ForceSend = await ethers.getContractFactory("ForceSend");
    const deployers = [standardDeployer, whitelistDeployer, taxedDeployer, whitelistTaxedDeployer];
    const amounts = [
      ethers.parseEther("0.01"),
      ethers.parseEther("0.02"),
      ethers.parseEther("0.03"),
      ethers.parseEther("0.04"),
    ];

    for (let i = 0; i < deployers.length; i += 1) {
      const deployerContract = deployers[i];
      const amount = amounts[i];
      const forceSend = await ForceSend.deploy({ value: amount });
      await forceSend.waitForDeployment();
      await forceSend.boom(await deployerContract.getAddress());

      const ownerBalanceBefore = await ethers.provider.getBalance(owner.address);
      await deployerContract.connect(creator).recoverUnexpectedNative();

      expect(await ethers.provider.getBalance(owner.address)).to.equal(ownerBalanceBefore + amount);
      expect(await ethers.provider.getBalance(await deployerContract.getAddress())).to.equal(0n);
    }
  });

  it("creates standard launches and records creator ownership", async function () {
    const { creator, launchFactory } = await deployFixture();

    const tx = await launchFactory.connect(creator).createLaunch("Alpha", "ALP", "ipfs://alpha", {
      value: STANDARD_CREATE_FEE,
    });
    const receipt = await tx.wait();
    const launchEvent = receipt!.logs.find((log) => "fragment" in log && log.fragment?.name === "LaunchCreated");
    const tokenAddress = launchEvent!.args.token;

    expect(await launchFactory.totalLaunches()).to.equal(1n);
    expect((await launchFactory.launchesOf(creator.address))[0]).to.equal(tokenAddress);
    expect(await launchFactory.accruedProtocolCreateFees()).to.equal(STANDARD_CREATE_FEE);
    expect(await launchFactory.modeOf(tokenAddress)).to.equal(1n);
    expect(launchEvent!.args.mode).to.equal(1n);
  });

  it("creates whitelist launches and charges the whitelist create fee", async function () {
    const { creator, launchFactory } = await deployFixture();
    const whitelist = Array.from({ length: 20 }, (_, i) => ethers.Wallet.createRandom().address);

    const tx = await launchFactory
      .connect(creator)
      .createWhitelistLaunch(
        "Beta",
        "BETA",
        "ipfs://beta",
        ethers.parseEther("4"),
        ethers.parseEther("0.2"),
        0,
        whitelist,
        {
          value: WHITELIST_CREATE_FEE,
        }
      );
    const receipt = await tx.wait();
    const launchEvent = receipt!.logs.find((log) => "fragment" in log && log.fragment?.name === "LaunchCreated");
    const tokenAddress = launchEvent!.args.token;

    expect(await launchFactory.totalLaunches()).to.equal(1n);
    expect(await launchFactory.modeOf(tokenAddress)).to.equal(2n);
    expect(await launchFactory.accruedProtocolCreateFees()).to.equal(WHITELIST_CREATE_FEE);
  });

  it("creates taxed standard launches and records the tax mode", async function () {
    const { creator, launchFactory } = await deployFixture();

    const tx = await launchFactory
      .connect(creator)
      .createTaxLaunch("TaxOne", "T1", "ipfs://tax-one", 100, 4000, 6000, creator.address, {
        value: STANDARD_CREATE_FEE,
      });
    const receipt = await tx.wait();
    const launchEvent = receipt!.logs.find((log) => "fragment" in log && log.fragment?.name === "LaunchCreated");
    const tokenAddress = launchEvent!.args.token as string;
    const token = await ethers.getContractAt("LaunchTokenTaxed", tokenAddress);

    expect(await launchFactory.modeOf(tokenAddress)).to.equal(3n);
    expect(await token.launchSuffix()).to.equal("1314");
    expect(await token.taxConfig()).to.deep.equal([true, 100n, 4000n, 6000n, creator.address, false]);
  });

  it("creates whitelist taxed launches via raw init code and records f314 mode", async function () {
    const { creator, protocol, mockRouter, launchFactory } = await deployFixture();
    const whitelist = Array.from({ length: 20 }, (_, i) => ethers.Wallet.createRandom().address);
    const initCode = await buildWhitelistTaxedInitCode({
      name: "FlexWhitelist",
      symbol: "F314",
      metadataURI: "ipfs://f314",
      creator: creator.address,
      factory: await launchFactory.getAddress(),
      protocolFeeRecipient: protocol.address,
      router: await mockRouter.getAddress(),
      graduationQuoteReserve: GRADUATION_TARGET,
      whitelistThreshold: ethers.parseEther("4"),
      whitelistSlotSize: ethers.parseEther("0.2"),
      whitelistOpensAt: 0n,
      whitelistAddresses: whitelist,
      taxBps: 500,
      burnShareBps: 3000,
      treasuryShareBps: 7000,
      treasuryWallet: creator.address,
    });
    const tx = await launchFactory.connect(creator).createWhitelistTaxLaunch(
      "FlexWhitelist",
      "F314",
      "ipfs://f314",
      {
        whitelistThreshold: ethers.parseEther("4"),
        whitelistSlotSize: ethers.parseEther("0.2"),
        whitelistOpensAt: 0,
        whitelistAddresses: whitelist,
      },
      {
        taxBps: 500,
        burnShareBps: 3000,
        treasuryShareBps: 7000,
        treasuryWallet: creator.address,
      },
      initCode,
      { value: WHITELIST_CREATE_FEE }
    );
    const receipt = await tx.wait();
    const launchEvent = receipt!.logs.find((log) => "fragment" in log && log.fragment?.name === "LaunchCreated");
    const tokenAddress = launchEvent!.args.token as string;
    const token = await ethers.getContractAt("LaunchTokenWhitelistTaxed", tokenAddress);

    expect(await launchFactory.modeOf(tokenAddress)).to.equal(12n);
    expect(await token.launchSuffix()).to.equal("f314");
    expect(await token.taxConfig()).to.deep.equal([true, 500n, 3000n, 7000n, creator.address, false]);
  });

  it("rejects invalid taxed launch configurations", async function () {
    const { creator, launchFactory } = await deployFixture();

    await expect(
      launchFactory
        .connect(creator)
        .createTaxLaunch("BadSplit", "BAD", "ipfs://bad-split", 100, 4000, 5000, creator.address, {
          value: STANDARD_CREATE_FEE,
        })
    ).to.be.revertedWithCustomError(launchFactory, "InvalidTaxConfig");

    await expect(
      launchFactory
        .connect(creator)
        .createTaxLaunch("MissingTreasury", "BAD", "ipfs://bad-wallet", 100, 5000, 5000, ethers.ZeroAddress, {
          value: STANDARD_CREATE_FEE,
        })
    ).to.be.revertedWithCustomError(launchFactory, "InvalidTaxConfig");

    await expect(
      launchFactory
        .connect(creator)
        .createTaxLaunch("BurnOnlyWallet", "BAD", "ipfs://bad-burn", 100, 10000, 0, creator.address, {
          value: STANDARD_CREATE_FEE,
        })
    ).to.be.revertedWithCustomError(launchFactory, "InvalidTaxConfig");

    await expect(
      launchFactory
        .connect(creator)
        .createTaxLaunch("DeadTreasury", "BAD", "ipfs://bad-dead", 100, 5000, 5000, "0x000000000000000000000000000000000000dEaD", {
          value: STANDARD_CREATE_FEE,
        })
    ).to.be.revertedWithCustomError(launchFactory, "InvalidTaxConfig");
  });

  it("creates a standard launch and atomically buys for the creator", async function () {
    const { creator, launchFactory } = await deployFixture();

    const tx = await launchFactory.connect(creator).createLaunchAndBuy("Atomic", "ATM", "ipfs://atomic", 0, {
      value: STANDARD_CREATE_FEE + ethers.parseEther("0.1"),
    });
    const receipt = await tx.wait();
    const launchEvent = receipt!.logs.find((log) => "fragment" in log && log.fragment?.name === "LaunchCreated");
    const tokenAddress = launchEvent!.args.token as string;
    const token = await ethers.getContractAt("LaunchToken", tokenAddress);

    expect(await token.balanceOf(creator.address)).to.be.gt(0n);
    expect(await token.lastBuyBlock(creator.address)).to.equal(BigInt(receipt!.blockNumber));
    expect(await launchFactory.accruedProtocolCreateFees()).to.equal(STANDARD_CREATE_FEE);
  });

  it("creates a taxed launch with salt and atomically buys for the creator", async function () {
    const { creator, launchFactory, treasury } = await deployFixture();
    const salt = ethers.keccak256(ethers.toUtf8Bytes("tax-atomic-with-salt"));

    const tx = await launchFactory.connect(creator).createTaxLaunchAndBuyWithSalt(
      "TaxAtomic",
      "T5314",
      "ipfs://tax-atomic",
      500,
      4000,
      6000,
      treasury.address,
      salt,
      0,
      {
        value: STANDARD_CREATE_FEE + ethers.parseEther("0.2"),
      }
    );
    const receipt = await tx.wait();
    const launchEvent = receipt!.logs.find((log) => "fragment" in log && log.fragment?.name === "LaunchCreated");
    const tokenAddress = launchEvent!.args.token as string;
    const token = await ethers.getContractAt("LaunchTokenTaxed", tokenAddress);
    const pair = await ethers.getContractAt("MockDexV2Pair", await token.pair());

    expect(await token.launchSuffix()).to.equal("5314");
    expect(await token.balanceOf(creator.address)).to.be.gt(0n);
    expect(await token.lastBuyBlock(creator.address)).to.equal(BigInt(receipt!.blockNumber));

    await token.connect(creator).buy(0, { value: ethers.parseEther("20") });
    expect(await token.state()).to.equal(3n);

    const sellAmount = (await token.balanceOf(creator.address)) / 10n;
    const treasuryBefore = await token.balanceOf(treasury.address);
    const deadBefore = await token.balanceOf("0x000000000000000000000000000000000000dEaD");
    await token.connect(creator).transfer(await pair.getAddress(), sellAmount);

    const expectedTax = sellAmount * 500n / 10_000n;
    const expectedBurn = expectedTax * 4000n / 10_000n;
    const expectedTreasury = expectedTax - expectedBurn;

    expect(await token.balanceOf(treasury.address)).to.equal(treasuryBefore + expectedTreasury);
    expect(await token.balanceOf("0x000000000000000000000000000000000000dEaD")).to.equal(deadBefore + expectedBurn);
  });

  it("requires non-zero atomic buy value after the standard create fee", async function () {
    const { creator, launchFactory } = await deployFixture();

    await expect(
      launchFactory.connect(creator).createLaunchAndBuy("Atomic", "ATM", "ipfs://atomic", 0, {
        value: STANDARD_CREATE_FEE,
      })
    ).to.be.revertedWithCustomError(launchFactory, "MissingAtomicBuyValue");
  });

  it("creates a whitelist launch and atomically commits the creator seat", async function () {
    const { creator, launchFactory } = await deployFixture();
    const whitelist = [creator.address, ...Array.from({ length: 19 }, () => ethers.Wallet.createRandom().address)];

    const tx = await launchFactory.connect(creator).createWhitelistLaunchAndCommit(
      "Whitelist",
      "WLT",
      "ipfs://wlt",
      ethers.parseEther("4"),
      ethers.parseEther("0.2"),
      0,
      whitelist,
      {
        value: WHITELIST_CREATE_FEE + ethers.parseEther("0.2"),
      }
    );
    const receipt = await tx.wait();
    const launchEvent = receipt!.logs.find((log) => "fragment" in log && log.fragment?.name === "LaunchCreated");
    const tokenAddress = launchEvent!.args.token as string;
    const token = await ethers.getContractAt("LaunchTokenWhitelist", tokenAddress);

    expect(await token.whitelistSeatCommitted(creator.address)).to.equal(true);
    expect(await token.whitelistSeatsFilled()).to.equal(1n);
    expect(await token.whitelistCommittedTotal()).to.equal(ethers.parseEther("0.2"));
    expect(await launchFactory.accruedProtocolCreateFees()).to.equal(WHITELIST_CREATE_FEE);
  });

  it("creates an f314 launch with salt, atomically commits the creator seat, and reaches taxed post-grad flow", async function () {
    const { owner, creator, protocol, treasury, mockRouter, launchFactory } = await deployFixture();
    const seatWallets = Array.from({ length: 3 }, () => ethers.Wallet.createRandom().connect(ethers.provider));
    for (const wallet of seatWallets) {
      await owner.sendTransaction({ to: wallet.address, value: ethers.parseEther("5") });
    }
    const whitelist = [creator.address, ...seatWallets.map((wallet) => wallet.address)];
    const salt = ethers.keccak256(ethers.toUtf8Bytes("f314-atomic-seat"));
    const initCode = await buildWhitelistTaxedInitCode({
      name: "FlexAtomic",
      symbol: "F314",
      metadataURI: "ipfs://flex-atomic",
      creator: creator.address,
      factory: await launchFactory.getAddress(),
      protocolFeeRecipient: protocol.address,
      router: await mockRouter.getAddress(),
      graduationQuoteReserve: GRADUATION_TARGET,
      whitelistThreshold: ethers.parseEther("4"),
      whitelistSlotSize: ethers.parseEther("1"),
      whitelistOpensAt: 0n,
      whitelistAddresses: whitelist,
      taxBps: 500,
      burnShareBps: 5000,
      treasuryShareBps: 5000,
      treasuryWallet: treasury.address,
    });

    const tx = await launchFactory.connect(creator).createWhitelistTaxLaunchAndCommitWithSalt(
      "FlexAtomic",
      "F314",
      "ipfs://flex-atomic",
      {
        whitelistThreshold: ethers.parseEther("4"),
        whitelistSlotSize: ethers.parseEther("1"),
        whitelistOpensAt: 0,
        whitelistAddresses: whitelist,
      },
      {
        taxBps: 500,
        burnShareBps: 5000,
        treasuryShareBps: 5000,
        treasuryWallet: treasury.address,
      },
      initCode,
      salt,
      { value: WHITELIST_CREATE_FEE + ethers.parseEther("1") }
    );
    const receipt = await tx.wait();
    const launchEvent = receipt!.logs.find((log) => "fragment" in log && log.fragment?.name === "LaunchCreated");
    const tokenAddress = launchEvent!.args.token as string;
    const token = await ethers.getContractAt("LaunchTokenWhitelistTaxed", tokenAddress);
    const pair = await ethers.getContractAt("MockDexV2Pair", await token.pair());

    expect(await token.launchSuffix()).to.equal("f314");
    expect(await token.whitelistSeatCommitted(creator.address)).to.equal(true);
    expect(await token.whitelistSeatsFilled()).to.equal(1n);

    for (const wallet of seatWallets) {
      await wallet.sendTransaction({ to: tokenAddress, value: ethers.parseEther("1") });
    }

    expect(await token.state()).to.equal(1n);
    await token.connect(creator).claimWhitelistAllocation();
    expect(await token.balanceOf(creator.address)).to.be.gt(0n);

    await token.connect(creator).buy(0, { value: ethers.parseEther("20") });
    expect(await token.state()).to.equal(3n);

    const sellAmount = (await token.balanceOf(creator.address)) / 10n;
    const treasuryBefore = await token.balanceOf(treasury.address);
    const deadBefore = await token.balanceOf("0x000000000000000000000000000000000000dEaD");
    await token.connect(creator).transfer(await pair.getAddress(), sellAmount);

    const expectedTax = sellAmount * 500n / 10_000n;
    const expectedBurn = expectedTax / 2n;
    const expectedTreasury = expectedTax - expectedBurn;

    expect(await token.balanceOf(treasury.address)).to.equal(treasuryBefore + expectedTreasury);
    expect(await token.balanceOf("0x000000000000000000000000000000000000dEaD")).to.equal(deadBefore + expectedBurn);
  });

  it("requires exact slot funding for atomic whitelist commit", async function () {
    const { creator, launchFactory } = await deployFixture();
    const whitelist = [creator.address, ...Array.from({ length: 19 }, () => ethers.Wallet.createRandom().address)];

    await expect(
      launchFactory.connect(creator).createWhitelistLaunchAndCommit(
      "Whitelist",
      "WLT",
      "ipfs://wlt",
      ethers.parseEther("4"),
      ethers.parseEther("0.2"),
      0,
      whitelist,
      {
        value: WHITELIST_CREATE_FEE + ethers.parseEther("0.1"),
        }
      )
    ).to.be.revertedWithCustomError(launchFactory, "InvalidWhitelistAtomicCommitAmount");
  });

  it("blocks direct deployer calls that spoof the official factory", async function () {
    const { creator, protocol, mockRouter, launchFactory, standardDeployer, whitelistDeployer } = await deployFixture();

    await expect(
      standardDeployer.connect(creator).deploy({
        name: "Spoof",
        symbol: "SPF",
        metadataURI: "ipfs://spoof",
        creator: creator.address,
        factory: await launchFactory.getAddress(),
        protocolFeeRecipient: protocol.address,
        router: await mockRouter.getAddress(),
        graduationQuoteReserve: GRADUATION_TARGET,
        launchModeId: 1,
        salt: ethers.keccak256(ethers.toUtf8Bytes("spoof-standard")),
      })
    ).to.be.revertedWithCustomError(standardDeployer, "Unauthorized");

    await expect(
      whitelistDeployer.connect(creator).deploy({
        name: "SpoofWL",
        symbol: "SWL",
        metadataURI: "ipfs://spoof-wl",
        creator: creator.address,
        factory: await launchFactory.getAddress(),
        protocolFeeRecipient: protocol.address,
        router: await mockRouter.getAddress(),
        graduationQuoteReserve: GRADUATION_TARGET,
        whitelistThreshold: ethers.parseEther("4"),
        whitelistSlotSize: ethers.parseEther("0.2"),
        whitelistOpensAt: 0,
        whitelistAddresses: Array.from({ length: 20 }, () => ethers.Wallet.createRandom().address),
        launchModeId: 2,
        salt: ethers.keccak256(ethers.toUtf8Bytes("spoof-whitelist")),
      })
    ).to.be.revertedWithCustomError(whitelistDeployer, "Unauthorized");
  });

  it("blocks direct token deployments that spoof the official factory address", async function () {
    const { creator, protocol, mockRouter, launchFactory } = await deployFixture();
    const LaunchToken = await ethers.getContractFactory("LaunchToken");
    const LaunchTokenWhitelist = await ethers.getContractFactory("LaunchTokenWhitelist");

    await expect(
      LaunchToken.connect(creator).deploy({
        name: "Spoof",
        symbol: "SPF",
        metadataURI: "ipfs://spoof",
        creator: creator.address,
        factory: await launchFactory.getAddress(),
        protocolFeeRecipient: protocol.address,
        router: await mockRouter.getAddress(),
        graduationQuoteReserve: GRADUATION_TARGET,
        launchModeId: 1,
      })
    ).to.be.revertedWithCustomError(LaunchToken, "UnauthorizedFactoryDeployment");

    await expect(
      LaunchTokenWhitelist.connect(creator).deploy({
        name: "SpoofWL",
        symbol: "SWL",
        metadataURI: "ipfs://spoof-wl",
        creator: creator.address,
        factory: await launchFactory.getAddress(),
        protocolFeeRecipient: protocol.address,
        router: await mockRouter.getAddress(),
        graduationQuoteReserve: GRADUATION_TARGET,
        whitelistThreshold: ethers.parseEther("4"),
        whitelistSlotSize: ethers.parseEther("0.2"),
        whitelistOpensAt: 0,
        whitelistAddresses: Array.from({ length: 20 }, () => ethers.Wallet.createRandom().address),
        launchModeId: 2,
      })
    ).to.be.revertedWithCustomError(LaunchTokenWhitelist, "UnauthorizedFactoryDeployment");
  });

  it("supports delayed whitelist open for b314 and exposes scheduled state", async function () {
    const { creator, launchFactory } = await deployFixture();
    const whitelist = Array.from({ length: 20 }, (_, i) =>
      i === 0 ? creator.address : ethers.Wallet.createRandom().address
    );
    const opensAt = (await latestTimestamp()) + 2n * 60n * 60n;

    const tx = await launchFactory
      .connect(creator)
      .createWhitelistLaunch(
        "DelayedBeta",
        "DBETA",
        "ipfs://delayed-beta",
        ethers.parseEther("4"),
        ethers.parseEther("0.2"),
        opensAt,
        whitelist,
        { value: WHITELIST_CREATE_FEE }
      );
    const receipt = await tx.wait();
    const tokenAddress = receipt!.logs.find((log) => "fragment" in log && log.fragment?.name === "LaunchCreated")!.args
      .token as string;
    const token = await ethers.getContractAt("LaunchTokenWhitelist", tokenAddress);
    const snapshot = await token.whitelistSnapshot();

    expect(await token.whitelistStatus()).to.equal(1n);
    expect(snapshot.opensAt).to.equal(opensAt);
    expect(snapshot.deadline).to.equal(opensAt + 24n * 60n * 60n);
    expect(await token.canCommitWhitelist(creator.address)).to.equal(false);
  });

  it("rejects delayed atomic whitelist commit for b314", async function () {
    const { creator, launchFactory } = await deployFixture();
    const whitelist = [creator.address, ...Array.from({ length: 19 }, () => ethers.Wallet.createRandom().address)];
    const opensAt = (await latestTimestamp()) + 2n * 60n * 60n;

    await expect(
      launchFactory.connect(creator).createWhitelistLaunchAndCommit(
        "DelayedSeat",
        "DSEAT",
        "ipfs://delayed-seat",
        ethers.parseEther("4"),
        ethers.parseEther("0.2"),
        opensAt,
        whitelist,
        {
          value: WHITELIST_CREATE_FEE + ethers.parseEther("0.2"),
        }
      )
    ).to.be.revertedWithCustomError(launchFactory, "DelayedWhitelistAtomicCommitUnsupported");
  });

  it("supports delayed whitelist open for f314 and rejects delayed atomic seat commit", async function () {
    const { creator, protocol, treasury, mockRouter, launchFactory } = await deployFixture();
    const whitelist = Array.from({ length: 20 }, (_, i) =>
      i === 0 ? creator.address : ethers.Wallet.createRandom().address
    );
    const opensAt = (await latestTimestamp()) + 2n * 60n * 60n;
    const initCode = await buildWhitelistTaxedInitCode({
      name: "FlexScheduled",
      symbol: "F314",
      metadataURI: "ipfs://f314-scheduled",
      creator: creator.address,
      factory: await launchFactory.getAddress(),
      protocolFeeRecipient: protocol.address,
      router: await mockRouter.getAddress(),
      graduationQuoteReserve: GRADUATION_TARGET,
      whitelistThreshold: ethers.parseEther("4"),
      whitelistSlotSize: ethers.parseEther("0.2"),
      whitelistOpensAt: opensAt,
      whitelistAddresses: whitelist,
      taxBps: 500,
      burnShareBps: 5000,
      treasuryShareBps: 5000,
      treasuryWallet: treasury.address,
    });

    const tx = await launchFactory.connect(creator).createWhitelistTaxLaunch(
      "FlexScheduled",
      "F314",
      "ipfs://f314-scheduled",
      {
        whitelistThreshold: ethers.parseEther("4"),
        whitelistSlotSize: ethers.parseEther("0.2"),
        whitelistOpensAt: opensAt,
        whitelistAddresses: whitelist,
      },
      {
        taxBps: 500,
        burnShareBps: 5000,
        treasuryShareBps: 5000,
        treasuryWallet: treasury.address,
      },
      initCode,
      { value: WHITELIST_CREATE_FEE }
    );
    const receipt = await tx.wait();
    const tokenAddress = receipt!.logs.find((log) => "fragment" in log && log.fragment?.name === "LaunchCreated")!.args
      .token as string;
    const token = await ethers.getContractAt("LaunchTokenWhitelistTaxed", tokenAddress);
    const snapshot = await token.whitelistSnapshot();

    expect(await token.whitelistStatus()).to.equal(1n);
    expect(snapshot.opensAt).to.equal(opensAt);

    await expect(
      launchFactory.connect(creator).createWhitelistTaxLaunchAndCommit(
        "FlexScheduledCommit",
        "F314",
        "ipfs://f314-scheduled-commit",
        {
          whitelistThreshold: ethers.parseEther("4"),
          whitelistSlotSize: ethers.parseEther("0.2"),
          whitelistOpensAt: opensAt,
          whitelistAddresses: whitelist,
        },
        {
          taxBps: 500,
          burnShareBps: 5000,
          treasuryShareBps: 5000,
          treasuryWallet: treasury.address,
        },
        await buildWhitelistTaxedInitCode({
          name: "FlexScheduledCommit",
          symbol: "F314",
          metadataURI: "ipfs://f314-scheduled-commit",
          creator: creator.address,
          factory: await launchFactory.getAddress(),
          protocolFeeRecipient: protocol.address,
          router: await mockRouter.getAddress(),
          graduationQuoteReserve: GRADUATION_TARGET,
          whitelistThreshold: ethers.parseEther("4"),
          whitelistSlotSize: ethers.parseEther("0.2"),
          whitelistOpensAt: opensAt,
          whitelistAddresses: whitelist,
          taxBps: 500,
          burnShareBps: 5000,
          treasuryShareBps: 5000,
          treasuryWallet: treasury.address,
        }),
        { value: WHITELIST_CREATE_FEE + ethers.parseEther("0.2") }
      )
    ).to.be.revertedWithCustomError(launchFactory, "DelayedWhitelistAtomicCommitUnsupported");
  });

  it("rejects whitelist opens beyond the three-day scheduling window", async function () {
    const { creator, launchFactory } = await deployFixture();
    const whitelist = Array.from({ length: 20 }, (_, i) =>
      i === 0 ? creator.address : ethers.Wallet.createRandom().address
    );
    const opensAt = (await latestTimestamp()) + 4n * 24n * 60n * 60n;

    await expect(
      launchFactory.connect(creator).createWhitelistLaunch(
        "TooLate",
        "TLATE",
        "ipfs://too-late",
        ethers.parseEther("4"),
        ethers.parseEther("0.2"),
        opensAt,
        whitelist,
        { value: WHITELIST_CREATE_FEE }
      )
    ).to.be.reverted;
  });

  it("rejects whitelist arrays above three times the seat count for b314 and f314", async function () {
    const { creator, protocol, treasury, mockRouter, launchFactory } = await deployFixture();
    const oversizedWhitelist = Array.from({ length: 61 }, (_, i) =>
      i === 0 ? creator.address : ethers.Wallet.createRandom().address
    );

    await expect(
      launchFactory.connect(creator).createWhitelistLaunch(
        "TooManyWL",
        "TMWL",
        "ipfs://too-many-wl",
        ethers.parseEther("4"),
        ethers.parseEther("0.2"),
        0,
        oversizedWhitelist,
        { value: WHITELIST_CREATE_FEE }
      )
    ).to.be.reverted;

    const initCode = await buildWhitelistTaxedInitCode({
      name: "TooManyF",
      symbol: "TF314",
      metadataURI: "ipfs://too-many-f314",
      creator: creator.address,
      factory: await launchFactory.getAddress(),
      protocolFeeRecipient: protocol.address,
      router: await mockRouter.getAddress(),
      graduationQuoteReserve: GRADUATION_TARGET,
      whitelistThreshold: ethers.parseEther("4"),
      whitelistSlotSize: ethers.parseEther("0.2"),
      whitelistOpensAt: 0,
      whitelistAddresses: oversizedWhitelist,
      taxBps: 500,
      burnShareBps: 5000,
      treasuryShareBps: 5000,
      treasuryWallet: treasury.address,
    });

    await expect(
      launchFactory.connect(creator).createWhitelistTaxLaunch(
        "TooManyF",
        "TF314",
        "ipfs://too-many-f314",
        {
          whitelistThreshold: ethers.parseEther("4"),
          whitelistSlotSize: ethers.parseEther("0.2"),
          whitelistOpensAt: 0,
          whitelistAddresses: oversizedWhitelist,
        },
        {
          taxBps: 500,
          burnShareBps: 5000,
          treasuryShareBps: 5000,
          treasuryWallet: treasury.address,
        },
        initCode,
        { value: WHITELIST_CREATE_FEE }
      )
    ).to.be.reverted;
  });

  it("supports deterministic CREATE2 prediction with explicit salt", async function () {
    const { creator, launchFactory, standardDeployer, mockRouter, protocol } = await deployFixture();

    const salt = ethers.keccak256(ethers.toUtf8Bytes("vanity-0314"));
    const LaunchToken = await ethers.getContractFactory("LaunchToken");
    const standardArgs = buildStandardArgs(
      creator.address,
      await launchFactory.getAddress(),
      protocol.address,
      await mockRouter.getAddress(),
      GRADUATION_TARGET
    );
    const deployTx = await LaunchToken.getDeployTransaction(standardArgs);
    const initCodeHash = ethers.keccak256(deployTx.data!);
    const predicted = ethers.getCreate2Address(await standardDeployer.getAddress(), salt, initCodeHash);

    const tx = await launchFactory.connect(creator).createLaunchWithSalt("Vanity", "VAN", "ipfs://vanity", salt, {
      value: STANDARD_CREATE_FEE,
    });
    const receipt = await tx.wait();
    const launchEvent = receipt!.logs.find((log) => "fragment" in log && log.fragment?.name === "LaunchCreated");

    expect(launchEvent!.args.token).to.equal(predicted);
  });

  it("lets the protocol recipient claim accrued create fees", async function () {
    const { creator, protocol, launchFactory } = await deployFixture();

    await launchFactory.connect(creator).createLaunch("Alpha", "ALP", "ipfs://alpha", {
      value: STANDARD_CREATE_FEE,
    });

    const claimable = await launchFactory.accruedProtocolCreateFees();
    await expect(launchFactory.connect(protocol).claimProtocolCreateFees())
      .to.emit(launchFactory, "ProtocolCreateFeesClaimed")
      .withArgs(protocol.address, claimable);

    expect(await launchFactory.accruedProtocolCreateFees()).to.equal(0n);
  });

  it("allows claiming create fees to an alternate recipient", async function () {
    const { creator, protocol, launchFactory } = await deployFixture();
    const [, , , recipient] = await ethers.getSigners();

    await launchFactory.connect(creator).createLaunch("Alpha", "ALP", "ipfs://alpha", {
      value: STANDARD_CREATE_FEE,
    });

    await expect(launchFactory.connect(protocol).claimProtocolCreateFeesTo(recipient.address))
      .to.emit(launchFactory, "ProtocolCreateFeesClaimed")
      .withArgs(recipient.address, STANDARD_CREATE_FEE);
  });

  it("reverts when the caller underpays the standard create fee", async function () {
    const { creator, launchFactory } = await deployFixture();

    await expect(
      launchFactory.connect(creator).createLaunch("Alpha", "ALP", "ipfs://alpha", {
        value: STANDARD_CREATE_FEE - 1n,
      })
    ).to.be.revertedWithCustomError(launchFactory, "InsufficientCreateFee");
  });

  it("accrues only the create fee and refunds any overpayment", async function () {
    const { creator, launchFactory } = await deployFixture();
    const overpayment = ethers.parseEther("0.07");
    const totalSent = STANDARD_CREATE_FEE + overpayment;

    await launchFactory.connect(creator).createLaunch("Alpha", "ALP", "ipfs://alpha", {
      value: totalSent,
    });

    expect(await launchFactory.accruedProtocolCreateFees()).to.equal(STANDARD_CREATE_FEE);
    expect(await ethers.provider.getBalance(await launchFactory.getAddress())).to.equal(STANDARD_CREATE_FEE);
  });

  it("blocks protocol fee recipient rotation while unclaimed create fees exist", async function () {
    const { creator, owner, launchFactory } = await deployFixture();
    const [, , , recipient] = await ethers.getSigners();

    await launchFactory.connect(creator).createLaunch("Alpha", "ALP", "ipfs://alpha", {
      value: STANDARD_CREATE_FEE,
    });

    await expect(launchFactory.connect(owner).setProtocolFeeRecipient(recipient.address)).to.be.revertedWithCustomError(
      launchFactory,
      "PendingProtocolCreateFees"
    );
  });

  it("blocks batch protocol claims for launches whose immutable protocol recipient no longer matches the factory recipient", async function () {
    const { creator, owner, protocol, launchFactory } = await deployFixture();
    const [, , , recipient] = await ethers.getSigners();

    const tx = await launchFactory.connect(creator).createLaunch("Alpha", "ALP", "ipfs://alpha", {
      value: STANDARD_CREATE_FEE,
    });
    const receipt = await tx.wait();
    const tokenAddr = receipt!.logs.find((log) => "fragment" in log && log.fragment?.name === "LaunchCreated")!.args
      .token as string;
    const token = await ethers.getContractAt("LaunchToken", tokenAddr);

    await token.connect(creator).buy(0, { value: ethers.parseEther("0.1") });

    await launchFactory.connect(protocol).claimProtocolCreateFees();
    await launchFactory.connect(owner).setProtocolFeeRecipient(recipient.address);

    await expect(launchFactory.connect(recipient).batchClaimProtocolFees([tokenAddr], recipient.address)).to.be.revertedWithCustomError(
      launchFactory,
      "ProtocolFeeRecipientMismatch"
    );

    await expect(token.connect(protocol).claimProtocolFees()).to.not.be.reverted;
  });

  it("batch claims protocol fees from multiple launches", async function () {
    const { creator, protocol, launchFactory } = await deployFixture();

    const txA = await launchFactory.connect(creator).createLaunch("Alpha", "ALP", "ipfs://alpha", {
      value: STANDARD_CREATE_FEE,
    });
    const txB = await launchFactory.connect(creator).createLaunch("Beta", "BET", "ipfs://beta", {
      value: STANDARD_CREATE_FEE,
    });

    const receiptA = await txA.wait();
    const receiptB = await txB.wait();
    const tokenA = receiptA!.logs.find((log) => "fragment" in log && log.fragment?.name === "LaunchCreated")!.args
      .token as string;
    const tokenB = receiptB!.logs.find((log) => "fragment" in log && log.fragment?.name === "LaunchCreated")!.args
      .token as string;

    await (await ethers.getContractAt("LaunchToken", tokenA)).connect(creator).buy(0, { value: ethers.parseEther("0.1") });
    await (await ethers.getContractAt("LaunchToken", tokenB)).connect(creator).buy(0, { value: ethers.parseEther("0.1") });

    await launchFactory.connect(protocol).batchClaimProtocolFees([tokenA, tokenB], protocol.address);

    expect(await (await ethers.getContractAt("LaunchToken", tokenA)).protocolClaimable()).to.equal(0n);
    expect(await (await ethers.getContractAt("LaunchToken", tokenB)).protocolClaimable()).to.equal(0n);
  });

  it("batch claim skips zero-claimable launches while still claiming valid ones", async function () {
    const { creator, protocol, launchFactory } = await deployFixture();

    const txA = await launchFactory.connect(creator).createLaunch("Alpha", "ALP", "ipfs://alpha", {
      value: STANDARD_CREATE_FEE,
    });
    const txB = await launchFactory.connect(creator).createLaunch("Beta", "BET", "ipfs://beta", {
      value: STANDARD_CREATE_FEE,
    });

    const receiptA = await txA.wait();
    const receiptB = await txB.wait();
    const tokenA = receiptA!.logs.find((log) => "fragment" in log && log.fragment?.name === "LaunchCreated")!.args
      .token as string;
    const tokenB = receiptB!.logs.find((log) => "fragment" in log && log.fragment?.name === "LaunchCreated")!.args
      .token as string;

    const launchA = await ethers.getContractAt("LaunchToken", tokenA);
    const launchB = await ethers.getContractAt("LaunchToken", tokenB);
    await launchA.connect(creator).buy(0, { value: ethers.parseEther("0.1") });

    const [totalClaimed, claimedCount] = await launchFactory
      .connect(protocol)
      .batchClaimProtocolFees.staticCall([tokenA, tokenB], protocol.address);

    expect(totalClaimed).to.be.gt(0n);
    expect(claimedCount).to.equal(1n);

    await launchFactory.connect(protocol).batchClaimProtocolFees([tokenA, tokenB], protocol.address);

    expect(await launchA.protocolClaimable()).to.equal(0n);
    expect(await launchB.protocolClaimable()).to.equal(0n);
  });

  it("batch claim reverts the whole call when an unknown token is mixed into the array", async function () {
    const { creator, protocol, launchFactory } = await deployFixture();

    const tx = await launchFactory.connect(creator).createLaunch("Alpha", "ALP", "ipfs://alpha", {
      value: STANDARD_CREATE_FEE,
    });
    const receipt = await tx.wait();
    const tokenAddr = receipt!.logs.find((log) => "fragment" in log && log.fragment?.name === "LaunchCreated")!.args
      .token as string;
    const token = await ethers.getContractAt("LaunchToken", tokenAddr);

    await token.connect(creator).buy(0, { value: ethers.parseEther("0.1") });
    const claimableBefore = await token.protocolClaimable();

    await expect(
      launchFactory.connect(protocol).batchClaimProtocolFees([tokenAddr, ethers.Wallet.createRandom().address], protocol.address)
    ).to.be.revertedWithCustomError(launchFactory, "UnknownLaunch");

    expect(await token.protocolClaimable()).to.equal(claimableBefore);
  });

  it("batch claim reverts the whole call when a recipient mismatch launch is mixed into the array", async function () {
    const { creator, owner, protocol, launchFactory } = await deployFixture();
    const [, , , recipient] = await ethers.getSigners();

    const oldTx = await launchFactory.connect(creator).createLaunch("Legacy", "LEG", "ipfs://legacy", {
      value: STANDARD_CREATE_FEE,
    });
    const oldReceipt = await oldTx.wait();
    const oldTokenAddr = oldReceipt!.logs.find((log) => "fragment" in log && log.fragment?.name === "LaunchCreated")!.args
      .token as string;
    const oldToken = await ethers.getContractAt("LaunchToken", oldTokenAddr);
    await oldToken.connect(creator).buy(0, { value: ethers.parseEther("0.1") });

    await launchFactory.connect(protocol).claimProtocolCreateFees();
    await launchFactory.connect(owner).setProtocolFeeRecipient(recipient.address);

    const newTx = await launchFactory.connect(creator).createLaunch("Fresh", "FRH", "ipfs://fresh", {
      value: STANDARD_CREATE_FEE,
    });
    const newReceipt = await newTx.wait();
    const newTokenAddr = newReceipt!.logs.find((log) => "fragment" in log && log.fragment?.name === "LaunchCreated")!.args
      .token as string;
    const newToken = await ethers.getContractAt("LaunchToken", newTokenAddr);
    await newToken.connect(creator).buy(0, { value: ethers.parseEther("0.1") });

    const newClaimableBefore = await newToken.protocolClaimable();
    const oldClaimableBefore = await oldToken.protocolClaimable();

    await expect(
      launchFactory.connect(recipient).batchClaimProtocolFees([newTokenAddr, oldTokenAddr], recipient.address)
    ).to.be.revertedWithCustomError(launchFactory, "ProtocolFeeRecipientMismatch");

    expect(await newToken.protocolClaimable()).to.equal(newClaimableBefore);
    expect(await oldToken.protocolClaimable()).to.equal(oldClaimableBefore);
  });

  it("batch sweeps abandoned creator fees from multiple launches", async function () {
    const { creator, launchFactory } = await deployFixture();

    const txA = await launchFactory.connect(creator).createLaunch("Alpha", "ALP", "ipfs://alpha", {
      value: STANDARD_CREATE_FEE,
    });
    const txB = await launchFactory.connect(creator).createLaunch("Beta", "BET", "ipfs://beta", {
      value: STANDARD_CREATE_FEE,
    });

    const receiptA = await txA.wait();
    const receiptB = await txB.wait();
    const tokenAAddr = receiptA!.logs.find((log) => "fragment" in log && log.fragment?.name === "LaunchCreated")!.args
      .token as string;
    const tokenBAddr = receiptB!.logs.find((log) => "fragment" in log && log.fragment?.name === "LaunchCreated")!.args
      .token as string;

    const tokenA = await ethers.getContractAt("LaunchToken", tokenAAddr);
    const tokenB = await ethers.getContractAt("LaunchToken", tokenBAddr);
    await tokenA.connect(creator).buy(0, { value: ethers.parseEther("0.1") });
    await tokenB.connect(creator).buy(0, { value: ethers.parseEther("0.1") });

    await ethers.provider.send("evm_increaseTime", [180 * 24 * 60 * 60 + 31 * 24 * 60 * 60]);
    await ethers.provider.send("evm_mine", []);

    const beforeA = await tokenA.protocolClaimable();
    const beforeB = await tokenB.protocolClaimable();
    await launchFactory.batchSweepAbandonedCreatorFees([tokenAAddr, tokenBAddr]);

    expect(await tokenA.creatorFeeSweepReady()).to.equal(false);
    expect(await tokenB.creatorFeeSweepReady()).to.equal(false);
    expect(await tokenA.protocolClaimable()).to.be.gt(beforeA);
    expect(await tokenB.protocolClaimable()).to.be.gt(beforeB);
  });

  it("batch sweep reverts the whole call when an unknown token is mixed into the array", async function () {
    const { creator, launchFactory } = await deployFixture();

    const tx = await launchFactory.connect(creator).createLaunch("Alpha", "ALP", "ipfs://alpha", {
      value: STANDARD_CREATE_FEE,
    });
    const receipt = await tx.wait();
    const tokenAddr = receipt!.logs.find((log) => "fragment" in log && log.fragment?.name === "LaunchCreated")!.args
      .token as string;
    const token = await ethers.getContractAt("LaunchToken", tokenAddr);

    await token.connect(creator).buy(0, { value: ethers.parseEther("0.1") });
    await ethers.provider.send("evm_increaseTime", [180 * 24 * 60 * 60 + 31 * 24 * 60 * 60]);
    await ethers.provider.send("evm_mine", []);

    expect(await token.creatorFeeSweepReady()).to.equal(true);

    await expect(
      launchFactory.batchSweepAbandonedCreatorFees([tokenAddr, ethers.Wallet.createRandom().address])
    ).to.be.revertedWithCustomError(launchFactory, "UnknownLaunch");

    expect(await token.creatorFeeSweepReady()).to.equal(true);
  });

  it("batch sweep skips launches that are not ready while still sweeping valid ones", async function () {
    const { creator, launchFactory } = await deployFixture();

    const txA = await launchFactory.connect(creator).createLaunch("Alpha", "ALP", "ipfs://alpha", {
      value: STANDARD_CREATE_FEE,
    });
    const txB = await launchFactory.connect(creator).createLaunch("Beta", "BET", "ipfs://beta", {
      value: STANDARD_CREATE_FEE,
    });

    const receiptA = await txA.wait();
    const receiptB = await txB.wait();
    const tokenAAddr = receiptA!.logs.find((log) => "fragment" in log && log.fragment?.name === "LaunchCreated")!.args
      .token as string;
    const tokenBAddr = receiptB!.logs.find((log) => "fragment" in log && log.fragment?.name === "LaunchCreated")!.args
      .token as string;

    const tokenA = await ethers.getContractAt("LaunchToken", tokenAAddr);
    const tokenB = await ethers.getContractAt("LaunchToken", tokenBAddr);
    await tokenA.connect(creator).buy(0, { value: ethers.parseEther("0.1") });
    await tokenB.connect(creator).buy(0, { value: ethers.parseEther("0.1") });

    await ethers.provider.send("evm_increaseTime", [180 * 24 * 60 * 60 + 31 * 24 * 60 * 60]);
    await ethers.provider.send("evm_mine", []);

    await tokenB.connect(creator).buy(0, { value: ethers.parseEther("0.01") });

    expect(await tokenA.creatorFeeSweepReady()).to.equal(true);
    expect(await tokenB.creatorFeeSweepReady()).to.equal(false);

    const [totalSwept, sweptCount] = await launchFactory.batchSweepAbandonedCreatorFees.staticCall([tokenAAddr, tokenBAddr]);
    expect(totalSwept).to.be.gt(0n);
    expect(sweptCount).to.equal(1n);

    await launchFactory.batchSweepAbandonedCreatorFees([tokenAAddr, tokenBAddr]);

    expect(await tokenA.creatorFeeSweepReady()).to.equal(false);
    expect(await tokenB.creatorFeeSweepReady()).to.equal(false);
  });
});
