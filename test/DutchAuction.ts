import { network } from "hardhat";
import { expect } from "chai";

const { ethers, networkHelpers } = await network.create();

const START_PRICE = ethers.parseEther("1");
const DISCOUNT_RATE = ethers.parseUnits("1", "gwei");
const DURATION = 7n * 24n * 60n * 60n;
const RESERVE_PRICE = ethers.parseEther("0.1");

describe("DutchAuction", function () {
  async function deploy() {
    const [deployer, seller, buyer, other] = await ethers.getSigners();
    const auction = await ethers.deployContract("DutchAuction", [
      seller.address,
      START_PRICE,
      DISCOUNT_RATE,
      DURATION,
      RESERVE_PRICE,
    ]);
    const startTime = await auction.startTime();
    return { auction, deployer, seller, buyer, other, startTime };
  }

  async function priceAtNextBlock(startTime: bigint, secondsAfterStart: bigint) {
    await networkHelpers.time.setNextBlockTimestamp(startTime + secondsAfterStart);
    return START_PRICE - DISCOUNT_RATE * secondsAfterStart;
  }

  describe("Deployment", function () {
    it("Should set constructor params and compute start/end time", async function () {
      const { auction, seller, startTime } = await networkHelpers.loadFixture(deploy);
      expect(await auction.seller()).to.equal(seller.address);
      expect(await auction.startPrice()).to.equal(START_PRICE);
      expect(await auction.discountRate()).to.equal(DISCOUNT_RATE);
      expect(await auction.reservePrice()).to.equal(RESERVE_PRICE);
      expect(await auction.endTime()).to.equal(startTime + DURATION);
      expect(await auction.ended()).to.equal(false);
    });

    it("Should revert if startPrice < reservePrice", async function () {
      const [, seller] = await ethers.getSigners();
      await expect(
        ethers.deployContract("DutchAuction", [seller.address, 100n, 0n, 10n, 200n]),
      ).to.be.revertedWith("Start price below reserve");
    });

    it("Should revert if price would fall below reserve during auction", async function () {
      const [, seller] = await ethers.getSigners();
      await expect(
        ethers.deployContract("DutchAuction", [seller.address, 1000n, 10n, 100n, 500n]),
      ).to.be.revertedWith("Price would fall below reserve");
    });
  });

  describe("Price calculation", function () {
    it("getPrice() returns startPrice at deployment", async function () {
      const { auction } = await networkHelpers.loadFixture(deploy);
      expect(await auction.getPrice()).to.equal(START_PRICE);
    });

    it("getPrice() decreases price over time", async function () {
      const { auction, startTime } = await networkHelpers.loadFixture(deploy);

      await networkHelpers.time.increase(3600);
      const elapsed = BigInt(await networkHelpers.time.latest()) - startTime;
      expect(await auction.getPrice()).to.equal(START_PRICE - DISCOUNT_RATE * elapsed);
      expect(await auction.getPrice()).to.be.lessThan(START_PRICE);
    });

    it("getPrice() returns reservePrice after endTime", async function () {
      const { auction } = await networkHelpers.loadFixture(deploy);
      await networkHelpers.time.increase(DURATION + 1n);
      expect(await auction.getPrice()).to.equal(RESERVE_PRICE);
    });
  });

  describe("Successful buy", function () {
    it("Should set ended = true", async function () {
      const { auction, buyer, startTime } = await networkHelpers.loadFixture(deploy);
      const price = await priceAtNextBlock(startTime, 100n);

      await auction.connect(buyer).buy({ value: price });

      expect(await auction.ended()).to.equal(true);
      expect(await auction.winner()).to.equal(buyer.address);
    });

    it("Should increase seller balance by currentPrice", async function () {
      const { auction, seller, buyer, startTime } = await networkHelpers.loadFixture(deploy);
      const sellerBefore = await ethers.provider.getBalance(seller.address);
      const price = await priceAtNextBlock(startTime, 1000n);

      await auction.connect(buyer).buy({ value: START_PRICE });

      const sellerAfter = await ethers.provider.getBalance(seller.address);
      expect(sellerAfter - sellerBefore).to.equal(price);
    });

    it("Should refund the excess to the buyer", async function () {
      const { auction, buyer, startTime } = await networkHelpers.loadFixture(deploy);
      const buyerBefore = await ethers.provider.getBalance(buyer.address);
      const price = await priceAtNextBlock(startTime, 5000n);
      const sent = START_PRICE;

      const tx = await auction.connect(buyer).buy({ value: sent });
      const receipt = await tx.wait();
      const gasCost = receipt!.fee;

      const buyerAfter = await ethers.provider.getBalance(buyer.address);
      expect(buyerBefore - buyerAfter).to.equal(price + gasCost);
      await expect(tx)
        .to.emit(auction, "Bought")
        .withArgs(buyer.address, price, sent - price);
      expect(await ethers.provider.getBalance(await auction.getAddress())).to.equal(0n);
    });
  });

  describe("Reverts", function () {
    it("Should revert if msg.value < currentPrice", async function () {
      const { auction, buyer, startTime } = await networkHelpers.loadFixture(deploy);
      const price = await priceAtNextBlock(startTime, 10n);

      await expect(
        auction.connect(buyer).buy({ value: price - 1n }),
      ).to.be.revertedWith("Not enough ETH sent");
    });

    it("Should revert on second buy after lot is sold", async function () {
      const { auction, buyer, other } = await networkHelpers.loadFixture(deploy);
      await auction.connect(buyer).buy({ value: START_PRICE });

      await expect(
        auction.connect(other).buy({ value: START_PRICE }),
      ).to.be.revertedWith("Auction already ended");
    });

    it("Should revert buy() after endTime", async function () {
      const { auction, buyer, startTime } = await networkHelpers.loadFixture(deploy);
      await networkHelpers.time.increaseTo(startTime + DURATION);

      await expect(
        auction.connect(buyer).buy({ value: START_PRICE }),
      ).to.be.revertedWith("Auction expired");
    });
  });

  describe("claimRefund", function () {
    it("Seller can close expired unsold auction", async function () {
      const { auction, seller } = await networkHelpers.loadFixture(deploy);
      await networkHelpers.time.increase(DURATION);

      await expect(auction.connect(seller).claimRefund()).to.emit(auction, "AuctionClosed");
      expect(await auction.ended()).to.equal(true);
    });

    it("Should revert before endTime", async function () {
      const { auction, seller } = await networkHelpers.loadFixture(deploy);
      await expect(auction.connect(seller).claimRefund()).to.be.revertedWith(
        "Auction not yet expired",
      );
    });

    it("Should revert for non-seller", async function () {
      const { auction, other } = await networkHelpers.loadFixture(deploy);
      await networkHelpers.time.increase(DURATION);
      await expect(auction.connect(other).claimRefund()).to.be.revertedWith("Only seller");
    });

    it("Should revert if lot was already bought", async function () {
      const { auction, seller, buyer } = await networkHelpers.loadFixture(deploy);
      await auction.connect(buyer).buy({ value: START_PRICE });
      await networkHelpers.time.increase(DURATION);
      await expect(auction.connect(seller).claimRefund()).to.be.revertedWith(
        "Auction already ended",
      );
    });
  });
});
