import { expect } from "chai";
import { ethers } from "hardhat";

describe("LaunchTokenWhitelist", function () {
  const GRADUATION_TARGET = ethers.parseEther("12");
  const THRESHOLD = ethers.parseEther("4");
  const SLOT = ethers.parseEther("0.2");
  const WHITELIST_THRESHOLDS = [ethers.parseEther("4"), ethers.parseEther("6"), ethers.parseEther("8")];
  const WHITELIST_SLOT_SIZES = [
    ethers.parseEther("0.1"),
    ethers.parseEther("0.2"),
    ethers.parseEther("0.5"),
    ethers.parseEther("1")
  ];

  async function deployWhitelistFactoryRegistry(whitelistDeployer: string) {
    const Registry = await ethers.getContractFactory("MockLaunchFactoryRegistry");
    const registry = await Registry.deploy(whitelistDeployer, WHITELIST_THRESHOLDS, WHITELIST_SLOT_SIZES);
    await registry.waitForDeployment();
    return registry;
  }

  async function deployFixture(options?: { whitelistCount?: number }) {
    const [deployer, creator, protocol] = await ethers.getSigners();
    const whitelistCount = options?.whitelistCount ?? 20;
    const whitelistCommitters = Array.from({ length: whitelistCount }, () =>
      ethers.Wallet.createRandom().connect(ethers.provider)
    );

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

    const whitelistFactoryRegistry = await deployWhitelistFactoryRegistry(deployer.address);
    const whitelist = whitelistCommitters.map((signer) => signer.address);

    const LaunchTokenWhitelist = await ethers.getContractFactory("LaunchTokenWhitelist");
    const token = await LaunchTokenWhitelist.deploy({
      name: "Whitelist314",
      symbol: "B314",
      metadataURI: "ipfs://b314",
      creator: creator.address,
      factory: await whitelistFactoryRegistry.getAddress(),
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

  it("keeps reserved whitelist allocation untouched through repeated public buy-sell attacks after finalize", async function () {
    const { token, buyer, whitelistCommitters, deployer } = await deployFixture();
    const tokenAddr = await token.getAddress();
    const outsiderA = ethers.Wallet.createRandom().connect(ethers.provider);
    const outsiderB = ethers.Wallet.createRandom().connect(ethers.provider);

    await deployer.sendTransaction({ to: outsiderA.address, value: ethers.parseEther("5") });
    await deployer.sendTransaction({ to: outsiderB.address, value: ethers.parseEther("5") });

    for (const committer of whitelistCommitters) {
      await committer.sendTransaction({ to: tokenAddr, value: SLOT });
    }

    const reservedBefore = await token.whitelistAllocationTokenReserve();
    const perSeatBefore = await token.whitelistTokensPerSeat();
    const seatsFilled = await token.whitelistSeatsFilled();

    await outsiderA.sendTransaction({ to: tokenAddr, value: ethers.parseEther("0.8") });
    const outsiderABalance = await token.balanceOf(outsiderA.address);
    await ethers.provider.send("evm_mine", []);
    await token.connect(outsiderA).sell(outsiderABalance / 2n, 0);

    await outsiderB.sendTransaction({ to: tokenAddr, value: ethers.parseEther("0.6") });
    const outsiderBBalance = await token.balanceOf(outsiderB.address);
    await ethers.provider.send("evm_mine", []);
    await token.connect(outsiderB).sell(outsiderBBalance / 3n, 0);

    expect(await token.whitelistAllocationTokenReserve()).to.equal(reservedBefore);
    expect(await token.whitelistTokensPerSeat()).to.equal(perSeatBefore);
    expect(await token.whitelistSeatsFilled()).to.equal(seatsFilled);

    const buyerBalanceBefore = await token.balanceOf(buyer.address);
    await token.connect(buyer).claimWhitelistAllocation();
    const buyerBalanceAfter = await token.balanceOf(buyer.address);

    expect(buyerBalanceAfter - buyerBalanceBefore).to.equal(perSeatBefore);
    expect(await token.whitelistAllocationTokenReserve()).to.equal(reservedBefore - perSeatBefore);
  });

  it("does not let the threshold-filling seat overpay and combine commit with a first 314 buy", async function () {
    const { token, whitelistCommitters } = await deployFixture();
    const tokenAddr = await token.getAddress();

    for (const committer of whitelistCommitters.slice(0, -1)) {
      await committer.sendTransaction({ to: tokenAddr, value: SLOT });
    }

    const finalCommitter = whitelistCommitters[whitelistCommitters.length - 1];
    const extraBuyAmount = ethers.parseEther("0.1");

    await expect(
      finalCommitter.sendTransaction({ to: tokenAddr, value: SLOT + extraBuyAmount })
    ).to.be.revertedWithCustomError(token, "InvalidWhitelistCommitAmount");

    expect(await token.state()).to.equal(4n);
    expect(await token.whitelistFinalized()).to.equal(false);
    expect(await token.whitelistCommittedTotal()).to.equal(THRESHOLD - SLOT);
    expect(await token.whitelistSeatsFilled()).to.equal(19n);

    await finalCommitter.sendTransaction({ to: tokenAddr, value: SLOT });

    expect(await token.state()).to.equal(1n);
    expect(await token.whitelistFinalized()).to.equal(true);
    expect(await token.whitelistCommittedTotal()).to.equal(THRESHOLD);
  });

  it("rejects duplicate allocation and refund claims after the first successful claim", async function () {
    const { token, buyer, buyer2, whitelistCommitters } = await deployFixture();
    const tokenAddr = await token.getAddress();

    for (const committer of whitelistCommitters) {
      await committer.sendTransaction({ to: tokenAddr, value: SLOT });
    }

    await token.connect(buyer).claimWhitelistAllocation();
    await expect(token.connect(buyer).claimWhitelistAllocation()).to.be.revertedWithCustomError(
      token,
      "WhitelistAllocationUnavailable"
    );

    const refundFixture = await deployFixture();
    await refundFixture.buyer.sendTransaction({ to: await refundFixture.token.getAddress(), value: SLOT });
    await increaseTime(24 * 60 * 60 + 1);

    await refundFixture.token.advanceWhitelistPhase();
    await refundFixture.token.connect(refundFixture.buyer).claimWhitelistRefund();
    await expect(refundFixture.token.connect(refundFixture.buyer).claimWhitelistRefund()).to.be.revertedWithCustomError(
      refundFixture.token,
      "WhitelistRefundUnavailable"
    );

    expect(await token.balanceOf(buyer2.address)).to.equal(0n);
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

    const whitelistFactoryRegistry = await deployWhitelistFactoryRegistry(deployer.address);
    const whitelist = whitelistCommitters.map((signer) => signer.address);
    const latestBlock = await ethers.provider.getBlock("latest");
    const opensAt = BigInt((latestBlock?.timestamp ?? 0) + 2 * 60 * 60);

    const LaunchTokenWhitelist = await ethers.getContractFactory("LaunchTokenWhitelist");
    const token = await LaunchTokenWhitelist.deploy({
      name: "DelayedWhitelist314",
      symbol: "DB314",
      metadataURI: "ipfs://db314",
      creator: creator.address,
      factory: await whitelistFactoryRegistry.getAddress(),
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

    const whitelistFactoryRegistry = await deployWhitelistFactoryRegistry(deployer.address);
    const oversizedWhitelist = Array.from({ length: 61 }, () => ethers.Wallet.createRandom().address);

    const LaunchTokenWhitelist = await ethers.getContractFactory("LaunchTokenWhitelist");
    await expect(
      LaunchTokenWhitelist.deploy({
        name: "Whitelist314",
        symbol: "B314",
        metadataURI: "ipfs://b314",
        creator: creator.address,
        factory: await whitelistFactoryRegistry.getAddress(),
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

  it("auto-falls back to bonding on the first normal buy after whitelist expiry", async function () {
    const { token, buyer, deployer } = await deployFixture();
    const outsider = ethers.Wallet.createRandom().connect(ethers.provider);
    await deployer.sendTransaction({ to: outsider.address, value: ethers.parseEther("1") });

    await buyer.sendTransaction({ to: await token.getAddress(), value: SLOT });
    await increaseTime(24 * 60 * 60 + 1);

    expect(await token.state()).to.equal(4n);
    expect(await token.whitelistStatus()).to.equal(4n);

    await outsider.sendTransaction({ to: await token.getAddress(), value: ethers.parseEther("0.1") });

    expect(await token.state()).to.equal(1n);
    expect(await token.whitelistExpiredWithoutFinalization()).to.equal(true);
    expect(await token.balanceOf(outsider.address)).to.be.gt(0n);
    expect(await token.canClaimWhitelistRefund(buyer.address)).to.equal(true);
  });

  it("rejects a same-block outsider buy if it lands before the threshold-filling whitelist seat", async function () {
    const { token, deployer, whitelistCommitters } = await deployFixture();
    const tokenAddr = await token.getAddress();
    const finalCommitter = whitelistCommitters[whitelistCommitters.length - 1];
    const outsider = ethers.Wallet.createRandom().connect(ethers.provider);

    await deployer.sendTransaction({ to: outsider.address, value: ethers.parseEther("1") });

    for (const committer of whitelistCommitters.slice(0, -1)) {
      await committer.sendTransaction({ to: tokenAddr, value: SLOT });
    }

    await ethers.provider.send("evm_setAutomine", [false]);

    try {
      const outsiderBuyTx = await outsider.sendTransaction({
        to: tokenAddr,
        value: SLOT,
        gasLimit: 500_000,
      });
      const finalSeatTx = await finalCommitter.sendTransaction({ to: tokenAddr, value: SLOT });

      await ethers.provider.send("evm_mine", []);

      const outsiderReceipt = await outsiderBuyTx.wait().catch(() => null);
      const finalSeatReceipt = await finalSeatTx.wait();

      expect(outsiderReceipt).to.equal(null);
      expect(finalSeatReceipt?.status).to.equal(1);
      expect(await token.whitelistFinalized()).to.equal(true);
      expect(await token.state()).to.equal(1n);
      expect(await token.balanceOf(outsider.address)).to.equal(0n);
      expect(await token.whitelistCommittedTotal()).to.equal(THRESHOLD);
    } finally {
      await ethers.provider.send("evm_setAutomine", [true]);
    }
  });

  it("opens bonding immediately after the threshold-filling seat so a later tx in the same block can buy", async function () {
    const { token, deployer, whitelistCommitters } = await deployFixture();
    const tokenAddr = await token.getAddress();
    const finalCommitter = whitelistCommitters[whitelistCommitters.length - 1];
    const outsider = ethers.Wallet.createRandom().connect(ethers.provider);

    await deployer.sendTransaction({ to: outsider.address, value: ethers.parseEther("1") });

    for (const committer of whitelistCommitters.slice(0, -1)) {
      await committer.sendTransaction({ to: tokenAddr, value: SLOT });
    }

    await ethers.provider.send("evm_setAutomine", [false]);

    try {
      const finalSeatTx = await finalCommitter.sendTransaction({ to: tokenAddr, value: SLOT });
      const outsiderBuyTx = await outsider.sendTransaction({ to: tokenAddr, value: ethers.parseEther("0.1") });

      await ethers.provider.send("evm_mine", []);

      const finalSeatReceipt = await finalSeatTx.wait();
      const outsiderReceipt = await outsiderBuyTx.wait();

      expect(finalSeatReceipt?.status).to.equal(1);
      expect(outsiderReceipt?.status).to.equal(1);
      expect(finalSeatReceipt?.blockNumber).to.equal(outsiderReceipt?.blockNumber);
      expect(await token.whitelistFinalized()).to.equal(true);
      expect(await token.state()).to.equal(1n);
      expect(await token.balanceOf(outsider.address)).to.be.gt(0n);
      expect(await token.lastBuyBlock(outsider.address)).to.equal(BigInt(outsiderReceipt!.blockNumber));
    } finally {
      await ethers.provider.send("evm_setAutomine", [true]);
    }
  });

  it("does not let outsiders claim another user's allocation or refund", async function () {
    const { token, buyer, buyer2, whitelistCommitters, deployer } = await deployFixture();
    const tokenAddr = await token.getAddress();
    const outsider = ethers.Wallet.createRandom().connect(ethers.provider);
    await deployer.sendTransaction({ to: outsider.address, value: ethers.parseEther("1") });

    for (const committer of whitelistCommitters) {
      await committer.sendTransaction({ to: tokenAddr, value: SLOT });
    }

    await expect(token.connect(outsider).claimWhitelistAllocation()).to.be.revertedWithCustomError(
      token,
      "WhitelistAllocationUnavailable"
    );

    const refundFixture = await deployFixture();
    const refundOutsider = ethers.Wallet.createRandom().connect(ethers.provider);
    await refundFixture.deployer.sendTransaction({ to: refundOutsider.address, value: ethers.parseEther("1") });
    await refundFixture.buyer.sendTransaction({ to: await refundFixture.token.getAddress(), value: SLOT });
    await increaseTime(24 * 60 * 60 + 1);
    await refundFixture.token.advanceWhitelistPhase();
    await expect(refundFixture.token.connect(refundOutsider).claimWhitelistRefund()).to.be.revertedWithCustomError(
      refundFixture.token,
      "WhitelistRefundUnavailable"
    );

    expect(await token.balanceOf(buyer2.address)).to.equal(0n);
  });

  it("keeps fee vaults and accounted balances exact when whitelist finalizes", async function () {
    const { token, whitelistCommitters } = await deployFixture();
    const tokenAddr = await token.getAddress();

    for (const committer of whitelistCommitters) {
      await committer.sendTransaction({ to: tokenAddr, value: SLOT });
    }

    const protocolFee = (THRESHOLD * 30n) / 10_000n;
    const creatorFee = (THRESHOLD * 70n) / 10_000n;
    const netQuote = THRESHOLD - protocolFee - creatorFee;

    expect(await token.state()).to.equal(1n);
    expect(await token.whitelistFinalized()).to.equal(true);
    expect(await token.whitelistExpiredWithoutFinalization()).to.equal(false);
    expect(await token.whitelistCommitVault()).to.equal(0n);
    expect(await token.protocolFeeVault()).to.equal(protocolFee);
    expect(await token.creatorFeeVault()).to.equal(creatorFee);
    expect(await token.curveQuoteReserve()).to.equal(netQuote);
    expect(await ethers.provider.getBalance(tokenAddr)).to.equal(THRESHOLD);
    expect(
      (await token.curveQuoteReserve()) +
        (await token.protocolFeeVault()) +
        (await token.creatorFeeVault()) +
        (await token.whitelistCommitVault())
    ).to.equal(THRESHOLD);
    expect(await token.whitelistAllocationTokenReserve()).to.equal(
      (await token.whitelistTokensPerSeat()) * (await token.whitelistSeatsFilled())
    );
  });

  it("keeps whitelist reserve and claims intact under repeated forced-native injection after finalize", async function () {
    const { token, buyer, whitelistCommitters } = await deployFixture();
    const tokenAddr = await token.getAddress();

    for (const committer of whitelistCommitters) {
      await committer.sendTransaction({ to: tokenAddr, value: SLOT });
    }

    const accountedBefore = await token.accountedNativeBalance();
    const reservedBefore = await token.whitelistAllocationTokenReserve();
    const perSeatBefore = await token.whitelistTokensPerSeat();

    const ForceSend = await ethers.getContractFactory("ForceSend");
    const first = await ForceSend.deploy({ value: ethers.parseEther("0.15") });
    await first.waitForDeployment();
    await first.boom(tokenAddr);

    const second = await ForceSend.deploy({ value: ethers.parseEther("0.35") });
    await second.waitForDeployment();
    await second.boom(tokenAddr);

    expect(await token.accountedNativeBalance()).to.equal(accountedBefore);
    expect(await token.unexpectedNativeBalance()).to.equal(ethers.parseEther("0.5"));
    expect(await token.whitelistAllocationTokenReserve()).to.equal(reservedBefore);
    expect(await token.whitelistTokensPerSeat()).to.equal(perSeatBefore);

    const buyerBalanceBefore = await token.balanceOf(buyer.address);
    await token.connect(buyer).claimWhitelistAllocation();
    const buyerBalanceAfter = await token.balanceOf(buyer.address);

    expect(buyerBalanceAfter - buyerBalanceBefore).to.equal(perSeatBefore);
    expect(await token.whitelistAllocationTokenReserve()).to.equal(reservedBefore - perSeatBefore);
  });

  it("reconciles forced native after whitelist finalize without disturbing seat allocations", async function () {
    const { token, buyer, other, protocol, whitelistCommitters } = await deployFixture();
    const tokenAddr = await token.getAddress();

    for (const committer of whitelistCommitters) {
      await committer.sendTransaction({ to: tokenAddr, value: SLOT });
    }

    const accountedBefore = await token.accountedNativeBalance();
    const protocolFeeBefore = await token.protocolFeeVault();
    const reservedBefore = await token.whitelistAllocationTokenReserve();
    const perSeatBefore = await token.whitelistTokensPerSeat();

    const ForceSend = await ethers.getContractFactory("ForceSend");
    const forceSend = await ForceSend.deploy({ value: ethers.parseEther("0.4") });
    await forceSend.waitForDeployment();
    await forceSend.boom(tokenAddr);

    await expect(token.connect(buyer).reconcileUnexpectedNative())
      .to.emit(token, "UnexpectedNativeReconciled")
      .withArgs(buyer.address, ethers.parseEther("0.4"));

    expect(await token.unexpectedNativeBalance()).to.equal(0n);
    expect(await token.protocolFeeVault()).to.equal(protocolFeeBefore + ethers.parseEther("0.4"));
    expect(await token.accountedNativeBalance()).to.equal(accountedBefore + ethers.parseEther("0.4"));
    expect(await token.whitelistAllocationTokenReserve()).to.equal(reservedBefore);
    expect(await token.whitelistTokensPerSeat()).to.equal(perSeatBefore);

    const recipientBalanceBefore = await ethers.provider.getBalance(other.address);
    const claimable = await token.protocolFeeVault();
    await token.connect(protocol).claimProtocolFeesTo(other.address);

    expect(await ethers.provider.getBalance(other.address)).to.equal(recipientBalanceBefore + claimable);
    expect(await token.protocolFeeVault()).to.equal(0n);
  });

  it("keeps finalize and fallback mutually exclusive under repeated phase advances", async function () {
    const finalized = await deployFixture();
    const finalizedAddr = await finalized.token.getAddress();
    for (const committer of finalized.whitelistCommitters) {
      await committer.sendTransaction({ to: finalizedAddr, value: SLOT });
    }
    await increaseTime(24 * 60 * 60 + 1);
    await finalized.token.advanceWhitelistPhase();
    expect(await finalized.token.whitelistFinalized()).to.equal(true);
    expect(await finalized.token.whitelistExpiredWithoutFinalization()).to.equal(false);
    expect(await finalized.token.state()).to.equal(1n);
    await expect(finalized.token.connect(finalized.buyer).claimWhitelistRefund()).to.be.revertedWithCustomError(
      finalized.token,
      "WhitelistRefundUnavailable"
    );

    const expired = await deployFixture();
    await expired.buyer.sendTransaction({ to: await expired.token.getAddress(), value: SLOT });
    await increaseTime(24 * 60 * 60 + 1);
    await expired.token.advanceWhitelistPhase();
    await expired.token.advanceWhitelistPhase();
    expect(await expired.token.whitelistFinalized()).to.equal(false);
    expect(await expired.token.whitelistExpiredWithoutFinalization()).to.equal(true);
    expect(await expired.token.state()).to.equal(1n);
    await expect(expired.token.connect(expired.buyer).claimWhitelistAllocation()).to.be.revertedWithCustomError(
      expired.token,
      "WhitelistAllocationUnavailable"
    );
  });

  it("blocks refund reentrancy and only releases one seat refund", async function () {
    const [deployer, creator, protocol, filler] = await ethers.getSigners();

    const MockWNATIVE = await ethers.getContractFactory("MockERC20");
    const wbnb = await MockWNATIVE.deploy("Wrapped Native", "WNATIVE");
    await wbnb.waitForDeployment();

    const MockFactory = await ethers.getContractFactory("MockDexV2Factory");
    const mockFactory = await MockFactory.deploy();
    await mockFactory.waitForDeployment();

    const MockRouter = await ethers.getContractFactory("MockDexV2Router");
    const mockRouter = await MockRouter.deploy(await mockFactory.getAddress(), await wbnb.getAddress());
    await mockRouter.waitForDeployment();

    const Attacker = await ethers.getContractFactory("WhitelistRefundReentrancyAttacker");
    const attacker = await Attacker.deploy();
    await attacker.waitForDeployment();

    const whitelistFactoryRegistry = await deployWhitelistFactoryRegistry(deployer.address);
    const whitelist = [await attacker.getAddress(), ...Array.from({ length: 19 }, () => ethers.Wallet.createRandom().address)];

    const LaunchTokenWhitelist = await ethers.getContractFactory("LaunchTokenWhitelist");
    const token = await LaunchTokenWhitelist.deploy({
      name: "Whitelist314",
      symbol: "B314",
      metadataURI: "ipfs://b314",
      creator: creator.address,
      factory: await whitelistFactoryRegistry.getAddress(),
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
    await attacker.setToken(await token.getAddress());

    await deployer.sendTransaction({ to: await attacker.getAddress(), value: ethers.parseEther("1") });
    await attacker.commitSeat({ value: SLOT });

    const attackerBalanceBefore = await ethers.provider.getBalance(await attacker.getAddress());
    await increaseTime(24 * 60 * 60 + 1);
    await token.advanceWhitelistPhase();
    await attacker.attackRefund();
    const attackerBalanceAfter = await ethers.provider.getBalance(await attacker.getAddress());

    expect(await attacker.reentryAttempted()).to.equal(true);
    expect(await attacker.reentrySucceeded()).to.equal(false);
    expect(attackerBalanceAfter - attackerBalanceBefore).to.equal(SLOT);
    expect(await token.whitelistCommitVault()).to.equal(0n);
    await expect(attacker.attackRefund()).to.be.reverted;
    expect(await token.whitelistRefundClaimed(await attacker.getAddress())).to.equal(true);
    expect(await filler.getAddress()).to.not.equal(await attacker.getAddress());
  });

  it("keeps whitelist accounting coherent under same-block seat crowding", async function () {
    const { token, whitelistCommitters } = await deployFixture({ whitelistCount: 20 });
    const tokenAddr = await token.getAddress();
    const committers = whitelistCommitters.slice(0, 20);

    await ethers.provider.send("evm_setAutomine", [false]);

    try {
      const txPromises = committers.map((committer) => committer.sendTransaction({ to: tokenAddr, value: SLOT }));
      const txs = await Promise.all(txPromises);
      await ethers.provider.send("evm_mine", []);
      const receipts = await Promise.all(
        txs.map(async (tx) => {
          try {
            return await tx.wait();
          } catch (error) {
            return null;
          }
        })
      );

      const seatsFilled = await token.whitelistSeatsFilled();
      const committedTotal = await token.whitelistCommittedTotal();
      const finalized = await token.whitelistFinalized();
      const state = await token.state();
      const revertedCount = receipts.filter((receipt) => receipt === null).length;
      const successfulCount = receipts.filter((receipt) => receipt?.status === 1).length;

      expect(successfulCount + revertedCount).to.equal(20);
      expect(seatsFilled).to.be.oneOf([19n, 20n]);
      expect(committedTotal).to.equal(seatsFilled * SLOT);
      expect(successfulCount).to.equal(Number(seatsFilled));

      if (seatsFilled === 20n) {
        expect(finalized).to.equal(true);
        expect(state).to.equal(1n);
        expect(committedTotal).to.equal(THRESHOLD);
      } else {
        expect(finalized).to.equal(false);
        expect(state).to.equal(4n);
        expect(committedTotal).to.equal(THRESHOLD - SLOT);
      }
    } finally {
      await ethers.provider.send("evm_setAutomine", [true]);
    }
  });

  it("reports representative gas for whitelist commit, finalize, allocation claim, and refund", async function () {
    const finalized = await deployFixture();
    const tokenAddr = await finalized.token.getAddress();

    const firstCommitReceipt = await (
      await finalized.whitelistCommitters[0].sendTransaction({ to: tokenAddr, value: SLOT })
    ).wait();

    for (const committer of finalized.whitelistCommitters.slice(1, -1)) {
      await committer.sendTransaction({ to: tokenAddr, value: SLOT });
    }

    const finalizingReceipt = await (
      await finalized.whitelistCommitters[finalized.whitelistCommitters.length - 1].sendTransaction({
        to: tokenAddr,
        value: SLOT,
      })
    ).wait();
    const allocationReceipt = await (await finalized.token.connect(finalized.buyer).claimWhitelistAllocation()).wait();

    const refundFixture = await deployFixture();
    await refundFixture.buyer.sendTransaction({ to: await refundFixture.token.getAddress(), value: SLOT });
    await increaseTime(24 * 60 * 60 + 1);
    await refundFixture.token.advanceWhitelistPhase();
    const refundReceipt = await (await refundFixture.token.connect(refundFixture.buyer).claimWhitelistRefund()).wait();

    console.log("      Whitelist commit gas:", firstCommitReceipt!.gasUsed.toString());
    console.log("      Whitelist finalize gas:", finalizingReceipt!.gasUsed.toString());
    console.log("      Whitelist allocation claim gas:", allocationReceipt!.gasUsed.toString());
    console.log("      Whitelist refund claim gas:", refundReceipt!.gasUsed.toString());

    expect(firstCommitReceipt!.gasUsed).to.be.lte(250_000n);
    expect(finalizingReceipt!.gasUsed).to.be.lte(350_000n);
    expect(allocationReceipt!.gasUsed).to.be.lte(150_000n);
    expect(refundReceipt!.gasUsed).to.be.lte(150_000n);
  });
});
