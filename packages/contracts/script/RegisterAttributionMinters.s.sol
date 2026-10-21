// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";

interface IAttributionMintersGate {
    function owner() external view returns (address);
    function currentEpoch() external view returns (uint256);
    function GENESIS() external view returns (uint256);
    function EPOCH_DURATION() external view returns (uint256);
    function minters(bytes32 id) external view returns (address controller, uint32 shareBps, bool editable);
    function setMinter(bytes32 id, address controller, uint32 shareBps, bool editable) external;
}

/**
 * @title RegisterAttributionMinters
 * @notice Registers the AIP-6 buckets on the emissions gate by splitting the
 *         AIP-2 verification bucket (10%): verification 4%, builders (client
 *         rewards) 4%, referrals 2%. The total minter share is unchanged.
 *
 * Run by the gate owner after AntseedReferrals and AntseedClientRewards are
 * deployed and wired, before AntseedRegistry.setStats(statsV2). Every share
 * change takes effect from the next epoch; the script refuses to start near an
 * epoch boundary so all three land in the same epoch.
 *
 * Required env:
 *   EMISSIONS_GATE
 *   GATE_OWNER
 *   ANTSEED_REFERRALS
 *   ANTSEED_CLIENT_REWARDS
 *
 * Usage:
 *   cd packages/contracts
 *   source .env
 *   forge script script/RegisterAttributionMinters.s.sol --rpc-url $BASE_MAINNET_RPC_URL --account <owner> --broadcast
 */
contract RegisterAttributionMinters is Script {
    bytes32 public constant VERIFICATION_MINTER_ID = keccak256("antseed.emissions.verification.v1");
    bytes32 public constant CLIENT_REWARDS_MINTER_ID = keccak256("antseed.emissions.client-rewards.v1");
    bytes32 public constant REFERRALS_MINTER_ID = keccak256("antseed.emissions.referrals.v1");

    uint32 public constant PREVIOUS_VERIFICATION_SHARE_BPS = 10_000;
    uint32 public constant VERIFICATION_SHARE_BPS = 4_000;
    uint32 public constant CLIENT_REWARDS_SHARE_BPS = 4_000;
    uint32 public constant REFERRALS_SHARE_BPS = 2_000;

    function run() external {
        IAttributionMintersGate gate = IAttributionMintersGate(vm.envAddress("EMISSIONS_GATE"));
        address owner = vm.envAddress("GATE_OWNER");
        require(gate.owner() == owner, "GATE_OWNER does not own the gate");

        uint256 nextBoundary = gate.GENESIS() + (gate.currentEpoch() + 1) * gate.EPOCH_DURATION();
        require(nextBoundary - block.timestamp > 1 hours, "too close to epoch boundary; run earlier in the epoch");

        vm.startBroadcast(owner);
        _register(gate, vm.envAddress("ANTSEED_REFERRALS"), vm.envAddress("ANTSEED_CLIENT_REWARDS"));
        vm.stopBroadcast();

        console.log("Shares from epoch", gate.currentEpoch() + 1);
        console.log("  verification   4%");
        console.log("  client rewards 4%:", vm.envAddress("ANTSEED_CLIENT_REWARDS"));
        console.log("  referrals      2%:", vm.envAddress("ANTSEED_REFERRALS"));
    }

    /// @dev Shrink verification first so the total never passes 100% between calls.
    function _register(IAttributionMintersGate gate, address referrals, address clientRewards) internal {
        require(referrals != address(0) && clientRewards != address(0), "missing controller");
        (address verification, uint32 verificationShare, bool verificationEditable) =
            gate.minters(VERIFICATION_MINTER_ID);
        require(verification != address(0) && verificationEditable, "verification minter missing or locked");
        require(verificationShare == PREVIOUS_VERIFICATION_SHARE_BPS, "unexpected verification share");
        (address existingReferrals,,) = gate.minters(REFERRALS_MINTER_ID);
        (address existingClients,,) = gate.minters(CLIENT_REWARDS_MINTER_ID);
        require(existingReferrals == address(0) && existingClients == address(0), "already registered");

        gate.setMinter(VERIFICATION_MINTER_ID, verification, VERIFICATION_SHARE_BPS, true);
        gate.setMinter(CLIENT_REWARDS_MINTER_ID, clientRewards, CLIENT_REWARDS_SHARE_BPS, true);
        gate.setMinter(REFERRALS_MINTER_ID, referrals, REFERRALS_SHARE_BPS, true);
    }
}
