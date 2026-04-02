import { expect } from "chai";
import { ethers } from "hardhat";

describe("LaunchFactory", function () {
  const CREATE_FEE = ethers.parseEther("0.03");
  const GRADUATION_TARGET = ethers.parseEther("0.2");
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

    const LaunchFactory = await ethers.getContractFactory("LaunchFactory");
    const launchFactory = await LaunchFactory.deploy(
      owner.address,
      await mockRouter.getAddress(),
      protocol.address,
      CREATE_FEE,
      GRADUATION_TARGET
    );
    await launchFactory.waitForDeployment();

    return { owner, protocol, creator, wbnb, mockFactory, mockRouter, launchFactory };
  }

  it("deploys with basic configuration", async function () {
    const { protocol, mockRouter, launchFactory } = await deployFixture();

    expect(await launchFactory.router()).to.equal(await mockRouter.getAddress());
    expect(await launchFactory.protocolFeeRecipient()).to.equal(protocol.address);
    expect(await launchFactory.graduationQuoteReserve()).to.equal(GRADUATION_TARGET);
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

    const LaunchFactory = await ethers.getContractFactory("LaunchFactory");
    const launchFactory = await LaunchFactory.deploy(
      owner.address,
      await mockRouter.getAddress(),
      ethers.ZeroAddress,
      CREATE_FEE,
      GRADUATION_TARGET
    );
    await launchFactory.waitForDeployment();

    expect(await launchFactory.protocolFeeRecipient()).to.equal(DEFAULT_PROTOCOL_FEE_RECIPIENT);
    expect(await launchFactory.DEFAULT_PROTOCOL_FEE_RECIPIENT()).to.equal(DEFAULT_PROTOCOL_FEE_RECIPIENT);
  });

  it("creates launches and records creator ownership", async function () {
    const { creator, launchFactory } = await deployFixture();

    const tx = await launchFactory.connect(creator).createLaunch("Alpha", "ALP", "ipfs://alpha", {
      value: CREATE_FEE,
    });
    const receipt = await tx.wait();
    const launchEvent = receipt!.logs.find((log) => "fragment" in log && log.fragment?.name === "LaunchCreated");
    const tokenAddress = launchEvent!.args.token;

    expect(await launchFactory.totalLaunches()).to.equal(1n);
    expect((await launchFactory.launchesOf(creator.address))[0]).to.equal(tokenAddress);
    expect(await launchFactory.accruedProtocolCreateFees()).to.equal(CREATE_FEE);
  });

  it("supports deterministic CREATE2 prediction with explicit salt", async function () {
    const { creator, launchFactory } = await deployFixture();

    const salt = ethers.keccak256(ethers.toUtf8Bytes("vanity-0314"));
    const predicted = await launchFactory.predictLaunchAddress(
      "Vanity",
      "VAN",
      "ipfs://vanity",
      creator.address,
      salt
    );

    const tx = await launchFactory.connect(creator).createLaunchWithSalt("Vanity", "VAN", "ipfs://vanity", salt, {
      value: CREATE_FEE,
    });
    const receipt = await tx.wait();
    const launchEvent = receipt!.logs.find((log) => "fragment" in log && log.fragment?.name === "LaunchCreated");

    expect(launchEvent!.args.token).to.equal(predicted);
  });

  it("lets the protocol recipient claim accrued create fees", async function () {
    const { creator, protocol, launchFactory } = await deployFixture();

    await launchFactory.connect(creator).createLaunch("Alpha", "ALP", "ipfs://alpha", {
      value: CREATE_FEE,
    });

    const claimable = await launchFactory.accruedProtocolCreateFees();
    await expect(launchFactory.connect(protocol).claimProtocolCreateFees())
      .to.emit(launchFactory, "ProtocolCreateFeesClaimed")
      .withArgs(protocol.address, claimable);

    expect(await launchFactory.accruedProtocolCreateFees()).to.equal(0n);
  });

  it("reverts when the caller underpays the create fee", async function () {
    const { creator, launchFactory } = await deployFixture();

    await expect(
      launchFactory.connect(creator).createLaunch("Alpha", "ALP", "ipfs://alpha", {
        value: CREATE_FEE - 1n,
      })
    ).to.be.revertedWithCustomError(launchFactory, "InsufficientCreateFee");
  });

  it("accrues only the create fee and refunds any overpayment", async function () {
    const { creator, launchFactory } = await deployFixture();
    const overpayment = ethers.parseEther("0.07");
    const totalSent = CREATE_FEE + overpayment;

    await launchFactory.connect(creator).createLaunch("Alpha", "ALP", "ipfs://alpha", {
      value: totalSent,
    });

    expect(await launchFactory.accruedProtocolCreateFees()).to.equal(CREATE_FEE);
    expect(await ethers.provider.getBalance(await launchFactory.getAddress())).to.equal(CREATE_FEE);
  });
});
