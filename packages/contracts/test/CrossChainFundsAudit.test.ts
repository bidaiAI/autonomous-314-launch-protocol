import { expect } from "chai";
import { ethers } from "hardhat";

type AuditProfile = {
  label: string;
  wrappedNativeSymbol: "WBNB" | "WETH";
  graduationTarget: bigint;
  whitelistThreshold: bigint;
  whitelistSlotSize: bigint;
  whitelistThresholdPresets: bigint[];
  whitelistSlotSizePresets: bigint[];
  publicBuyAmount: bigint;
  overbuyAmount: bigint;
};

const BSC_PROFILE: AuditProfile = {
  label: "BSC",
  wrappedNativeSymbol: "WBNB",
  graduationTarget: ethers.parseEther("12"),
  whitelistThreshold: ethers.parseEther("4"),
  whitelistSlotSize: ethers.parseEther("0.2"),
  whitelistThresholdPresets: [ethers.parseEther("4"), ethers.parseEther("6"), ethers.parseEther("8")],
  whitelistSlotSizePresets: [
    ethers.parseEther("0.1"),
    ethers.parseEther("0.2"),
    ethers.parseEther("0.5"),
    ethers.parseEther("1")
  ],
  publicBuyAmount: ethers.parseEther("0.5"),
  overbuyAmount: ethers.parseEther("20")
};

const BASE_PROFILE: AuditProfile = {
  label: "Base",
  wrappedNativeSymbol: "WETH",
  graduationTarget: ethers.parseEther("4"),
  whitelistThreshold: ethers.parseEther("1"),
  whitelistSlotSize: ethers.parseEther("0.04"),
  whitelistThresholdPresets: [ethers.parseEther("1"), ethers.parseEther("2"), ethers.parseEther("3")],
  whitelistSlotSizePresets: [
    ethers.parseEther("0.04"),
    ethers.parseEther("0.1"),
    ethers.parseEther("0.2"),
    ethers.parseEther("0.5")
  ],
  publicBuyAmount: ethers.parseEther("0.15"),
  overbuyAmount: ethers.parseEther("8")
};

const AUDIT_PROFILES = [BSC_PROFILE, BASE_PROFILE] as const;

async function increaseTime(seconds: number) {
  await ethers.provider.send("evm_increaseTime", [seconds]);
  await ethers.provider.send("evm_mine", []);
}

async function deployWhitelistRegistry(profile: AuditProfile, whitelistDeployer: string) {
  const Registry = await ethers.getContractFactory("MockLaunchFactoryRegistry");
  const registry = await Registry.deploy(
    whitelistDeployer,
    profile.whitelistThresholdPresets,
    profile.whitelistSlotSizePresets
  );
  await registry.waitForDeployment();
  return registry;
}

async function deployDex(profile: AuditProfile) {
  const MockWNATIVE = await ethers.getContractFactory("MockERC20");
  const wrappedNative = await MockWNATIVE.deploy(`Wrapped ${profile.wrappedNativeSymbol}`, profile.wrappedNativeSymbol);
  await wrappedNative.waitForDeployment();

  const MockFactory = await ethers.getContractFactory("MockDexV2Factory");
  const dexFactory = await MockFactory.deploy();
  await dexFactory.waitForDeployment();

  const MockRouter = await ethers.getContractFactory("MockDexV2Router");
  const router = await MockRouter.deploy(await dexFactory.getAddress(), await wrappedNative.getAddress());
  await router.waitForDeployment();

  return { wrappedNative, dexFactory, router };
}

async function deployStandardFixture(profile: AuditProfile) {
  const [deployer, creator, protocol, buyer] = await ethers.getSigners();
  const { wrappedNative, router } = await deployDex(profile);

  const LaunchToken = await ethers.getContractFactory("LaunchToken");
  const token = await LaunchToken.deploy({
    name: `${profile.label} Audit`,
    symbol: `${profile.label.slice(0, 3).toUpperCase()}A`,
    metadataURI: `ipfs://${profile.label.toLowerCase()}-audit`,
    creator: creator.address,
    factory: deployer.address,
    protocolFeeRecipient: protocol.address,
    router: await router.getAddress(),
    graduationQuoteReserve: profile.graduationTarget,
    launchModeId: 1
  });
  await token.waitForDeployment();

  const pair = await ethers.getContractAt("MockDexV2Pair", await token.pair());

  return { deployer, creator, protocol, buyer, wrappedNative, router, token, pair };
}

