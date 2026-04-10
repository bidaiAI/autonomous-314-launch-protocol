import { expect } from "chai";
import { ethers } from "hardhat";

describe("LaunchToken curve profile", function () {
  const GRADUATION_TARGET = ethers.parseEther("12");
  const STEP_NET_QUOTE = ethers.parseEther("1");
  const TOTAL_SUPPLY = ethers.parseEther("1000000000");
  const LP_TOKEN_RESERVE = ethers.parseEther("200000000");
  const SALE_TOKEN_RESERVE = TOTAL_SUPPLY - LP_TOKEN_RESERVE;
  const CURVE_VIRTUAL_TOKEN_RESERVE = ethers.parseEther("107036752");
  const BPS_DENOMINATOR = 10_000n;
  const TOTAL_FEE_BPS = 100n;

  function ceilDiv(value: bigint, divisor: bigint) {
    return (value + divisor - 1n) / divisor;
  }

  function splitFee(grossAmount: bigint) {
    return ceilDiv(grossAmount * TOTAL_FEE_BPS, BPS_DENOMINATOR);
  }

  function grossForNet(netAmount: bigint) {
    let grossAmount = ceilDiv(netAmount * BPS_DENOMINATOR, BPS_DENOMINATOR - TOTAL_FEE_BPS);
    while (grossAmount > 0n) {
      const netCheck = grossAmount - splitFee(grossAmount);
      if (netCheck <= netAmount) {
        if (netCheck === netAmount) return grossAmount;
        break;
      }
      grossAmount -= 1n;
    }

    while (grossAmount - splitFee(grossAmount) < netAmount) {
      grossAmount += 1n;
    }

    return grossAmount;
  }

  function virtualQuoteReserveFor(graduationQuoteReserve: bigint) {
    return (graduationQuoteReserve * (LP_TOKEN_RESERVE + CURVE_VIRTUAL_TOKEN_RESERVE)) / SALE_TOKEN_RESERVE;
  }

  function curveTokenOut(
    curveQuoteReserve: bigint,
    saleTokenReserve: bigint,
    netQuoteIn: bigint,
    graduationQuoteReserve: bigint
  ) {
    if (curveQuoteReserve + netQuoteIn === graduationQuoteReserve) {
      return saleTokenReserve;
    }

    const virtualQuoteReserve = virtualQuoteReserveFor(graduationQuoteReserve);
    const effectiveQuoteReserve = curveQuoteReserve + virtualQuoteReserve;
    const effectiveTokenReserve = saleTokenReserve + LP_TOKEN_RESERVE + CURVE_VIRTUAL_TOKEN_RESERVE;
    const invariant = effectiveQuoteReserve * effectiveTokenReserve;
    const newEffectiveTokenReserve = invariant / (effectiveQuoteReserve + netQuoteIn);
    return effectiveTokenReserve - newEffectiveTokenReserve;
  }

  async function deployFixture() {
    const [deployer, creator, protocol, ...traders] = await ethers.getSigners();

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
    const token = await LaunchToken.deploy({
      name: "CurveProfile",
      symbol: "CPRO",
      metadataURI: "ipfs://curve-profile",
      creator: creator.address,
      factory: deployer.address,
      protocolFeeRecipient: protocol.address,
      router: await mockRouter.getAddress(),
      graduationQuoteReserve: GRADUATION_TARGET,
      launchModeId: 1
    });
    await token.waitForDeployment();

    return { token, traders };
  }

  function findEvent(receipt: any, name: string) {
    return receipt.logs.find((log: any) => "fragment" in log && log.fragment?.name === name);
  }

  it("matches the scaled official BNB curve on the 1→11 BNB buy path", async function () {
    const { token, traders } = await deployFixture();
    const stepGrossQuote = grossForNet(STEP_NET_QUOTE);
    const expectedFee = stepGrossQuote - STEP_NET_QUOTE;

    expect(await token.virtualTokenReserve()).to.equal(CURVE_VIRTUAL_TOKEN_RESERVE);
    expect(await token.virtualQuoteReserve()).to.equal(virtualQuoteReserveFor(GRADUATION_TARGET));

    let curveQuoteReserve = 0n;
    let saleTokenReserve = SALE_TOKEN_RESERVE;

    for (let step = 1; step <= 11; step += 1) {
      const expectedTokenOut = curveTokenOut(
        curveQuoteReserve,
        saleTokenReserve,
        STEP_NET_QUOTE,
        GRADUATION_TARGET
      );

      const preview = await token.previewBuy(stepGrossQuote);
      expect(preview.tokenOut).to.equal(expectedTokenOut);
      expect(preview.feeAmount).to.equal(expectedFee);
      expect(preview.refundAmount).to.equal(0n);

      const tx = await token.connect(traders[step - 1]).buy(0, { value: stepGrossQuote });
      const receipt = await tx.wait();
      const buyEvent = findEvent(receipt!, "BuyExecuted");

      expect(buyEvent).to.not.equal(undefined);
      expect(buyEvent!.args.grossQuoteIn).to.equal(stepGrossQuote);
      expect(buyEvent!.args.netQuoteIn).to.equal(STEP_NET_QUOTE);
      expect(buyEvent!.args.tokenOut).to.equal(expectedTokenOut);

      curveQuoteReserve += STEP_NET_QUOTE;
      saleTokenReserve -= expectedTokenOut;

      expect(await token.curveQuoteReserve()).to.equal(curveQuoteReserve);
      expect(await token.saleTokenReserve()).to.equal(saleTokenReserve);
      expect(await token.state()).to.equal(1n);
    }
  });

  it("sells the 11→1 BNB path back symmetrically in reverse order", async function () {
    const { token, traders } = await deployFixture();
    const stepGrossQuote = grossForNet(STEP_NET_QUOTE);
    const expectedSellFee = splitFee(STEP_NET_QUOTE);
    const positions: Array<{ trader: (typeof traders)[number]; tokenOut: bigint }> = [];

    for (let step = 0; step < 11; step += 1) {
      const receipt = await (await token.connect(traders[step]).buy(0, { value: stepGrossQuote })).wait();
      const buyEvent = findEvent(receipt!, "BuyExecuted");
      positions.push({ trader: traders[step], tokenOut: buyEvent!.args.tokenOut });
    }

    let curveQuoteReserve = 11n * STEP_NET_QUOTE;
    for (let index = positions.length - 1; index >= 0; index -= 1) {
      const position = positions[index];
      const preview = await token.previewSell(position.tokenOut);
      expect(preview.grossQuoteOut).to.equal(STEP_NET_QUOTE);
      expect(preview.totalFee).to.equal(expectedSellFee);
      expect(preview.netQuoteOut).to.equal(STEP_NET_QUOTE - expectedSellFee);

      const tx = await token.connect(position.trader).sell(position.tokenOut, 0);
      const receipt = await tx.wait();
      const sellEvent = findEvent(receipt!, "SellExecuted");

      expect(sellEvent).to.not.equal(undefined);
      expect(sellEvent!.args.tokenIn).to.equal(position.tokenOut);
      expect(sellEvent!.args.grossQuoteOut).to.equal(STEP_NET_QUOTE);
      expect(sellEvent!.args.netQuoteOut).to.equal(STEP_NET_QUOTE - expectedSellFee);

      curveQuoteReserve -= STEP_NET_QUOTE;
      expect(await token.curveQuoteReserve()).to.equal(curveQuoteReserve);
    }

    expect(await token.curveQuoteReserve()).to.equal(0n);
    expect(await token.saleTokenReserve()).to.equal(SALE_TOKEN_RESERVE);
  });

  it("graduates cleanly on the 12th 1 BNB step", async function () {
    const { token, traders } = await deployFixture();
    const stepGrossQuote = grossForNet(STEP_NET_QUOTE);

    for (let step = 0; step < 11; step += 1) {
      await token.connect(traders[step]).buy(0, { value: stepGrossQuote });
    }

    const remainingSaleTokenReserve = await token.saleTokenReserve();
    const preview = await token.previewBuy(stepGrossQuote);
    expect(preview.refundAmount).to.equal(0n);
    expect(preview.tokenOut).to.equal(remainingSaleTokenReserve);

    await token.connect(traders[11]).buy(0, { value: stepGrossQuote });

    expect(await token.state()).to.equal(3n);
    expect(await token.balanceOf(traders[11].address)).to.equal(remainingSaleTokenReserve);
    expect(await token.saleTokenReserve()).to.equal(0n);
    expect(await token.lpTokenReserve()).to.equal(0n);

    const dexReserves = await token.dexReserves();
    expect(dexReserves[0]).to.equal(LP_TOKEN_RESERVE);
    expect(dexReserves[1]).to.equal(GRADUATION_TARGET);
  });
});
