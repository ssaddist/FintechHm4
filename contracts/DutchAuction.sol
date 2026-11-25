// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract DutchAuction {
    address payable public immutable seller;
    uint256 public immutable startPrice;
    uint256 public immutable discountRate;
    uint256 public immutable duration;
    uint256 public immutable reservePrice;

    uint256 public immutable startTime;
    uint256 public immutable endTime;

    bool public ended;
    address public winner;

    event Bought(address indexed buyer, uint256 price, uint256 refund);
    event AuctionClosed();

    constructor(
        address payable _seller,
        uint256 _startPrice,
        uint256 _discountRate,
        uint256 _duration,
        uint256 _reservePrice
    ) {
        require(_seller != address(0), "Invalid seller");
        require(_startPrice >= _reservePrice, "Start price below reserve");
        require(
            _discountRate * _duration <= _startPrice - _reservePrice,
            "Price would fall below reserve"
        );

        seller = _seller;
        startPrice = _startPrice;
        discountRate = _discountRate;
        duration = _duration;
        reservePrice = _reservePrice;

        startTime = block.timestamp;
        endTime = block.timestamp + _duration;
    }

    function getPrice() public view returns (uint256) {
        if (block.timestamp >= endTime) {
            return reservePrice;
        }
        return startPrice - discountRate * (block.timestamp - startTime);
    }

    function buy() external payable {
        require(!ended, "Auction already ended");
        require(block.timestamp < endTime, "Auction expired");

        uint256 currentPrice = getPrice();
        require(msg.value >= currentPrice, "Not enough ETH sent");

        ended = true;
        winner = msg.sender;
        uint256 refund = msg.value - currentPrice;

        (bool sentToSeller, ) = seller.call{value: currentPrice}("");
        require(sentToSeller, "Transfer to seller failed");

        if (refund > 0) {
            (bool refunded, ) = payable(msg.sender).call{value: refund}("");
            require(refunded, "Refund failed");
        }

        emit Bought(msg.sender, currentPrice, refund);
    }

    function claimRefund() external {
        require(msg.sender == seller, "Only seller");
        require(block.timestamp >= endTime, "Auction not yet expired");
        require(!ended, "Auction already ended");

        ended = true;
        emit AuctionClosed();
    }
}