async function deployWhitelistFixture(profile: AuditProfile) {
  const [deployer, creator, protocol, outsiderA, outsiderB] = await ethers.getSigners();
  const seatCount = Number(profile.whitelistThreshold / profile.whitelistSlotSize);
  const whitelistCommitters = Array.from({ length: seatCount }, () => ethers.Wallet.createRandom().connect(ethers.provider));

  for (const wallet of whitelistCommitters) {
    await deployer.sendTransaction({ to: wallet.address, value: ethers.parseEther("5") });
  }

  const { wrappedNative, router } = await deployDex(profile);
  const registry = await deployWhitelistRegistry(profile, deployer.address);

  const LaunchTokenWhitelist = await ethers.getContractFactory("LaunchTokenWhitelist");
  const token = await LaunchTokenWhitelist.deploy({
    name: `${profile.label} Seats`,
    symbol: profile.label === "BSC" ? "B314" : "BASE",
    metadataURI: `ipfs://${profile.label.toLowerCase()}-seats`,
    creator: creator.address,
    factory: await registry.getAddress(),
    protocolFeeRecipient: protocol.address,
    router: await router.getAddress(),
    graduationQuoteReserve: profile.graduationTarget,
    whitelistThreshold: profile.whitelistThreshold,
    whitelistSlotSize: profile.whitelistSlotSize,
    whitelistOpensAt: 0,
    whitelistAddresses: whitelistCommitters.map((wallet) => wallet.address),
    launchModeId: 2
  });
  await token.waitForDeployment();

  const pair = await ethers.getContractAt("MockDexV2Pair", await token.pair());

  return {
    deployer,
    creator,
    protocol,
    outsiderA,
    outsiderB,
    whitelistCommitters,
    wrappedNative,
    router,
    registry,
    token,
    pair
  };
}

