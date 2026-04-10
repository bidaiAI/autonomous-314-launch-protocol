import { expect } from "chai";
import { ethers, network } from "hardhat";

describe("LaunchTokenTaxed", function () {
  const GRADUATION_TARGET = ethers.parseEther("0.2");
  const OVERBUY = ethers.parseEther("1");

  async function deployFixture() {
    const [deployer, creator, protocol, buyer, treasury, other] = await ethers.getSigners();

    const MockWNATIVE = await ethers.getContractFactory("MockERC20");
    const wbnb = await MockWNATIVE.deploy("Wrapped Native", "WNATIVE");
    await wbnb.waitForDeployment();

    const MockFactory = await ethers.getContractFactory("MockDexV2Factory");
    const mockFactory = await MockFactory.deploy();
    await mockFactory.waitForDeployment();

    const MockRouter = await ethers.getContractFactory("MockDexV2Router");
    const mockRouter = await MockRouter.deploy(await mockFactory.getAddress(), await wbnb.getAddress());
    await mockRouter.waitForDeployment();

    const LaunchTokenTaxed = await ethers.getContractFactory("LaunchTokenTaxed");
    const token = await LaunchTokenTaxed.deploy({
      name: "Taxed314",
      symbol: "T314",
      metadataURI: "ipfs://taxed",
      creator: creator.address,
      factory: deployer.address,
      protocolFeeRecipient: protocol.address,
      router: await mockRouter.getAddress(),
      graduationQuoteReserve: GRADUATION_TARGET,
      launchModeId: 7,
      taxBps: 500,
      burnShareBps: 4000,
      treasuryShareBps: 6000,
      treasuryWallet: treasury.address,
    });
    await token.waitForDeployment();

    const pairAddress = await token.pair();
    const pair = await ethers.getContractAt("MockDexV2Pair", pairAddress);

    return { creator, buyer, treasury, other, token, pair, mockFactory };
  }

  it("only taxes registered pool transfers after graduation and leaves wallet transfers untaxed", async function () {
    const { buyer, treasury, token, pair } = await deployFixture();

    await token.connect(buyer).buy(0, { value: OVERBUY });
    expect(await token.state()).to.equal(3n);
    expect(await token.isTaxablePool(await pair.getAddress())).to.equal(true);

    const buyerBalance = await token.balanceOf(buyer.address);
    const walletTransfer = buyerBalance / 10n;
    await token.connect(buyer).transfer(treasury.address, walletTransfer);
    expect(await token.balanceOf(treasury.address)).to.equal(walletTransfer);

    const deadBefore = await token.balanceOf("0x000000000000000000000000000000000000dEaD");
    const treasuryBefore = await token.balanceOf(treasury.address);
    const pairBefore = await token.balanceOf(await pair.getAddress());

    const taxableAmount = walletTransfer;
    await token.connect(buyer).transfer(await pair.getAddress(), taxableAmount);

    const expectedTax = taxableAmount * 500n / 10_000n;
    const expectedBurn = expectedTax * 4000n / 10_000n;
    const expectedTreasury = expectedTax - expectedBurn;
    const expectedPairReceive = taxableAmount - expectedTax;

    expect(await token.balanceOf(await pair.getAddress())).to.equal(pairBefore + expectedPairReceive);
    expect(await token.balanceOf(treasury.address)).to.equal(treasuryBefore + expectedTreasury);
    expect(await token.balanceOf("0x000000000000000000000000000000000000dEaD")).to.equal(deadBefore + expectedBurn);
  });

  it("does not tax unregistered secondary pools until the creator explicitly registers them", async function () {
    const { creator, buyer, treasury, token, mockFactory } = await deployFixture();

    await token.connect(buyer).buy(0, { value: OVERBUY });

    const MockQuote = await ethers.getContractFactory("MockERC20");
    const altQuote = await MockQuote.deploy("Alt Quote", "ALT");
    await altQuote.waitForDeployment();

    await mockFactory.createPair(await token.getAddress(), await altQuote.getAddress());
    const altPairAddress = await mockFactory.getPair(await token.getAddress(), await altQuote.getAddress());
    const altPair = await ethers.getContractAt("MockDexV2Pair", altPairAddress);

    const taxableAmount = (await token.balanceOf(buyer.address)) / 10n;
    const dead = "0x000000000000000000000000000000000000dEaD";
    const treasuryBeforeUntaxed = await token.balanceOf(treasury.address);
    const deadBeforeUntaxed = await token.balanceOf(dead);

    await token.connect(buyer).transfer(await altPair.getAddress(), taxableAmount);

    expect(await token.balanceOf(treasury.address)).to.equal(treasuryBeforeUntaxed);
    expect(await token.balanceOf(dead)).to.equal(deadBeforeUntaxed);
    expect(await token.balanceOf(await altPair.getAddress())).to.equal(taxableAmount);

    await expect(token.connect(creator).setTaxablePool(await altPair.getAddress(), true))
      .to.emit(token, "TaxablePoolUpdated")
      .withArgs(await altPair.getAddress(), true, false);

    expect(await token.isTaxablePool(await altPair.getAddress())).to.equal(true);

    const treasuryBeforeTaxed = await token.balanceOf(treasury.address);
    const deadBeforeTaxed = await token.balanceOf(dead);
    const pairBeforeTaxed = await token.balanceOf(await altPair.getAddress());

    await token.connect(buyer).transfer(await altPair.getAddress(), taxableAmount);

    const expectedTax = taxableAmount * 500n / 10_000n;
    const expectedBurn = expectedTax * 4000n / 10_000n;
    const expectedTreasury = expectedTax - expectedBurn;

    expect(await token.balanceOf(await altPair.getAddress())).to.equal(pairBeforeTaxed + taxableAmount - expectedTax);
    expect(await token.balanceOf(treasury.address)).to.equal(treasuryBeforeTaxed + expectedTreasury);
    expect(await token.balanceOf(dead)).to.equal(deadBeforeTaxed + expectedBurn);
  });

  it("only lets the creator manage taxable pools and rejects non-pool addresses or canonical pair removal", async function () {
    const { buyer, creator, other, token, pair } = await deployFixture();

    await token.connect(buyer).buy(0, { value: OVERBUY });

    await expect(token.connect(other).setTaxablePool(other.address, true)).to.be.revertedWithCustomError(
      token,
      "UnauthorizedTaxablePoolManager"
    );

    await expect(token.connect(creator).setTaxablePool(other.address, true)).to.be.revertedWithCustomError(
      token,
      "InvalidTaxablePool"
    );

    await expect(token.connect(creator).setTaxablePool(await pair.getAddress(), false)).to.be.revertedWithCustomError(
      token,
      "CanonicalTaxablePoolRequired"
    );
  });

  it("taxes pair-origin transfers after graduation", async function () {
    const { buyer, treasury, token, pair } = await deployFixture();

    await token.connect(buyer).buy(0, { value: OVERBUY });
    const buyerBalance = await token.balanceOf(buyer.address);
    const taxableAmount = buyerBalance / 10n;
    await token.connect(buyer).transfer(await pair.getAddress(), taxableAmount);

    const pairAddress = await pair.getAddress();
    await network.provider.request({ method: "hardhat_impersonateAccount", params: [pairAddress] });
    await network.provider.send("hardhat_setBalance", [pairAddress, "0x1000000000000000000"]);
    const pairSigner = await ethers.getSigner(pairAddress);

    const deadBefore = await token.balanceOf("0x000000000000000000000000000000000000dEaD");
    const treasuryBefore = await token.balanceOf(treasury.address);
    const grossOut = taxableAmount / 2n;

    await token.connect(pairSigner).transfer(buyer.address, grossOut);

    const expectedTax = grossOut * 500n / 10_000n;
    const expectedBurn = expectedTax * 4000n / 10_000n;
    const expectedTreasury = expectedTax - expectedBurn;
    const expectedNet = grossOut - expectedTax;

    expect(await token.balanceOf(buyer.address)).to.be.gte(expectedNet);
    expect(await token.balanceOf(treasury.address)).to.equal(treasuryBefore + expectedTreasury);
    expect(await token.balanceOf("0x000000000000000000000000000000000000dEaD")).to.equal(deadBefore + expectedBurn);

    await network.provider.request({ method: "hardhat_stopImpersonatingAccount", params: [pairAddress] });
  });
});
