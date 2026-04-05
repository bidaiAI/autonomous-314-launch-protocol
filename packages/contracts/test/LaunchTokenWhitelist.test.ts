import { expect } from "chai";
import { ethers } from "hardhat";

describe("LaunchTokenWhitelist", function () {
  const GRADUATION_TARGET = ethers.parseEther("12");
  const THRESHOLD = ethers.parseEther("4");
  const SLOT = ethers.parseEther("0.2");

  async function deployFixture() {
    const [deployer, creator, protocol] = await ethers.getSigners();
    const whitelistCommitters = Array.from({ length: 20 }, () => ethers.Wallet.createRandom().connect(ethers.provider));

    for (const wallet of whitelistCommitters) {
      await deployer.sendTransaction({ to: wallet.address, value: ethers.parseEther("1") });
    }

    const [buyer, buyer2, other] = whitelistCommitters;

    const MockWNATIVE = await ethers.getContractFactory("MockERC20");
    const wbnb = await MockWNATIVE.deploy("Wrapped Native", "WNATIVE");
    await wbnb.waitForDeployment();

    const MockFactory = await ethers.getContractFactory("MockDexV2Factory");
    const mockFactory = await MockFactory.deploy();
    await mockFactory.waitForDeployment();

    const MockRouter = await ethers.getContractFactory("MockDexV2Router");
    const mockRouter = await MockRouter.deploy(await mockFactory.getAddress(), await wbnb.getAddress());
    await mockRouter.waitForDeployment();

    const whitelist = whitelistCommitters.map((signer) => signer.address);

    const LaunchTokenWhitelist = await ethers.getContractFactory("LaunchTokenWhitelist");
    const token = await LaunchTokenWhitelist.deploy({
      name: "Whitelist314",
      symbol: "B314",
      metadataURI: "ipfs://b314",
      creator: creator.address,
      factory: deployer.address,
      protocolFeeRecipient: protocol.address,
      router: await mockRouter.getAddress(),
      graduationQuoteReserve: GRADUATION_TARGET,
      whitelistThreshold: THRESHOLD,
      whitelistSlotSize: SLOT,
      whitelistOpensAt: 0,
      whitelistAddresses: whitelist,
      launchModeId: 2,
    });
    await token.waitForDeployment();

    return { deployer, creator, protocol, buyer, buyer2, other, token, whitelistCommitters };
  }

  async function increaseTime(seconds: number) {
    await ethers.provider.send("evm_increaseTime", [seconds]);
    await ethers.provider.send("evm_mine", []);
  }

  it("starts in whitelist commit mode with readable whitelist config", async function () {
    const { token, buyer } = await deployFixture();
    expect(await token.state()).to.equal(4n);
    const snapshot = await token.whitelistSnapshot();
    expect(snapshot.opensAt).to.be.gt(0n);
    expect(snapshot.threshold).to.equal(THRESHOLD);
    expect(snapshot.slotSize).to.equal(SLOT);
    expect(snapshot.seatCount).to.equal(20n);
    expect(await token.isWhitelisted(buyer.address)).to.equal(true);
    expect(await token.canCommitWhitelist(buyer.address)).to.equal(true);
  });

  it("requires exact slot size and approved addresses", async function () {
    const { token, buyer, deployer } = await deployFixture();

    await expect(
      buyer.sendTransaction({ to: await token.getAddress(), value: SLOT - 1n })
    ).to.be.revertedWithCustomError(token, "InvalidWhitelistCommitAmount");

    await expect(
      buyer.sendTransaction({ to: await token.getAddress(), value: SLOT + 1n })
    ).to.be.revertedWithCustomError(token, "InvalidWhitelistCommitAmount");

    await expect(
      deployer.sendTransaction({ to: await token.getAddress(), value: SLOT })
    ).to.be.revertedWithCustomError(token, "WhitelistAddressNotApproved");
  });

  it("auto-finalizes at threshold and lets seats claim equal allocations", async function () {
    const { token, buyer, buyer2, whitelistCommitters } = await deployFixture();
    const tokenAddr = await token.getAddress();

    for (const committer of whitelistCommitters) {
      await committer.sendTransaction({ to: tokenAddr, value: SLOT });
    }

    expect(await token.state()).to.equal(1n);
    expect(await token.whitelistStatus()).to.equal(3n);
    const tokensPerSeat = await token.whitelistTokensPerSeat();
    expect(tokensPerSeat).to.be.gt(0n);

    await expect(token.connect(buyer).claimWhitelistAllocation())
      .to.emit(token, "WhitelistAllocationClaimed")
      .withArgs(buyer.address, tokensPerSeat);
    await expect(token.connect(buyer2).claimWhitelistAllocation())
      .to.emit(token, "WhitelistAllocationClaimed")
      .withArgs(buyer2.address, tokensPerSeat);
  });

  it("expires after 24h, enables refunds, and falls back to bonding314", async function () {
    const { token, buyer } = await deployFixture();

    await buyer.sendTransaction({ to: await token.getAddress(), value: SLOT });
    await increaseTime(24 * 60 * 60 + 1);

    expect(await token.whitelistStatus()).to.equal(4n);
    expect(await token.canClaimWhitelistRefund(buyer.address)).to.equal(true);

    await token.advanceWhitelistPhase();

    expect(await token.state()).to.equal(1n);
    expect(await token.whitelistStatus()).to.equal(4n);
    expect(await token.canClaimWhitelistRefund(buyer.address)).to.equal(true);

    await expect(token.connect(buyer).claimWhitelistRefund())
      .to.emit(token, "WhitelistRefundClaimed")
      .withArgs(buyer.address, SLOT);
  });

  it("supports delayed whitelist opens and reports scheduled status until open", async function () {
    const { deployer, creator, protocol, whitelistCommitters } = await deployFixture();
    const buyer = whitelistCommitters[0];

    const MockWNATIVE = await ethers.getContractFactory("MockERC20");
    const wbnb = await MockWNATIVE.deploy("Wrapped Native", "WNATIVE");
    await wbnb.waitForDeployment();

    const MockFactory = await ethers.getContractFactory("MockDexV2Factory");
    const mockFactory = await MockFactory.deploy();
    await mockFactory.waitForDeployment();

    const MockRouter = await ethers.getContractFactory("MockDexV2Router");
    const mockRouter = await MockRouter.deploy(await mockFactory.getAddress(), await wbnb.getAddress());
    await mockRouter.waitForDeployment();

    const whitelist = whitelistCommitters.map((signer) => signer.address);
    const latestBlock = await ethers.provider.getBlock("latest");
    const opensAt = BigInt((latestBlock?.timestamp ?? 0) + 2 * 60 * 60);

    const LaunchTokenWhitelist = await ethers.getContractFactory("LaunchTokenWhitelist");
    const token = await LaunchTokenWhitelist.deploy({
      name: "DelayedWhitelist314",
      symbol: "DB314",
      metadataURI: "ipfs://db314",
      creator: creator.address,
      factory: deployer.address,
      protocolFeeRecipient: protocol.address,
      router: await mockRouter.getAddress(),
      graduationQuoteReserve: GRADUATION_TARGET,
      whitelistThreshold: THRESHOLD,
      whitelistSlotSize: SLOT,
      whitelistOpensAt: opensAt,
      whitelistAddresses: whitelist,
      launchModeId: 2,
    });
    await token.waitForDeployment();

    expect(await token.whitelistStatus()).to.equal(1n);
    const snapshot = await token.whitelistSnapshot();
    expect(snapshot.opensAt).to.equal(opensAt);
    expect(await token.canCommitWhitelist(buyer.address)).to.equal(false);
    await expect(buyer.sendTransaction({ to: await token.getAddress(), value: SLOT })).to.be.revertedWithCustomError(
      token,
      "WhitelistNotActive"
    );

    await increaseTime(2 * 60 * 60 + 1);
    expect(await token.whitelistStatus()).to.equal(2n);
    expect(await token.canCommitWhitelist(buyer.address)).to.equal(true);
    await buyer.sendTransaction({ to: await token.getAddress(), value: SLOT });
    expect(await token.whitelistSeatsFilled()).to.equal(1n);
  });

  it("rejects whitelist arrays above three times the seat count", async function () {
    const [deployer, creator, protocol] = await ethers.getSigners();

    const MockWNATIVE = await ethers.getContractFactory("MockERC20");
    const wbnb = await MockWNATIVE.deploy("Wrapped Native", "WNATIVE");
    await wbnb.waitForDeployment();

    const MockFactory = await ethers.getContractFactory("MockDexV2Factory");
    const mockFactory = await MockFactory.deploy();
    await mockFactory.waitForDeployment();

    const MockRouter = await ethers.getContractFactory("MockDexV2Router");
    const mockRouter = await MockRouter.deploy(await mockFactory.getAddress(), await wbnb.getAddress());
    await mockRouter.waitForDeployment();

    const oversizedWhitelist = Array.from({ length: 61 }, () => ethers.Wallet.createRandom().address);

    const LaunchTokenWhitelist = await ethers.getContractFactory("LaunchTokenWhitelist");
    await expect(
      LaunchTokenWhitelist.deploy({
        name: "Whitelist314",
        symbol: "B314",
        metadataURI: "ipfs://b314",
        creator: creator.address,
        factory: deployer.address,
        protocolFeeRecipient: protocol.address,
        router: await mockRouter.getAddress(),
        graduationQuoteReserve: GRADUATION_TARGET,
        whitelistThreshold: THRESHOLD,
        whitelistSlotSize: SLOT,
        whitelistOpensAt: 0,
        whitelistAddresses: oversizedWhitelist,
        launchModeId: 2,
      })
    ).to.be.revertedWithCustomError(LaunchTokenWhitelist, "InvalidWhitelistAddressCount");
  });
});
