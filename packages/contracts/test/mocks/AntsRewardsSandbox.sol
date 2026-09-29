pragma solidity ^0.8.24;

contract AntsRewardsSandboxWashStatus {
    mapping(address => bool) public isProvenWashTrader;

    function setWashTrader(address seller, bool value) external {
        isProvenWashTrader[seller] = value;
    }
}

contract AntsRewardsSandboxRevertingUnlockPolicy {
    function canClaimSellerUnlocked(address) external pure returns (bool) {
        revert("sandbox policy unavailable");
    }
}
