// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IAntseedSellerPools {
    event StakingSourceSet(address indexed stakingSource);
    event StakeCreated(
        uint256 indexed positionId,
        address indexed staker,
        uint256 indexed agentId,
        uint256 amount,
        uint256 weightAmount,
        uint256 stakeStartEpoch,
        uint256 stakeEndEpoch
    );
    event StakeMoved(
        uint256 indexed oldPositionId,
        uint256 indexed newPositionId,
        address indexed staker,
        uint256 fromAgentId,
        uint256 toAgentId
    );
    event StakeSplit(
        uint256 indexed positionId,
        uint256 indexed firstPositionId,
        uint256 indexed secondPositionId,
        address staker,
        uint256 firstAmount,
        uint256 secondAmount
    );
    event StakesMerged(
        uint256[] positionIds, uint256 indexed newPositionId, address indexed staker, uint256 amount, uint256 weightAmount
    );
    event StakeWithdrawn(
        uint256 indexed positionId, address indexed staker, uint256 returnedAmount, uint256 slashedAmount
    );
    event RewardStakerSet(address indexed rewardStaker, bool allowed);
    event StakerRewardsRestaked(
        address indexed staker,
        uint256 indexed sourcePositionId,
        uint256 indexed newPositionId,
        uint256 amount,
        uint256 weightAmount,
        uint256 stakeStartEpoch,
        uint256 stakeEndEpoch
    );
    event MaxLockEnabled(uint256 indexed positionId, address indexed staker, uint256 effectiveEpoch);
    event MaxLockDisabled(
        uint256 indexed positionId, address indexed staker, uint256 effectiveEpoch, uint256 stakeEndEpoch
    );
    event LockExtended(
        uint256 indexed positionId, address indexed staker, uint256 effectiveEpoch, uint256 stakeEndEpoch
    );
    event PoolConfigSet(
        uint256 minStakeEpochs,
        uint256 stakeActivationDelay,
        uint256 maxSlashBps,
        uint256 minEarlyExitSlashBps
    );
    event RestakedRewardWeightBonusSet(uint256 bonusBps);
    event MoveWeightPenaltySet(uint256 penaltyBps);
    event StakerActiveStakeUpdated(
        address indexed staker, uint256 indexed agentId, uint256 totalActiveStake, uint256 agentActiveStake
    );

    error InvalidAddress();
    error InvalidValue();
    error InvalidPosition();
    error NotPositionOwner();
    error StakeDurationOutOfBounds();
    error PositionClosed();
    error PositionChangePending();
    error AlreadyWithdrawn();
    error NotRewardStaker();

    function stake(uint256 agentId, uint256 amount, uint256 stakeEpochs) external returns (uint256 positionId);
    function stakeFor(address staker, uint256 agentId, uint256 amount, uint256 stakeEpochs)
        external
        returns (uint256 positionId);
    function moveStake(uint256 positionId, uint256 toAgentId) external returns (uint256 newPositionId);
    function moveStakes(uint256[] calldata positionIds, uint256 toAgentId)
        external
        returns (uint256[] memory newPositionIds);
    function splitStake(uint256 positionId, uint256 splitAmount)
        external
        returns (uint256 firstPositionId, uint256 secondPositionId);
    function mergeStakes(uint256[] calldata positionIds) external returns (uint256 newPositionId);
    function extendLock(uint256 positionId, uint256 additionalEpochs) external;
    function enableMaxLock(uint256 positionId) external;
    function disableMaxLock(uint256 positionId) external;
    function withdrawStake(uint256 positionId) external;
    function withdrawStakes(uint256[] calldata positionIds)
        external
        returns (uint256 returnedAmount, uint256 slashedAmount);
    function stakeMintedReward(address staker, uint256 sourcePositionId, uint256 amount, uint256 stakeEpochs)
        external
        returns (uint256 newPositionId);
    function ownerOf(uint256 positionId) external view returns (address owner);
    function setRestakedRewardWeightBonus(uint256 bonusBps) external;
    function setMoveWeightPenalty(uint256 penaltyBps) external;
    function setRewardStaker(address rewardStaker, bool allowed) external;
    function setPoolConfig(
        uint256 minStakeEpochs,
        uint256 stakeActivationDelay,
        uint256 maxSlashBps,
        uint256 minEarlyExitSlashBps
    ) external;
    function stakingSource() external view returns (address);

    function antsToken() external view returns (IERC20);
    function currentEpoch() external view returns (uint256);
    function stakeActivationDelay() external view returns (uint256);
    function agentIdForSeller(address seller) external view returns (uint256);
    function positionWithdrawableEpoch(uint256 positionId) external view returns (uint64);

    function hasPoolAtEpoch(uint256 agentId, uint256 epoch) external view returns (bool);
    function hasPoolAtEpoch(address seller, uint256 epoch) external view returns (bool);
    function poolWeightAtEpoch(uint256 agentId, uint256 epoch) external view returns (uint256 weight);
    function poolWeightAtEpoch(address seller, uint256 epoch) external view returns (uint256 weight);
    function positionWeightAtEpoch(uint256 positionId, uint256 epoch) external view returns (uint256 weight);
    function positionMaxLockPowerAtEpoch(uint256 positionId, uint256 epoch) external view returns (uint256 power);
    function positionPowerSegmentAt(uint256 positionId, uint256 epoch)
        external
        view
        returns (uint256 normalEndEpoch, uint256 maxLockPower, uint256 nextChangeEpoch);
    function totalPowerWeightAtEpoch(uint256 epoch) external view returns (uint256 weight);
    function currentPoolSecurityWeight(uint256 agentId) external returns (uint256 weight);
    function currentPoolSecurityWeight(address seller) external returns (uint256 weight);
    function currentTotalSecurityWeight() external returns (uint256 weight);
    function currentPoolSecurityShareBps(uint256 agentId) external returns (uint256 shareBps);
    function currentPoolSecurityShareBps(address seller) external returns (uint256 shareBps);

    function stakerTotalActiveStake(address staker) external view returns (uint256);
    function stakerAgentActiveStake(address staker, uint256 agentId) external view returns (uint256);
    function stakerPositionCount(address staker) external view returns (uint256);
    function stakerPositionIdAt(address staker, uint256 index) external view returns (uint256);
    function stakerPositionIds(address staker, uint256 offset, uint256 limit)
        external
        view
        returns (uint256[] memory);
    function poolActiveStakeAtEpoch(uint256 agentId, uint256 epoch) external view returns (uint256 activeStake);
    function poolActiveStakeAtEpoch(address seller, uint256 epoch) external view returns (uint256 activeStake);
    function totalActiveStakeAtEpoch(uint256 epoch) external view returns (uint256 activeStake);
    function positions(uint256 positionId)
        external
        view
        returns (
            address owner,
            uint256 agentId,
            uint256 amount,
            uint256 weightAmount,
            uint64 stakeStartEpoch,
            uint64 stakeEndEpoch,
            uint64 closedAtEpoch,
            bool withdrawn
        );
}