describe("Cross-chain funds audit", function () {
  for (const profile of AUDIT_PROFILES) {
    it(`[${profile.label}] refund path keeps whitelist vault isolated before normal bonding resumes`, async function () {
      const { token, whitelistCommitters, outsiderA } = await deployWhitelistFixture(profile);
      const tokenAddress = await token.getAddress();
      const committer = whitelistCommitters[0];

      await committer.sendTransaction({ to: tokenAddress, value: profile.whitelistSlotSize });
      expect(await token.whitelistCommitVault()).to.equal(profile.whitelistSlotSize);
      expect(await token.accountedNativeBalance()).to.equal(profile.whitelistSlotSize);
      expect(await token.unexpectedNativeBalance()).to.equal(0n);

      await increaseTime(24 * 60 * 60 + 1);
      await token.advanceWhitelistPhase();
      expect(await token.state()).to.equal(1n);
      expect(await token.whitelistStatus()).to.equal(4n);

      const balanceAfterCommit = await ethers.provider.getBalance(committer.address);
      const refundTx = await token.connect(committer).claimWhitelistRefund();
      const refundReceipt = await refundTx.wait();
      const refundGas = refundReceipt!.gasUsed * refundReceipt!.gasPrice;
      const balanceAfterRefund = await ethers.provider.getBalance(committer.address);

      expect(balanceAfterRefund - balanceAfterCommit + refundGas).to.equal(profile.whitelistSlotSize);
      expect(await token.whitelistCommitVault()).to.equal(0n);
      expect(await token.accountedNativeBalance()).to.equal(0n);
      expect(await token.protocolFeeVault()).to.equal(0n);
      expect(await token.creatorFeeVault()).to.equal(0n);
      expect(await token.unexpectedNativeBalance()).to.equal(0n);

      const preview = await token.previewBuy(profile.publicBuyAmount);
      const expectedNetQuote = profile.publicBuyAmount - preview.feeAmount;

      await token.connect(outsiderA).buy(0, { value: profile.publicBuyAmount });

      expect(await token.curveQuoteReserve()).to.equal(expectedNetQuote);
      expect(await token.protocolFeeVault() + await token.creatorFeeVault()).to.equal(preview.feeAmount);
      expect(await token.whitelistCommitVault()).to.equal(0n);
      expect(await token.accountedNativeBalance()).to.equal(profile.publicBuyAmount);
    });

    it(`[${profile.label}] graduation converts native ${profile.label === "BSC" ? "BNB" : "ETH"} into ${profile.wrappedNativeSymbol}`, async function () {
      const { token, pair, wrappedNative, buyer } = await deployStandardFixture(profile);
      const pairAddress = await pair.getAddress();

      await token.connect(buyer).buy(0, { value: profile.overbuyAmount });

      expect(await token.state()).to.equal(3n);
      expect(await token.wrappedNative()).to.equal(await wrappedNative.getAddress());
      expect(await wrappedNative.balanceOf(pairAddress)).to.equal(profile.graduationTarget);
      expect(await token.curveQuoteReserve()).to.equal(0n);
      expect(await token.lpTokenReserve()).to.equal(0n);

      const snapshot = await token.pairSnapshot();
      expect(snapshot.pairAddress).to.equal(pairAddress);
      expect(snapshot.pairTotalSupply).to.be.gt(0n);
      expect(snapshot.wrappedNativeBalance).to.equal(profile.graduationTarget);
      expect(snapshot.tokenBalance).to.equal(await token.LP_TOKEN_RESERVE());

      const contractNativeBalance = await ethers.provider.getBalance(await token.getAddress());
      expect(contractNativeBalance).to.equal((await token.protocolFeeVault()) + (await token.creatorFeeVault()));
    });

    it(`[${profile.label}] whitelist finalize + multi-round trading keeps reserved allocations intact through graduation`, async function () {
      const { token, whitelistCommitters, outsiderA, outsiderB, pair, wrappedNative } = await deployWhitelistFixture(profile);
      const tokenAddress = await token.getAddress();

      for (const committer of whitelistCommitters) {
        await committer.sendTransaction({ to: tokenAddress, value: profile.whitelistSlotSize });
      }

      expect(await token.state()).to.equal(1n);
      expect(await token.whitelistStatus()).to.equal(3n);

      const reservedBefore = await token.whitelistAllocationTokenReserve();
      const tokensPerSeat = await token.whitelistTokensPerSeat();
      expect(reservedBefore).to.be.gt(0n);
      expect(tokensPerSeat).to.be.gt(0n);

      await token.connect(outsiderA).buy(0, { value: profile.publicBuyAmount });
      const outsiderBalance = await token.balanceOf(outsiderA.address);
      await token.connect(outsiderA).sell(outsiderBalance / 2n, 0);

      expect(await token.whitelistAllocationTokenReserve()).to.equal(reservedBefore);
      expect(await token.whitelistTokensPerSeat()).to.equal(tokensPerSeat);

      await token.connect(outsiderB).buy(0, { value: profile.overbuyAmount });

      expect(await token.state()).to.equal(3n);
      expect(await wrappedNative.balanceOf(await pair.getAddress())).to.equal(profile.graduationTarget);
      expect(await token.whitelistAllocationTokenReserve()).to.equal(reservedBefore);
      expect(await token.whitelistTokensPerSeat()).to.equal(tokensPerSeat);

      await token.connect(whitelistCommitters[0]).claimWhitelistAllocation();
      expect(await token.whitelistAllocationTokenReserve()).to.equal(reservedBefore - tokensPerSeat);
      await expect(token.connect(whitelistCommitters[0]).claimWhitelistRefund()).to.be.revertedWithCustomError(
        token,
        "WhitelistRefundUnavailable"
      );
    });
  }
});
