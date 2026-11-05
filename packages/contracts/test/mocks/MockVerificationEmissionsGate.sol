// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal emissions gate for verification reward tests: one controller budget per epoch.
contract MockVerificationEmissionsGate {
    uint256 public currentEpoch;
    uint256 public genesis;
    uint256 public epochDuration = 7 days;
    mapping(address controller => mapping(uint256 epoch => uint256 budget)) public controllerEpochBudget;
    mapping(uint256 epoch => uint256 minted) public epochMinted;
    mapping(address recipient => uint256 amount) public minted;
    mapping(uint256 epoch => uint256 amount) public remainderClaimed;
    address public emissionsReserve;

    error EpochNotFinalized();
    error BucketBudgetExceeded();
    error InvalidAddress();

    function setCurrentEpoch(uint256 epoch) external {
        currentEpoch = epoch;
    }

    /// @notice Sets the schedule `verifier run` and `verifier submit` read the epoch window from.
    function setSchedule(uint256 genesis_, uint256 epochDuration_) external {
        genesis = genesis_;
        epochDuration = epochDuration_;
    }

    function setBudget(address controller, uint256 epoch, uint256 budget) external {
        controllerEpochBudget[controller][epoch] = budget;
    }

    function setEmissionsReserve(address reserve) external {
        emissionsReserve = reserve;
    }

    /// @notice One minter id per controller; the mock tracks minted amounts per epoch only.
    function controllerMinterIds(address controller) external pure returns (bytes32) {
        return keccak256(abi.encode(controller));
    }

    function minterEpochMinted(bytes32, uint256 epoch) external view returns (uint256) {
        return epochMinted[epoch];
    }

    /// @notice Simulates an earlier controller of the same minter id having minted `amount` for `epoch`.
    function setPriorMinted(uint256 epoch, uint256 amount) external {
        epochMinted[epoch] += amount;
    }

    /// @notice Burn is not modelled: the whole remainder goes to the reserve.
    function claimRemainder(uint256 epoch, address reserveRecipient, uint256 amount)
        external
        returns (uint256 burnedAmount, uint256 reserveAmount)
    {
        if (reserveRecipient == address(0) || reserveRecipient != emissionsReserve) revert InvalidAddress();
        _charge(epoch, amount);
        remainderClaimed[epoch] += amount;
        minted[reserveRecipient] += amount;
        return (0, amount);
    }

    function claim(uint256 epoch, address recipient, uint256 amount) external {
        _charge(epoch, amount);
        minted[recipient] += amount;
    }

    function _charge(uint256 epoch, uint256 amount) private {
        if (epoch >= currentEpoch) revert EpochNotFinalized();
        epochMinted[epoch] += amount;
        if (epochMinted[epoch] > controllerEpochBudget[msg.sender][epoch]) revert BucketBudgetExceeded();
    }
}
