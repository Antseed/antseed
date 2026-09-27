// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// Gate stand-in for controller tests: one controller, a budget per epoch,
/// mints a plain ERC20 and enforces finalized epochs and bucket budgets.
contract EmissionsGateMock is ERC20 {
    uint256 public currentEpoch = 10;
    mapping(address => mapping(uint256 => uint256)) private _budget;
    mapping(address => mapping(uint256 => uint256)) public minted;

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

    function controllerEpochBudget(address controller, uint256 epoch) external view returns (uint256) {
        return _budget[controller][epoch];
    }

    function claim(uint256 epoch, address recipient, uint256 amount) external {
        if (amount == 0) revert InvalidValue();
        if (epoch >= currentEpoch) revert EpochNotFinalized();
        uint256 next = minted[msg.sender][epoch] + amount;
        if (next > _budget[msg.sender][epoch]) revert BucketBudgetExceeded();
        minted[msg.sender][epoch] = next;
        _mint(recipient, amount);
    }
}
