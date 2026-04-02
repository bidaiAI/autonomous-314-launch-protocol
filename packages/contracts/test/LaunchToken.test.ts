import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";
import { expect } from "chai";
import { ethers, network } from "hardhat";

describe("LaunchToken", function () {
  const GRADUATION_TARGET = ethers.parseEther("0.2");
  const SMALL_BUY = ethers.parseEther("0.05");
  const MEDIUM_BUY = ethers.parseEther("0.1");
  const OVERBUY = ethers.parseEther("1");

  async function deployFixture() {
    const [deployer, creator, protocol, buyer, seller, other] = await ethers.getSigners();

    const MockWNATIVE = await ethers.getContractFactory("MockERC20");
    const wbnb = await MockWNATIVE.deploy("Wrapped Native", "WNATIVE");
    await wbnb.waitForDeployment();

    const MockFactory = await ethers.getContractFactory("MockDexV2Factory");
    const mockFactory = await MockFactory.deploy();
    await mockFactory.waitForDeployment();

    const MockRouter = await ethers.getContractFactory("MockDexV2Router");
    const mockRouter = await MockRouter.deploy(await mockFactory.getAddress(), await wbnb.getAddress());
    await mockRouter.waitForDeployment();

    const LaunchToken = await ethers.getContractFactory("LaunchToken");
    const token = await LaunchToken.deploy(
      "Autonomous314",
      "A314",
      "ipfs://launch",
      creator.address,
      protocol.address,
      await mockRouter.getAddress(),
      GRADUATION_TARGET
    );
    await token.waitForDeployment();

    const pairAddress = await token.pair();
    const pair = await ethers.getContractAt("MockDexV2Pair", pairAddress);

    return { deployer, creator, protocol, buyer, seller, other, wbnb, mockFactory, mockRouter, token, pair };
  }

  async function mineBlock() {
    await ethers.provider.send("evm_mine", []);
  }

  it("starts in Bonding314 with expected reserves", async function () {
    const { token, pair } = await deployFixture();

    expect(await token.state()).to.equal(1n);
    expect(await token.saleTokenReserve()).to.equal(ethers.parseEther("800000000"));
    expect(await token.lpTokenReserve()).to.equal(ethers.parseEther("200000000"));
    expect(await token.graduationQuoteReserve()).to.equal(GRADUATION_TARGET);
    expect(await token.isPairClean()).to.equal(true);
    expect(await token.isPairGraduationCompatible()).to.equal(true);
    expect(await pair.totalSupply()).to.equal(0n);
  });

  it("blocks ordinary transfers before graduation", async function () {
    const { token, buyer, other } = await deployFixture();

    await token.connect(buyer).buy(0, { value: SMALL_BUY });
    await expect(token.connect(buyer).transfer(other.address, 1n)).to.be.revertedWithCustomError(
      token,
      "TransferDisabledPreGraduation"
    );
  });

  it("blocks transferFrom into the pair before graduation", async function () {
    const { token, buyer, other, pair } = await deployFixture();

    await token.connect(buyer).buy(0, { value: SMALL_BUY });
    const balance = await token.balanceOf(buyer.address);

    await token.connect(buyer).approve(other.address, balance);
    await expect(token.connect(other).transferFrom(buyer.address, await pair.getAddress(), balance / 2n)).to.be
      .revertedWithCustomError(token, "TransferDisabledPreGraduation");
  });

  it("enforces same-block sell cooldown and allows selling next block", async function () {
    const { token, buyer } = await deployFixture();

    await network.provider.send("evm_setAutomine", [false]);

    try {
      const buyData = token.interface.encodeFunctionData("buy", [0]);
      const sellData = token.interface.encodeFunctionData("sell", [1n, 0]);

      const buyTx = await buyer.sendTransaction({
        to: await token.getAddress(),
        data: buyData,
        value: SMALL_BUY,
        gasLimit: 1_000_000
      });

      const sellTx = await buyer.sendTransaction({
        to: await token.getAddress(),
        data: sellData,
        gasLimit: 1_000_000
      });

      await network.provider.send("evm_mine");

      const buyReceipt = await ethers.provider.getTransactionReceipt(buyTx.hash);
      const sellReceipt = await ethers.provider.getTransactionReceipt(sellTx.hash);

      expect(buyReceipt?.status).to.equal(1);
      expect(sellReceipt?.status).to.equal(0);
      expect(buyReceipt?.blockNumber).to.equal(sellReceipt?.blockNumber);

      const buyBlock = BigInt(buyReceipt!.blockNumber);
      expect(await token.lastBuyBlock(buyer.address)).to.equal(buyBlock);
      expect(await token.sellUnlockBlock(buyer.address)).to.equal(buyBlock + 1n);
      expect(await token.canSell(buyer.address)).to.equal(false);
    } finally {
      await network.provider.send("evm_setAutomine", [true]);
    }

    const balance = await token.balanceOf(buyer.address);
    await expect(token.connect(buyer).sell(balance / 2n, 0)).to.not.be.reverted;
  });

  it("rounds sell output against the trader with ceil reserve math", async function () {
    const { token, buyer } = await deployFixture();

    await token.connect(buyer).buy(0, { value: SMALL_BUY });
    const tokenAmount = ethers.parseEther("1");

    const curveQuoteReserve = await token.curveQuoteReserve();
    const saleTokenReserve = await token.saleTokenReserve();
    const lpTokenReserve = await token.lpTokenReserve();
    const virtualQuoteReserve = await token.virtualQuoteReserve();
    const virtualTokenReserve = await token.virtualTokenReserve();

    const effectiveQuoteReserve = curveQuoteReserve + virtualQuoteReserve;
    const effectiveTokenReserve = saleTokenReserve + lpTokenReserve + virtualTokenReserve;
    const invariant = effectiveQuoteReserve * effectiveTokenReserve;
    const newEffectiveTokenReserve = effectiveTokenReserve + tokenAmount;
    const ceilDiv = (invariant + newEffectiveTokenReserve - 1n) / newEffectiveTokenReserve;
    const floorDiv = invariant / newEffectiveTokenReserve;
    const expectedGrossQuoteOut = effectiveQuoteReserve - ceilDiv;

    expect(ceilDiv).to.be.greaterThanOrEqual(floorDiv);

    await mineBlock();

    const sellTx = await token.connect(buyer).sell(tokenAmount, 0);
    const receipt = await sellTx.wait();
    const sellEvent = receipt!.logs.find((log) => "fragment" in log && log.fragment?.name === "SellExecuted");

    expect(sellEvent).to.not.equal(undefined);
    expect(sellEvent!.args.grossQuoteOut).to.equal(expectedGrossQuoteOut);
  });

  it("keeps fee vaults and accounted balance separated from unexpected native balance", async function () {
    const { buyer, token } = await deployFixture();

    await token.connect(buyer).buy(0, { value: SMALL_BUY });
    const accounted = await token.accountedNativeBalance();
    expect(accounted).to.equal((await token.curveQuoteReserve()) + (await token.protocolFeeVault()) + (await token.creatorFeeVault()));

    const ForceSend = await ethers.getContractFactory("ForceSend");
    const forceSend = await ForceSend.deploy({ value: ethers.parseEther("0.25") });
    await forceSend.waitForDeployment();
    await forceSend.boom(await token.getAddress());

    expect(await token.unexpectedNativeBalance()).to.equal(ethers.parseEther("0.25"));
    expect(await token.accountedNativeBalance()).to.equal(accounted);
  });

  it("blocks creator fee claim before graduation and allows protocol fee claim during bonding", async function () {
    const { token, buyer, creator, protocol } = await deployFixture();

    await token.connect(buyer).buy(0, { value: MEDIUM_BUY });

    await expect(token.connect(creator).claimCreatorFees()).to.be.revertedWithCustomError(token, "InvalidState");

    const claimable = await token.protocolFeeVault();
    await expect(token.connect(protocol).claimProtocolFees())
      .to.emit(token, "ProtocolFeesClaimed")
      .withArgs(protocol.address, claimable);
    expect(await token.protocolFeeVault()).to.equal(0n);
  });

  it("supports partial fill to the configured graduation target and permanently closes 314", async function () {
    const { token, buyer, creator, pair } = await deployFixture();

    const preview = await token.previewBuy(OVERBUY);
    expect(preview.refundAmount).to.be.greaterThan(0n);

    await token.connect(buyer).buy(0, { value: OVERBUY });

    expect(await token.state()).to.equal(3n);
    expect(await token.curveQuoteReserve()).to.equal(0n);
    expect(await token.lpTokenReserve()).to.equal(0n);
    expect(await token.saleTokenReserve()).to.equal(0n);
    expect(await token.displayGraduationProgressBps()).to.equal(10_000n);
    expect(await token.remainingQuoteCapacity()).to.equal(0n);
    expect(await token.balanceOf(buyer.address)).to.equal(ethers.parseEther("800000000"));
    expect(await pair.totalSupply()).to.be.greaterThan(0n);
    expect(await token.creatorClaimable()).to.equal(await token.creatorFeeVault());
    expect(await token.protocolClaimable()).to.equal(await token.protocolFeeVault());
    const dexReserves = await token.dexReserves();
    expect(dexReserves[0]).to.equal(ethers.parseEther("200000000"));
    expect(dexReserves[1]).to.equal(GRADUATION_TARGET);
    expect(await token.currentPriceQuotePerToken()).to.equal(1_000_000_000n);

    await expect(
      buyer.sendTransaction({ to: await token.getAddress(), value: SMALL_BUY })
    ).to.be.revertedWithCustomError(token, "InvalidState");

    await expect(token.connect(buyer).buy(0, { value: SMALL_BUY })).to.be.revertedWithCustomError(
      token,
      "InvalidState"
    );

    await expect(token.connect(buyer).sell(1n, 0)).to.be.revertedWithCustomError(token, "InvalidState");

    await expect(token.connect(creator).claimCreatorFees()).to.not.be.reverted;
  });

  it("still reaches graduation after an intermediate sell", async function () {
    const { token, buyer, seller } = await deployFixture();

    await token.connect(buyer).buy(0, { value: SMALL_BUY });
    const sellAmount = ethers.parseEther("1");

    await expect(token.connect(buyer).sell(sellAmount, 0)).to.not.be.reverted;

    await expect(token.connect(seller).buy(0, { value: OVERBUY })).to.not.be.reverted;
    expect(await token.state()).to.equal(3n);
  });

  it("allows graduation when pair has preloaded WNATIVE donation", async function () {
    const { token, buyer, wbnb, pair } = await deployFixture();

    await wbnb.mint(await pair.getAddress(), ethers.parseEther("1"));
    await pair.setReserves(0, ethers.parseEther("1"));

    expect(await token.isPairClean()).to.equal(false);
    expect(await token.isPairGraduationCompatible()).to.equal(true);

    await expect(token.connect(buyer).buy(0, { value: OVERBUY })).to.not.be.reverted;
    expect(await token.state()).to.equal(3n);
  });

  it("allows graduation with large preloaded WNATIVE donation and reports it in the event", async function () {
    const { token, buyer, wbnb, pair } = await deployFixture();

    const donation = ethers.parseEther("25");
    await wbnb.mint(await pair.getAddress(), donation);
    await pair.setReserves(0, donation);

    await expect(token.connect(buyer).buy(0, { value: OVERBUY }))
      .to.emit(token, "Graduated")
      .withArgs(
        await pair.getAddress(),
        ethers.parseEther("200000000"),
        GRADUATION_TARGET,
        donation,
        anyValue
      );
  });

  it("reverts graduation when pair already has LP initialized", async function () {
    const { token, buyer, pair } = await deployFixture();

    await pair.setTotalSupply(1n);

    expect(await token.isPairGraduationCompatible()).to.equal(false);

    await expect(token.connect(buyer).buy(0, { value: OVERBUY })).to.be.revertedWithCustomError(token, "PairPolluted");
  });

  it("blocks sending tokens back into the token contract after graduation", async function () {
    const { token, buyer } = await deployFixture();

    await token.connect(buyer).buy(0, { value: OVERBUY });
    expect(await token.state()).to.equal(3n);

    await expect(token.connect(buyer).transfer(await token.getAddress(), 1n)).to.be.revertedWithCustomError(
      token,
      "InvalidRecipient"
    );
  });
});
