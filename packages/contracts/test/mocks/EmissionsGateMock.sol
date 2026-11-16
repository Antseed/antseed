// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// Gate stand-in for controller tests: one controller, a budget per epoch,
/// mints a plain ERC20 and enforces finalized epochs and bucket budgets.
contract EmissionsGateMock is ERC20 {
    address public constant DEAD_ADDRESS = address(0xdead);
    uint256 public currentEpoch = 10;
    address public emissionsReserve = address(0x4E5E);
    mapping(address => mapping(uint256 => uint256)) private _budget;
    mapping(address => mapping(uint256 => uint256)) public minted;
    /// Per-epoch burn cap shared by every controller (the real gate's
    /// `BURN_CAP_BPS` share of the epoch emission). Unset means 0: nothing
    /// burns, so tests must model the cap explicitly to see any burn.
    mapping(uint256 => uint256) public epochBurnCap;
    /// Burn already consumed this epoch by any controller's remainder.
    mapping(uint256 => uint256) public epochBurnedAmount;

    error EpochNotFinalized();
    error BucketBudgetExceeded();
    error InvalidValue();

    constructor() ERC20("ANTS", "ANTS") { }

    function setCurrentEpoch(uint256 epoch) external {
        currentEpoch = epoch;
    }

    function setBudget(address controller, uint256 epoch, uint256 amount) external {
        _budget[controller][epoch] = amount;
    }

    function setEpochBurnCap(uint256 epoch, uint256 cap) external {
        epochBurnCap[epoch] = cap;
    }

    /// Simulate other controllers having already burned part of the cap.
    function setEpochBurned(uint256 epoch, uint256 amount) external {
        epochBurnedAmount[epoch] = amount;
    }

    function controllerEpochBudget(address controller, uint256 epoch) external view returns (uint256) {
        return _budget[controller][epoch];
    }

    function claim(uint256 epoch, address recipient, uint256 amount) external {
        _charge(epoch, amount);
        _mint(recipient, amount);
    }

    /// Mirrors AntseedEmissionsGate.claimRemainder: burn up to whatever is
    /// left of the epoch's shared burn cap, reserve the excess.
    function claimRemainder(uint256 epoch, address reserveRecipient, uint256 amount)
        external
        returns (uint256 burnedAmount, uint256 reserveAmount)
    {
        if (reserveRecipient != emissionsReserve) revert InvalidValue();
        _charge(epoch, amount);
        uint256 burnCap = epochBurnCap[epoch];
        uint256 alreadyBurned = epochBurnedAmount[epoch];
        if (alreadyBurned < burnCap) {
            uint256 remainingBurn = burnCap - alreadyBurned;
            burnedAmount = amount < remainingBurn ? amount : remainingBurn;
            epochBurnedAmount[epoch] = alreadyBurned + burnedAmount;
        }
        reserveAmount = amount - burnedAmount;
        if (burnedAmount != 0) _mint(DEAD_ADDRESS, burnedAmount);
        if (reserveAmount != 0) _mint(reserveRecipient, reserveAmount);
    }

    function _charge(uint256 epoch, uint256 amount) private {
        if (amount == 0) revert InvalidValue();
        if (epoch >= currentEpoch) revert EpochNotFinalized();
        uint256 next = minted[msg.sender][epoch] + amount;
        if (next > _budget[msg.sender][epoch]) revert BucketBudgetExceeded();
        minted[msg.sender][epoch] = next;
    }
}
