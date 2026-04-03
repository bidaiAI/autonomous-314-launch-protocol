import { expect } from "chai";
import { ethers } from "hardhat";

function buildStandardArgs(
  creator: string,
  factory: string,
  protocolFeeRecipient: string,
  router: string,
  graduationQuoteReserve: bigint,
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
  };
}

describe("LaunchFactory", function () {
  const STANDARD_CREATE_FEE = ethers.parseEther("0.01");
  const WHITELIST_CREATE_FEE = ethers.parseEther("0.03");
  const GRADUATION_TARGET = ethers.parseEther("12");
  const DEFAULT_PROTOCOL_FEE_RECIPIENT = "0xC4187bE6b362DF625696d4a9ec5E6FA461CC0314";

  async function deployFixture() {
    const [owner, protocol, creator] = await ethers.getSigners();

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

    const LaunchFactory = await ethers.getContractFactory("LaunchFactory");
    const launchFactory = await LaunchFactory.deploy(
      owner.address,
      await mockRouter.getAddress(),
      protocol.address,
      await standardDeployer.getAddress(),
      await whitelistDeployer.getAddress(),
      STANDARD_CREATE_FEE,
      WHITELIST_CREATE_FEE,
      GRADUATION_TARGET
    );
    await launchFactory.waitForDeployment();

    return {
      owner,
      protocol,
      creator,
      wbnb,
      mockFactory,
      mockRouter,
      standardDeployer,
      whitelistDeployer,
      launchFactory,
    };
  }

  it("deploys with basic configuration", async function () {
    const { protocol, mockRouter, standardDeployer, whitelistDeployer, launchFactory } = await deployFixture();

    expect(await launchFactory.router()).to.equal(await mockRouter.getAddress());
    expect(await launchFactory.protocolFeeRecipient()).to.equal(protocol.address);
    expect(await launchFactory.graduationQuoteReserve()).to.equal(GRADUATION_TARGET);
    expect(await launchFactory.standardDeployer()).to.equal(await standardDeployer.getAddress());
    expect(await launchFactory.whitelistDeployer()).to.equal(await whitelistDeployer.getAddress());
    expect(await launchFactory.createFee()).to.equal(STANDARD_CREATE_FEE);
    expect(await launchFactory.createFeeForMode(0)).to.equal(0n);
    expect(await launchFactory.createFeeForMode(1)).to.equal(STANDARD_CREATE_FEE);
    expect(await launchFactory.createFeeForMode(2)).to.equal(WHITELIST_CREATE_FEE);
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

    const LaunchFactory = await ethers.getContractFactory("LaunchFactory");
    const launchFactory = await LaunchFactory.deploy(
      owner.address,
      await mockRouter.getAddress(),
      ethers.ZeroAddress,
      await standardDeployer.getAddress(),
      await whitelistDeployer.getAddress(),
      STANDARD_CREATE_FEE,
      WHITELIST_CREATE_FEE,
      GRADUATION_TARGET
    );
    await launchFactory.waitForDeployment();

    expect(await launchFactory.protocolFeeRecipient()).to.equal(DEFAULT_PROTOCOL_FEE_RECIPIENT);
    expect(await launchFactory.DEFAULT_PROTOCOL_FEE_RECIPIENT()).to.equal(DEFAULT_PROTOCOL_FEE_RECIPIENT);
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
      .createWhitelistLaunch("Beta", "BETA", "ipfs://beta", ethers.parseEther("4"), ethers.parseEther("0.2"), whitelist, {
        value: WHITELIST_CREATE_FEE,
      });
    const receipt = await tx.wait();
    const launchEvent = receipt!.logs.find((log) => "fragment" in log && log.fragment?.name === "LaunchCreated");
    const tokenAddress = launchEvent!.args.token;

    expect(await launchFactory.totalLaunches()).to.equal(1n);
    expect(await launchFactory.modeOf(tokenAddress)).to.equal(2n);
    expect(await launchFactory.accruedProtocolCreateFees()).to.equal(WHITELIST_CREATE_FEE);
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
        whitelistAddresses: Array.from({ length: 20 }, () => ethers.Wallet.createRandom().address),
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
        whitelistAddresses: Array.from({ length: 20 }, () => ethers.Wallet.createRandom().address),
      })
    ).to.be.revertedWithCustomError(LaunchTokenWhitelist, "UnauthorizedFactoryDeployment");
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
});
