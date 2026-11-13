// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IAntseedUsageAccounting {
    struct BuyerUsage {
        uint256 points;
        uint256 weightedPoints;
    }

    struct SellerUsage {
        uint256 points;
        uint256 weightedPoints;
    }

    struct UsageTotals {
        BuyerUsage buyers;
        SellerUsage sellers;
    }

    event SellerPoolsSet(address indexed sellerPools);
    event PointsPolicySet(address indexed policy);
    event PoolWeightPolicySet(address indexed policy);
    event MinimumAccountedPoolPowerSet(uint256 minimumPoolPower);
    event UsageRecorderSet(address indexed recorder, bool allowed);
    event LegacySellerAccrualPending(address indexed seller, uint256 indexed epoch, uint256 pointsDelta);
    event UsagePointsAccrued(
        uint256 indexed epoch,
        address indexed buyer,
        address indexed seller,
        uint256 agentId,
        uint256 rawPoints,
        uint256 buyerPoints,
        uint256 sellerPoints,
        uint256 poolPower,
        uint256 poolWeight,
        uint256 weightedBuyerPoints,
        uint256 weightedSellerPoints
    );
    event AccrualSkippedWhilePaused(address indexed seller, address indexed buyer, uint256 pointsDelta);
    event PointsPolicyFailed(bytes32 indexed channelId, address indexed buyer, address indexed seller, uint256 rawPoints);
    event PoolWeightPolicyFailed(uint256 indexed agentId, uint256 indexed epoch, uint256 poolPower);
    event UsageRewardsSet(address indexed usageRewards);

    error InvalidAddress();
    error InvalidValue();
    error NoPendingSellerAccrual();
    error UsageRewardsNotSet();

    function currentEpoch() external view returns (uint256);
    function pendingSellerAccrual() external view returns (address seller);

    function accrueSellerPoints(address seller, uint256 pointsDelta) external;
    function accrueBuyerPoints(address buyer, uint256 pointsDelta) external;
    function accruePoints(bytes32 channelId, address buyer, address seller, uint256 pointsDelta) external;
    function setPointsPolicy(address policy) external;
    function setPoolWeightPolicy(address policy) external;
    function setMinimumAccountedPoolPower(uint256 minimumPoolPower) external;
    function minimumAccountedPoolPower() external view returns (uint256);

    function setUsageRewards(address rewards) external;
    function pendingEmissions(address account, uint256[] calldata epochs)
        external
        view
        returns (uint256 totalSeller, uint256 totalBuyer);
    function claimSellerEmissions(uint256[] calldata epochs) external;

    function totalUsage() external view returns (UsageTotals memory);
    function epochUsage(uint256 epoch) external view returns (UsageTotals memory);
    function buyerUsageTotal(address buyer) external view returns (BuyerUsage memory);
    function buyerAgentUsageTotal(address buyer, uint256 agentId) external view returns (BuyerUsage memory);
    function buyerEpochUsage(uint256 epoch, address buyer) external view returns (BuyerUsage memory);
    function buyerAgentEpochUsage(uint256 epoch, address buyer, uint256 agentId)
        external
        view
        returns (BuyerUsage memory);
    function agentEpochUsage(uint256 epoch, uint256 agentId) external view returns (SellerUsage memory);
    function totalBuyerPointsByEpoch(uint256 epoch) external view returns (uint256);
    function totalSellerPointsByEpoch(uint256 epoch) external view returns (uint256);
    function totalPoolPointsByEpoch(uint256 epoch) external view returns (uint256);
    function totalWeightedPoolPointsByEpoch(uint256 epoch) external view returns (uint256);
    function totalWeightedBuyerPointsByEpoch(uint256 epoch) external view returns (uint256);
    function sellerAgentIdByEpoch(uint256 epoch, address seller) external view returns (uint256);
    function buyerPointsByEpoch(uint256 epoch, address buyer) external view returns (uint256);
    function sellerPointsByEpoch(uint256 epoch, address seller) external view returns (uint256);
    function agentPoolPointsByEpoch(uint256 epoch, uint256 agentId) external view returns (uint256);
    function poolPointsByEpoch(uint256 epoch, address seller) external view returns (uint256);
    function weightedPoolPointsByEpoch(uint256 epoch, uint256 agentId) external view returns (uint256);
    function weightedPoolPointsByEpoch(uint256 epoch, address seller) external view returns (uint256);
    function weightedBuyerPointsByEpoch(uint256 epoch, address buyer) external view returns (uint256);
}
