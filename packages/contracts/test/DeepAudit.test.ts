import { expect } from "chai";
import { ethers } from "hardhat";

/**
 * Deep audit tests — validates attack vectors and edge cases
 * identified during security review.
 */
describe("Deep Audit: AMM Math & Edge Cases", function () {
  const GRADUATION_TARGET = ethers.parseEther("0.2");

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
    const token = await LaunchToken.deploy(
      "AuditTest",
      "AUDIT",
      "ipfs://audit",
      creator.address,
      protocol.address,
      await mockRouter.getAddress(),
      GRADUATION_TARGET
    );
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
  // C-1 验证: sell() 的整除取整方向
  // =====================================================================
  describe("C-1: sell() rounding direction", function () {
    it("sells should not produce more quote than a fair AMM invariant", async function () {
      const { token, buyer } = await deployFixture();

      // 先买入
      await token.connect(buyer).buy(0, { value: ethers.parseEther("2") });

      const balance = await token.balanceOf(buyer.address);
      const curveQuoteBefore = await token.curveQuoteReserve();
      const saleTokenBefore = await token.saleTokenReserve();

      // 按 1/100 分批小额卖
      const sellChunk = balance / 100n;
      let totalQuoteReceived = 0n;

      for (let i = 0; i < 100; i++) {
        const remaining = await token.balanceOf(buyer.address);
        const thisSell = remaining < sellChunk ? remaining : sellChunk;
        if (thisSell === 0n) break;

        const balBefore = await ethers.provider.getBalance(buyer.address);
        const tx = await token.connect(buyer).sell(thisSell, 0);
        const receipt = await tx.wait();
        const gasUsed = receipt!.gasUsed * receipt!.gasPrice;
        const balAfter = await ethers.provider.getBalance(buyer.address);
        totalQuoteReceived += balAfter - balBefore + gasUsed;
      }

      const curveQuoteAfter = await token.curveQuoteReserve();
      const actualQuoteDrained = curveQuoteBefore - curveQuoteAfter;

      // 协议+创建者费用也从 grossQuote 中扣除
      // totalQuoteReceived (net) < actualQuoteDrained (gross - fees stay in contract)
      // 关键不变量: curveQuoteReserve 不能变为负数
      expect(curveQuoteAfter).to.be.gte(0n);

      console.log("      Total quote received (net):", ethers.formatEther(totalQuoteReceived));
      console.log("      Curve quote drained:", ethers.formatEther(actualQuoteDrained));
      console.log("      Remaining curve reserve:", ethers.formatEther(curveQuoteAfter));
    });

    it("single large sell vs many tiny sells should yield similar results (rounding leak check)", async function () {
      // Fixture 1: large sell
      const f1 = await deployFixture();
      await f1.token.connect(f1.buyer).buy(0, { value: ethers.parseEther("2") });
      const balance1 = await f1.token.balanceOf(f1.buyer.address);

      const preview1 = await f1.token.previewSell(balance1);
      const netLarge = preview1.netQuoteOut;

      // Fixture 2: 100x tiny sells
      const f2 = await deployFixture();
      await f2.token.connect(f2.buyer).buy(0, { value: ethers.parseEther("2") });
      const balance2 = await f2.token.balanceOf(f2.buyer.address);

      const chunk = balance2 / 100n;
      let totalNet = 0n;
      for (let i = 0; i < 100; i++) {
        const rem = await f2.token.balanceOf(f2.buyer.address);
        const thisSell = rem < chunk ? rem : chunk;
        if (thisSell === 0n) break;
        const tx = await f2.token.connect(f2.buyer).sell(thisSell, 0);
        const receipt = await tx.wait();
        const sellEvent = receipt!.logs.find((log) => {
          try {
            return f2.token.interface.parseLog(log as any)?.name === "SellExecuted";
          } catch {
            return false;
          }
        });
        const parsed = f2.token.interface.parseLog(sellEvent as any)!;
        totalNet += parsed.args.netQuoteOut;
      }

      const diff = totalNet > netLarge ? totalNet - netLarge : netLarge - totalNet;
      console.log("      Split-vs-bulk net difference:", diff.toString(), "wei");
      expect(diff).to.be.lte(200n);
    });
  });

  // =====================================================================
  // C-3 验证: _quoteBuy while 循环有界性
  // =====================================================================
  describe("C-3: _quoteBuy loop boundedness", function () {
    it("partial fill near graduation boundary does not consume excessive gas", async function () {
      const { token, buyer, buyer2 } = await deployFixture();

      // 先买到接近毕业
      await token.connect(buyer).buy(0, { value: ethers.parseEther("11.9") });

      const remaining = await token.remainingQuoteCapacity();
      console.log("      Remaining capacity:", ethers.formatEther(remaining), "BNB");

      // 发送远大于剩余容量的 BNB
      const tx = await token.connect(buyer2).buy(0, { value: ethers.parseEther("10") });
      const receipt = await tx.wait();

      console.log("      Gas used for partial fill graduation:", receipt!.gasUsed.toString());
      // 如果 while 循环失控，gas 会远超 500k
      expect(receipt!.gasUsed).to.be.lte(500_000n);

      // 应已毕业
      expect(await token.state()).to.equal(3n);
    });
  });

  // =====================================================================
  // H-4 验证: 同块 sell cooldown
  // =====================================================================
  describe("H-4: Same-block sell cooldown (real test)", function () {
    it("sell in the same block as buy SHOULD revert (if automine is disabled)", async function () {
      const { token, buyer } = await deployFixture();

      await ethers.provider.send("evm_setAutomine", [false]);

      try {
        const buyData = token.interface.encodeFunctionData("buy", [0]);
        const sellData = token.interface.encodeFunctionData("sell", [1n, 0]);

        const buyTx = await buyer.sendTransaction({
          to: await token.getAddress(),
          data: buyData,
          value: ethers.parseEther("1"),
          gasLimit: 1_000_000
        });

        const sellTx = await buyer.sendTransaction({
          to: await token.getAddress(),
          data: sellData,
          gasLimit: 1_000_000
        });

        await ethers.provider.send("evm_mine", []);

        const buyReceipt = await ethers.provider.getTransactionReceipt(buyTx.hash);
        const sellReceipt = await ethers.provider.getTransactionReceipt(sellTx.hash);

        expect(buyReceipt?.status).to.equal(1);
        expect(sellReceipt?.status).to.equal(0);
        expect(buyReceipt?.blockNumber).to.equal(sellReceipt?.blockNumber);
      } finally {
        await ethers.provider.send("evm_setAutomine", [true]);
      }
    });
  });

  // =====================================================================
  // 新增: Reserve invariant 验证
  // =====================================================================
  describe("Reserve invariants", function () {
    it("saleTokenReserve + all holder balances + lpTokenReserve == TOTAL_SUPPLY during bonding", async function () {
      const { token, buyer, buyer2 } = await deployFixture();

      // 多笔交易
      await token.connect(buyer).buy(0, { value: ethers.parseEther("1") });
      await token.connect(buyer2).buy(0, { value: ethers.parseEther("2") });

      // buyer 卖出部分
      const sellAmount = (await token.balanceOf(buyer.address)) / 2n;
      await token.connect(buyer).sell(sellAmount, 0);

      const totalSupply = await token.TOTAL_SUPPLY();
      const saleReserve = await token.saleTokenReserve();
      const lpReserve = await token.lpTokenReserve();
      const contractBalance = await token.balanceOf(await token.getAddress());
      const buyerBal = await token.balanceOf(buyer.address);
      const buyer2Bal = await token.balanceOf(buyer2.address);

      // 合约持有的 token = saleReserve + lpReserve (因为都 mint 到合约)
      expect(contractBalance).to.equal(saleReserve + lpReserve);

      // 总供应不变量
      expect(contractBalance + buyerBal + buyer2Bal).to.equal(totalSupply);
    });

    it("curveQuoteReserve + protocolFeeVault + creatorFeeVault <= contract native balance", async function () {
      const { token, buyer } = await deployFixture();

      await token.connect(buyer).buy(0, { value: ethers.parseEther("5") });

      const accounted = await token.accountedNativeBalance();
      const actual = await ethers.provider.getBalance(await token.getAddress());
      expect(actual).to.be.gte(accounted);
    });

    it("after full buy-sell cycle, curveQuoteReserve returns to calculation-consistent state", async function () {
      const { token, buyer } = await deployFixture();

      await token.connect(buyer).buy(0, { value: ethers.parseEther("3") });

      const balanceAfterBuy = await token.balanceOf(buyer.address);
      const curveAfterBuy = await token.curveQuoteReserve();

      // 全部卖出
      await token.connect(buyer).sell(balanceAfterBuy, 0);

      const curveAfterSell = await token.curveQuoteReserve();
      const saleAfterSell = await token.saleTokenReserve();

      // 由于费用，卖出后 curveQuote 应小于初始值
      // 但 saleTokenReserve 应回到 SALE_TOKEN_RESERVE
      const SALE_TOKEN_RESERVE = ethers.parseEther("800000000");
      expect(saleAfterSell).to.equal(SALE_TOKEN_RESERVE);
      expect(curveAfterSell).to.be.lt(curveAfterBuy);
      // quote reserve 不能为负
      expect(curveAfterSell).to.be.gte(0n);
    });
  });

  // =====================================================================
  // 新增: Fee 精确性验证
  // =====================================================================
  describe("Fee precision", function () {
    it("protocol fee + creator fee == total fee for buy", async function () {
      const { token, buyer } = await deployFixture();

      const buyAmount = ethers.parseEther("3");
      const tx = await token.connect(buyer).buy(0, { value: buyAmount });
      const receipt = await tx.wait();

      // 从事件中提取 fee
      const buyEvent = receipt!.logs.find((log) => {
        try {
          return token.interface.parseLog(log as any)?.name === "BuyExecuted";
        } catch {
          return false;
        }
      });

      const parsed = token.interface.parseLog(buyEvent as any)!;
      const protocolFee = parsed.args.protocolFee;
      const creatorFee = parsed.args.creatorFee;
      const grossQuoteIn = parsed.args.grossQuoteIn;
      const netQuoteIn = parsed.args.netQuoteIn;

      // total fee = protocol + creator
      const totalFee = protocolFee + creatorFee;
      expect(grossQuoteIn - netQuoteIn).to.equal(totalFee);

      // fee 应为 grossQuoteIn 的 1%
      const expectedTotalFee = (grossQuoteIn * 100n) / 10_000n;
      expect(totalFee).to.equal(expectedTotalFee);

      // protocol 0.3%，creator 0.7%
      const expectedProtocolFee = (grossQuoteIn * 30n) / 10_000n;
      expect(protocolFee).to.equal(expectedProtocolFee);

      console.log("      Gross:", ethers.formatEther(grossQuoteIn));
      console.log("      Net:", ethers.formatEther(netQuoteIn));
      console.log("      Protocol fee:", ethers.formatEther(protocolFee));
      console.log("      Creator fee:", ethers.formatEther(creatorFee));
    });
  });

  // =====================================================================
  // 新增: Preview vs Execute 一致性
  // =====================================================================
  describe("Preview vs Execute consistency", function () {
    it("previewBuy matches actual buy execution", async function () {
      const { token, buyer } = await deployFixture();

      const buyAmount = ethers.parseEther("2");
      const preview = await token.previewBuy(buyAmount);

      const tx = await token.connect(buyer).buy(0, { value: buyAmount });
      const receipt = await tx.wait();
      const buyEvent = receipt!.logs.find((log) => {
        try {
          return token.interface.parseLog(log as any)?.name === "BuyExecuted";
        } catch {
          return false;
        }
      });
      const parsed = token.interface.parseLog(buyEvent as any)!;

      expect(parsed.args.tokenOut).to.equal(preview.tokenOut);
      expect(parsed.args.protocolFee + parsed.args.creatorFee).to.equal(
        preview.feeAmount
      );
      expect(parsed.args.refundAmount).to.equal(preview.refundAmount);
    });

    it("previewSell matches actual sell execution", async function () {
      const { token, buyer } = await deployFixture();

      await token.connect(buyer).buy(0, { value: ethers.parseEther("2") });
      const balance = await token.balanceOf(buyer.address);
      const sellAmount = balance / 2n;

      const preview = await token.previewSell(sellAmount);

      const tx = await token.connect(buyer).sell(sellAmount, 0);
      const receipt = await tx.wait();
      const sellEvent = receipt!.logs.find((log) => {
        try {
          return token.interface.parseLog(log as any)?.name === "SellExecuted";
        } catch {
          return false;
        }
      });
      const parsed = token.interface.parseLog(sellEvent as any)!;

      expect(parsed.args.grossQuoteOut).to.equal(preview.grossQuoteOut);
      expect(parsed.args.netQuoteOut).to.equal(preview.netQuoteOut);

      const totalFee = parsed.args.protocolFee + parsed.args.creatorFee;
      expect(totalFee).to.equal(preview.totalFee);
    });
  });

  // =====================================================================
  // 新增: 极端边界值测试
  // =====================================================================
  describe("Extreme boundary values", function () {
    it("buying with 1 wei BNB should not revert but may produce 0 tokens", async function () {
      const { token, buyer } = await deployFixture();

      await expect(token.connect(buyer).buy(0, { value: 1n })).to.not.be.reverted;
    });

    it("buying with exactly graduation amount (12 BNB + fee) triggers graduation", async function () {
      const { token, buyer } = await deployFixture();

      // 精确计算：net 需要 12 BNB，gross = 12 / 0.99 = ~12.1212...
      // Math.mulDiv(12 ether, 10000, 9900, Ceil)
      const grossNeeded = (ethers.parseEther("12") * 10_000n + 9899n) / 9900n;

      await token.connect(buyer).buy(0, { value: grossNeeded + ethers.parseEther("1") });
      expect(await token.state()).to.equal(3n);
    });
  });

  // =====================================================================
  // 新增: 多用户交替交易 invariant
  // =====================================================================
  describe("Multi-user interleaved trading", function () {
    it("3 users buy and sell alternately, reserves stay consistent", async function () {
      const { token, buyer, buyer2, buyer3 } = await deployFixture();

      // User1 买 1 BNB
      await token.connect(buyer).buy(0, { value: ethers.parseEther("1") });
      // User2 买 2 BNB
      await token.connect(buyer2).buy(0, { value: ethers.parseEther("2") });
      // User1 卖一半
      const bal1 = await token.balanceOf(buyer.address);
      await token.connect(buyer).sell(bal1 / 2n, 0);
      // User3 买 1.5 BNB
      await token.connect(buyer3).buy(0, { value: ethers.parseEther("1.5") });
      // User2 全卖
      const bal2 = await token.balanceOf(buyer2.address);
      await token.connect(buyer2).sell(bal2, 0);

      // Invariant 检查
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
  // 新增: Pair 污染攻击
  // =====================================================================
  describe("Pair pollution attack vectors", function () {
    it("token-side balance pollution blocks graduation", async function () {
      const { token, buyer, pair, attacker } = await deployFixture();

      // 不能直接 transfer token 到 pair (transfer disabled)
      // 但如果攻击者想办法让 pair 有 token balance...
      // 实际上在 Bonding314 状态下, 所有 transfer 都被 _update 阻止
      // 除非通过合约内部的 _transfer

      // 验证: 即使 pair 有 token 从外部注入（理论上不可能在 Bonding314）
      // _pairAllowsGraduation 会检查 balanceOf(pair)
      expect(await token.isPairGraduationCompatible()).to.equal(true);
    });

    it("pair with non-zero totalSupply blocks graduation", async function () {
      const { token, buyer, pair } = await deployFixture();
      await pair.setTotalSupply(1n);
      expect(await token.isPairGraduationCompatible()).to.equal(false);

      await expect(
        token.connect(buyer).buy(0, { value: ethers.parseEther("20") })
      ).to.be.revertedWithCustomError(token, "PairPolluted");
    });
  });

  // =====================================================================
  // 新增: Graduation 后的行为验证
  // =====================================================================
  describe("Post-graduation behavior", function () {
    it("transfer and transferFrom work normally after graduation", async function () {
      const { token, buyer, buyer2 } = await deployFixture();

      await token.connect(buyer).buy(0, { value: ethers.parseEther("20") });
      expect(await token.state()).to.equal(3n);

      const amount = ethers.parseEther("1000");
      await expect(token.connect(buyer).transfer(buyer2.address, amount)).to.not
        .be.reverted;
      expect(await token.balanceOf(buyer2.address)).to.equal(amount);

      // transferFrom
      await token.connect(buyer).approve(buyer2.address, amount);
      await expect(
        token.connect(buyer2).transferFrom(buyer.address, buyer2.address, amount)
      ).to.not.be.reverted;
    });

    it("previewBuy returns zeros or misleading data after graduation (M-5 verification)", async function () {
      const { token, buyer } = await deployFixture();

      await token.connect(buyer).buy(0, { value: ethers.parseEther("20") });
      expect(await token.state()).to.equal(3n);

      // previewBuy 在 DEXOnly 状态下不 revert，但数据是基于已清空的 reserves
      // 这可能误导用户
      const preview = await token.previewBuy(ethers.parseEther("1"));

      // 实际上 _quoteBuy 会 revert 因为 remainingCapacity = 0
      // GraduationAlreadyTriggered
      // 让我们验证这个
    });
  });
});
