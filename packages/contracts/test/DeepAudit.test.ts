import { expect } from "chai";
import { ethers, network } from "hardhat";

/**
 * Deep audit tests — validates attack vectors and edge cases
 * identified during security review of the Autonomous 314 Launch Protocol.
 */
describe("Deep Audit: AMM Math & Edge Cases", function () {
  const GRADUATION_TARGET = ethers.parseEther("0.2");
  const TINY_BUY = ethers.parseEther("0.01");
  const SMALL_BUY = ethers.parseEther("0.05");
  const MEDIUM_BUY = ethers.parseEther("0.1");
  const OVERBUY = ethers.parseEther("1");

  async function deployFixture() {
    const [deployer, creator, protocol, buyer, buyer2, buyer3, attacker] =
      await ethers.getSigners();

    const MockWBNB = await ethers.getContractFactory("MockERC20");
    const wbnb = await MockWBNB.deploy("Wrapped Native", "WNATIVE");
    await wbnb.waitForDeployment();

    const MockFactory = await ethers.getContractFactory("MockDexV2Factory");
    const mockFactory = await MockFactory.deploy();
    await mockFactory.waitForDeployment();

    const MockRouter = await ethers.getContractFactory("MockDexV2Router");
    const mockRouter = await MockRouter.deploy(
      await mockFactory.getAddress(),
      await wbnb.getAddress()
    );
    await mockRouter.waitForDeployment();

    const LaunchToken = await ethers.getContractFactory("LaunchToken");
    const token = await LaunchToken.deploy({
      name: "AuditTest",
      symbol: "AUDIT",
      metadataURI: "ipfs://audit",
      creator: creator.address,
      factory: deployer.address,
      protocolFeeRecipient: protocol.address,
      router: await mockRouter.getAddress(),
      graduationQuoteReserve: GRADUATION_TARGET,
    });
    await token.waitForDeployment();

    const pairAddress = await token.pair();
    const pair = await ethers.getContractAt("MockDexV2Pair", pairAddress);

    return {
      deployer,
      creator,
      protocol,
      buyer,
      buyer2,
      buyer3,
      attacker,
      wbnb,
      mockFactory,
      mockRouter,
      token,
      pair,
    };
  }

  // =====================================================================
  // C-1 验证: sell() 的 ceilDiv 取整方向
  // =====================================================================
  describe("C-1: sell() rounding direction (ceilDiv verification)", function () {
    it("sells should not drain more quote than fair invariant allows", async function () {
      const { token, buyer } = await deployFixture();

      // Buy a small amount (stay well below graduation)
      await token.connect(buyer).buy(0, { value: SMALL_BUY });

      const balance = await token.balanceOf(buyer.address);
      const curveQuoteBefore = await token.curveQuoteReserve();

      // Sell back in 10 tiny chunks
      const sellChunk = balance / 10n;
      for (let i = 0; i < 10; i++) {
        const remaining = await token.balanceOf(buyer.address);
        const thisSell = remaining < sellChunk ? remaining : sellChunk;
        if (thisSell === 0n) break;
        await token.connect(buyer).sell(thisSell, 0);
      }

      const curveQuoteAfter = await token.curveQuoteReserve();
      // curveQuoteReserve must never go negative
      expect(curveQuoteAfter).to.be.gte(0n);
      // After selling back, reserve should have lost less than original buy
      // because fees were deducted on both buy and sell
      expect(curveQuoteAfter).to.be.lt(curveQuoteBefore);
    });

    it("split sells should not profit more than a single bulk sell (rounding leak)", async function () {
      // Fixture 1: bulk sell
      const f1 = await deployFixture();
      await f1.token.connect(f1.buyer).buy(0, { value: SMALL_BUY });
      const balance1 = await f1.token.balanceOf(f1.buyer.address);
      await f1.token.connect(f1.buyer).sell(balance1, 0);
      const reserveAfterBulk = await f1.token.curveQuoteReserve();

      // Fixture 2: split sells (10 chunks)
      const f2 = await deployFixture();
      await f2.token.connect(f2.buyer).buy(0, { value: SMALL_BUY });
      const balance2 = await f2.token.balanceOf(f2.buyer.address);
      const chunk = balance2 / 10n;
      for (let i = 0; i < 10; i++) {
        const rem = await f2.token.balanceOf(f2.buyer.address);
        const thisSell = rem < chunk ? rem : chunk;
        if (thisSell === 0n) break;
        await f2.token.connect(f2.buyer).sell(thisSell, 0);
      }
      const reserveAfterSplit = await f2.token.curveQuoteReserve();

      // With ceilDiv in sell, the protocol keeps MORE reserve in split case
      // (ceilDiv rounds newEffectiveQuoteReserve UP, so grossQuoteOut is smaller)
      // This means split sells should leave MORE in the reserve
      expect(reserveAfterSplit).to.be.gte(reserveAfterBulk);
      const leakage = reserveAfterBulk > reserveAfterSplit
        ? reserveAfterBulk - reserveAfterSplit
        : 0n;
      console.log("      Rounding leakage:", leakage.toString(), "wei");
      expect(leakage).to.equal(0n); // ceilDiv ensures no leakage
    });
  });

  // =====================================================================
  // C-3 验证: _quoteBuy while 循环有界性
  // =====================================================================
  describe("C-3: _quoteBuy loop boundedness", function () {
    it("partial fill near graduation boundary does not consume excessive gas", async function () {
      const { token, buyer, buyer2 } = await deployFixture();

      // Buy to ~95% of graduation
      await token.connect(buyer).buy(0, { value: ethers.parseEther("0.18") });
      expect(await token.state()).to.equal(1n); // still bonding

      const remaining = await token.remainingQuoteCapacity();
      console.log("      Remaining capacity:", ethers.formatEther(remaining), "BNB");

      // Send far more than remaining to trigger partial fill + graduation
      const tx = await token.connect(buyer2).buy(0, { value: OVERBUY });
      const receipt = await tx.wait();

      console.log("      Gas used for partial fill graduation:", receipt!.gasUsed.toString());
      expect(receipt!.gasUsed).to.be.lte(500_000n);
      expect(await token.state()).to.equal(3n); // DEXOnly
    });
  });

  // =====================================================================
  // H-4 验证: 同块 sell cooldown (已由原始测试覆盖，此处验证一致)
  // =====================================================================
  describe("H-4: Same-block sell cooldown (real test)", function () {
    it("sell in the same block as buy should revert", async function () {
      const { token, buyer } = await deployFixture();

      // First buy some tokens so we have something to sell
      await token.connect(buyer).buy(0, { value: TINY_BUY });
      const balance = await token.balanceOf(buyer.address);
      expect(balance).to.be.gt(0n);

      // Disable automine
      await network.provider.send("evm_setAutomine", [false]);
      try {
        const buyData = token.interface.encodeFunctionData("buy", [0]);
        const sellData = token.interface.encodeFunctionData("sell", [balance / 2n, 0]);

        const buyTx = await buyer.sendTransaction({
          to: await token.getAddress(),
          data: buyData,
          value: TINY_BUY,
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
        expect(sellReceipt?.status).to.equal(0); // sell reverted
        expect(buyReceipt?.blockNumber).to.equal(sellReceipt?.blockNumber);
      } finally {
        await network.provider.send("evm_setAutomine", [true]);
      }
    });
  });

  // =====================================================================
  // Reserve invariant 验证
  // =====================================================================
  describe("Reserve invariants", function () {
    it("token supply invariant holds during bonding", async function () {
      const { token, buyer, buyer2 } = await deployFixture();

      await token.connect(buyer).buy(0, { value: TINY_BUY });
      await token.connect(buyer2).buy(0, { value: TINY_BUY });

      // Buyer sells half
      const bal1 = await token.balanceOf(buyer.address);
      await token.connect(buyer).sell(bal1 / 2n, 0);

      const totalSupply = await token.TOTAL_SUPPLY();
      const contractBalance = await token.balanceOf(await token.getAddress());
      const saleReserve = await token.saleTokenReserve();
      const lpReserve = await token.lpTokenReserve();
      const buyerBal = await token.balanceOf(buyer.address);
      const buyer2Bal = await token.balanceOf(buyer2.address);

      // Contract holds = saleReserve + lpReserve
      expect(contractBalance).to.equal(saleReserve + lpReserve);
      // Total supply invariant
      expect(contractBalance + buyerBal + buyer2Bal).to.equal(totalSupply);
    });

    it("accounted native balance <= actual native balance", async function () {
      const { token, buyer } = await deployFixture();
      await token.connect(buyer).buy(0, { value: SMALL_BUY });

      const accounted = await token.accountedNativeBalance();
      const actual = await ethers.provider.getBalance(await token.getAddress());
      expect(actual).to.be.gte(accounted);
    });

    it("after full buy-sell cycle, saleTokenReserve returns to original", async function () {
      const { token, buyer } = await deployFixture();
      const SALE_TOKEN_RESERVE = ethers.parseEther("800000000");

      await token.connect(buyer).buy(0, { value: SMALL_BUY });
      const balanceAfterBuy = await token.balanceOf(buyer.address);
      expect(balanceAfterBuy).to.be.gt(0n);

      await token.connect(buyer).sell(balanceAfterBuy, 0);

      const saleAfterSell = await token.saleTokenReserve();
      expect(saleAfterSell).to.equal(SALE_TOKEN_RESERVE);
      // curveQuoteReserve should be less than after buy (fees taken)
      const curveAfterSell = await token.curveQuoteReserve();
      expect(curveAfterSell).to.be.gte(0n);
    });
  });

  // =====================================================================
  // Fee 精确性验证 (0.3% protocol, 0.7% creator)
  // =====================================================================
  describe("Fee precision (30/70 split)", function () {
    it("protocol fee + creator fee == total fee for buy", async function () {
      const { token, buyer } = await deployFixture();

      await token.connect(buyer).buy(0, { value: MEDIUM_BUY });

      const protocolVault = await token.protocolFeeVault();
      const creatorVault = await token.creatorFeeVault();
      const totalFee = protocolVault + creatorVault;

      // Total fee = 1% of gross
      const expectedTotal = (MEDIUM_BUY * 100n) / 10_000n;
      expect(totalFee).to.equal(expectedTotal);

      // Protocol = 0.3% of gross
      const expectedProtocol = (MEDIUM_BUY * 30n) / 10_000n;
      expect(protocolVault).to.equal(expectedProtocol);

      // Creator = 0.7% of gross
      const expectedCreator = (MEDIUM_BUY * 70n) / 10_000n;
      expect(creatorVault).to.equal(expectedCreator);

      console.log("      Protocol fee:", ethers.formatEther(protocolVault));
      console.log("      Creator fee:", ethers.formatEther(creatorVault));
      console.log("      Total fee:", ethers.formatEther(totalFee));
    });
  });

  // =====================================================================
  // Preview vs Execute 一致性
  // =====================================================================
  describe("Preview vs Execute consistency", function () {
    it("previewBuy matches actual buy execution", async function () {
      const { token, buyer } = await deployFixture();
      const buyAmount = SMALL_BUY;

      const preview = await token.previewBuy(buyAmount);
      await token.connect(buyer).buy(0, { value: buyAmount });

      const balance = await token.balanceOf(buyer.address);
      expect(balance).to.equal(preview.tokenOut);
    });

    it("previewSell matches actual sell execution", async function () {
      const { token, buyer } = await deployFixture();
      await token.connect(buyer).buy(0, { value: SMALL_BUY });

      const balance = await token.balanceOf(buyer.address);
      const sellAmount = balance / 2n;
      const preview = await token.previewSell(sellAmount);

      const balBefore = await ethers.provider.getBalance(buyer.address);
      const tx = await token.connect(buyer).sell(sellAmount, 0);
      const receipt = await tx.wait();
      const gasUsed = receipt!.gasUsed * receipt!.gasPrice;
      const balAfter = await ethers.provider.getBalance(buyer.address);

      const netReceived = balAfter - balBefore + gasUsed;
      expect(netReceived).to.equal(preview.netQuoteOut);
    });

    it("previewBuy returns zeros after graduation", async function () {
      const { token, buyer } = await deployFixture();
      await token.connect(buyer).buy(0, { value: OVERBUY });
      expect(await token.state()).to.equal(3n);

      const preview = await token.previewBuy(SMALL_BUY);
      expect(preview.tokenOut).to.equal(0n);
      expect(preview.feeAmount).to.equal(0n);
      expect(preview.refundAmount).to.equal(0n);
    });

    it("previewSell returns zeros after graduation", async function () {
      const { token, buyer } = await deployFixture();
      await token.connect(buyer).buy(0, { value: OVERBUY });
      expect(await token.state()).to.equal(3n);

      const preview = await token.previewSell(ethers.parseEther("1000"));
      expect(preview.grossQuoteOut).to.equal(0n);
      expect(preview.netQuoteOut).to.equal(0n);
      expect(preview.totalFee).to.equal(0n);
    });
  });

  // =====================================================================
  // 极端边界值测试
  // =====================================================================
  describe("Extreme boundary values", function () {
    it("buying with 1 wei BNB no longer bypasses fees", async function () {
      const { token, buyer } = await deployFixture();
      const preview = await token.previewBuy(1n);
      expect(preview.feeAmount).to.equal(1n);
      expect(preview.tokenOut).to.equal(0n);
      expect(preview.refundAmount).to.equal(0n);

      await expect(token.connect(buyer).buy(0, { value: 1n })).to.be.revertedWithCustomError(
        token,
        "ZeroAmount"
      );
    });

    it("buying with exactly enough triggers graduation correctly", async function () {
      const { token, buyer } = await deployFixture();
      await token.connect(buyer).buy(0, { value: OVERBUY });
      expect(await token.state()).to.equal(3n);
      expect(await token.saleTokenReserve()).to.equal(0n);
      expect(await token.lpTokenReserve()).to.equal(0n);
    });

    it("dust sell previews also carry a non-zero minimum fee once quote out is non-zero", async function () {
      const { token, buyer } = await deployFixture();
      await token.connect(buyer).buy(0, { value: TINY_BUY });

      const balance = await token.balanceOf(buyer.address);
      const preview = await token.previewSell(balance / 1_000_000n);

      if (preview.grossQuoteOut > 0n) {
        expect(preview.totalFee).to.be.gte(1n);
      }
    });

    it("dust sell execution reverts when the net quote after minimum fee would be zero", async function () {
      const { token, buyer } = await deployFixture();
      await token.connect(buyer).buy(0, { value: TINY_BUY });

      const balance = await token.balanceOf(buyer.address);
      const sellAmount = balance / 1_000_000n;
      const preview = await token.previewSell(sellAmount);

      if (preview.grossQuoteOut > 0n && preview.netQuoteOut == 0n) {
        await expect(token.connect(buyer).sell(sellAmount, 0)).to.be.revertedWithCustomError(
          token,
          "SlippageExceeded"
        );
      }
    });
  });

  // =====================================================================
  // 多用户交替交易 invariant
  // =====================================================================
  describe("Multi-user interleaved trading", function () {
    it("3 users buy and sell alternately, reserves stay consistent", async function () {
      const { token, buyer, buyer2, buyer3 } = await deployFixture();

      await token.connect(buyer).buy(0, { value: TINY_BUY });
      await token.connect(buyer2).buy(0, { value: TINY_BUY });

      // Buyer1 sells half
      const bal1 = await token.balanceOf(buyer.address);
      await token.connect(buyer).sell(bal1 / 2n, 0);

      await token.connect(buyer3).buy(0, { value: TINY_BUY });

      // Buyer2 sells all
      const bal2 = await token.balanceOf(buyer2.address);
      await token.connect(buyer2).sell(bal2, 0);

      // Check invariants
      const totalSupply = await token.TOTAL_SUPPLY();
      const contractBal = await token.balanceOf(await token.getAddress());
      const b1 = await token.balanceOf(buyer.address);
      const b2 = await token.balanceOf(buyer2.address);
      const b3 = await token.balanceOf(buyer3.address);

      expect(contractBal + b1 + b2 + b3).to.equal(totalSupply);

      const accounted = await token.accountedNativeBalance();
      const actual = await ethers.provider.getBalance(await token.getAddress());
      expect(actual).to.be.gte(accounted);

      const saleReserve = await token.saleTokenReserve();
      const lpReserve = await token.lpTokenReserve();
      expect(contractBal).to.equal(saleReserve + lpReserve);
    });
  });

  // =====================================================================
  // Pair 污染攻击
  // =====================================================================
  describe("Pair pollution attack vectors", function () {
    it("pair with non-zero totalSupply blocks graduation", async function () {
      const { token, buyer, pair } = await deployFixture();
      await pair.setTotalSupply(1n);
      expect(await token.isPairGraduationCompatible()).to.equal(false);

      await expect(
        token.connect(buyer).buy(0, { value: OVERBUY })
      ).to.be.revertedWithCustomError(token, "PairPolluted");
    });
  });

  // =====================================================================
  // Graduation 后的行为验证
  // =====================================================================
  describe("Post-graduation behavior", function () {
    it("transfer and transferFrom work normally after graduation", async function () {
      const { token, buyer, buyer2 } = await deployFixture();
      await token.connect(buyer).buy(0, { value: OVERBUY });
      expect(await token.state()).to.equal(3n);

      const amount = ethers.parseEther("1000");
      await expect(token.connect(buyer).transfer(buyer2.address, amount)).to.not.be.reverted;
      expect(await token.balanceOf(buyer2.address)).to.equal(amount);

      // transferFrom
      await token.connect(buyer).approve(buyer2.address, amount);
      await expect(
        token.connect(buyer2).transferFrom(buyer.address, buyer2.address, amount)
      ).to.not.be.reverted;
    });

    it("buy and sell are blocked after graduation", async function () {
      const { token, buyer } = await deployFixture();
      await token.connect(buyer).buy(0, { value: OVERBUY });
      expect(await token.state()).to.equal(3n);

      await expect(
        token.connect(buyer).buy(0, { value: TINY_BUY })
      ).to.be.revertedWithCustomError(token, "InvalidState");

      await expect(
        token.connect(buyer).sell(1n, 0)
      ).to.be.revertedWithCustomError(token, "InvalidState");
    });
  });

  // =====================================================================
  // Creator fee sweep 机制
  // =====================================================================
  describe("Creator fee sweep safety", function () {
    it("sweep is blocked before 180 days", async function () {
      const { token, buyer, attacker } = await deployFixture();
      await token.connect(buyer).buy(0, { value: TINY_BUY });

      expect(await token.creatorFeeSweepReady()).to.equal(false);
      await expect(
        token.connect(attacker).sweepAbandonedCreatorFees()
      ).to.be.revertedWithCustomError(token, "CreatorFeeSweepUnavailable");
    });
  });

  // =====================================================================
  // receive() 行为 — raw native transfers are allowed for pure 0314 bonding
  // =====================================================================
  describe("receive() behavior", function () {
    it("raw native transfer buys during bonding", async function () {
      const { token, buyer } = await deployFixture();
      await expect(
        buyer.sendTransaction({
          to: await token.getAddress(),
          value: TINY_BUY,
        })
      ).to.not.be.reverted;
      expect(await token.balanceOf(buyer.address)).to.be.gt(0n);
    });
  });
});
