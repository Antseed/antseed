// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// Gate stand-in for controller tests: controllers get a budget per epoch,
/// mints a plain ERC20 and enforces finalized epochs and bucket budgets.
/// `claimRemainder` mirrors AntseedEmissionsGate: one burn cap per epoch
/// (BURN_CAP_BPS of the epoch emission) shared by every controller; each
/// remainder burns up to what is left of it and sends only the excess to
/// the reserve.
contract EmissionsGateMock is ERC20 {
    address public constant DEAD_ADDRESS = address(0xdead);
    uint256 public constant SHARE_DENOMINATOR = 100_000;
    uint256 public constant BURN_CAP_BPS = 30_000;
    uint256 public currentEpoch = 10;
    address public emissionsReserve = address(0x4E5E);
    mapping(address => mapping(uint256 => uint256)) private _budget;
    mapping(address => mapping(uint256 => uint256)) public minted;
    mapping(uint256 => uint256) private _epochEmission;
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

    /// Stand-in for the gate's halving schedule: sizes the epoch's burn cap.
    function setEpochEmission(uint256 epoch, uint256 amount) external {
        _epochEmission[epoch] = amount;
    }

    function getEpochEmission(uint256 epoch) public view returns (uint256) {
        return _epochEmission[epoch];
    }

    function controllerEpochBudget(address controller, uint256 epoch) external view returns (uint256) {
        return _budget[controller][epoch];
    }

    function claim(uint256 epoch, address recipient, uint256 amount) external {
        _charge(epoch, amount);
        _mint(recipient, amount);
    }

    function claimRemainder(uint256 epoch, address reserveRecipient, uint256 amount)
        external
        returns (uint256 burnedAmount, uint256 reserveAmount)
    {
        if (reserveRecipient != emissionsReserve) revert InvalidValue();
        _charge(epoch, amount);

        uint256 burnCap = (getEpochEmission(epoch) * BURN_CAP_BPS) / SHARE_DENOMINATOR;
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
