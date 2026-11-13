// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable2Step.sol";

import { IERC8004Registry } from "../interfaces/IERC8004Registry.sol";
import { IAntseedSellerPools } from "../interfaces/IAntseedSellerPools.sol";
import { IAntseedStaking } from "../interfaces/IAntseedStaking.sol";

/**
 * @title AntseedSellerRegistry
 * @notice Seller identity and eligibility adapter for the seller-pool era.
 *
 *         AntseedChannels already reads registry.staking() for two things:
 *         seller eligibility via isStakedAboveMin() and agent stats via getAgentId().
 *         This contract preserves that interface while moving the economic stake
 *         signal to AntseedSellerPools.
 *
 *         Agent identity is stored locally for new sellers and falls back to the
 *         deprecated USDC staking contract for sellers that registered before
 *         the pool migration. Eligibility requires both an agent identity and an
 *         active seller pool with enough active ANTS stake in the current epoch.
 *
 *         Important behavior:
 *           - This contract is an adapter for existing channel checks. It does
 *             not custody stake and does not create seller pools.
 *           - `stakeFor` is deliberately unsupported here. ANTS staking must go
 *             through AntseedSellerPools.
 *           - Seller registration binds a seller address to an ERC-8004 agent
 *             id for routing and legacy compatibility. Economic pool ownership
 *             remains agent-id based in AntseedSellerPools.
 *           - ERC-8004 ownership is the source of truth for that binding. A
 *             seller resolves to an agent only while it still owns it, so an
 *             agent transfer immediately ends the old binding — local or
 *             legacy — without the new owner having to register.
 */
contract AntseedSellerRegistry is IAntseedStaking, Ownable2Step {
    // ─── External Contracts ──────────────────────────────────────────
    address public immutable identityRegistry;
    IAntseedSellerPools public sellerPools;
    IAntseedStaking public legacyStaking;

    // ─── Eligibility Config ──────────────────────────────────────────
    uint256 public minSellerPoolStake = 1;

    /// @notice Migration switch: while true, sellers staked above min in the
    ///         legacy USDC staking contract stay channel-eligible even without
    ///         an active ANTS seller pool. Existing mainnet sellers cannot
    ///         acquire pool stake at cutover (ANTS transfers may be disabled
    ///         and new stake activates next epoch), so cutting registry.staking
    ///         to this adapter without the fallback would brick all new
    ///         channel creation. Disable once seller pools are seeded.
    bool public legacyStakeEligibilityEnabled = true;

    // ─── Seller-Agent Bindings ───────────────────────────────────────
    mapping(address => uint256) private _sellerAgentId;
    mapping(uint256 => address) public agentSeller;

    // ─── Events ──────────────────────────────────────────────────────
    event SellerPoolsSet(address indexed sellerPools);
    event LegacyStakingSet(address indexed legacyStaking);
    event MinSellerPoolStakeSet(uint256 minSellerPoolStake);
    event LegacyStakeEligibilitySet(bool enabled);
    event SellerRegistered(address indexed seller, uint256 indexed agentId);

    // ─── Custom Errors ───────────────────────────────────────────────
    error InvalidAddress();
    error InvalidValue();
    error NotAgentOwner();
    error AgentIdMismatch();
    error AgentAlreadyBound();
    error UnsupportedStakeOperation();

    // ─── Constructor ─────────────────────────────────────────────────
    constructor(address _identityRegistry, address _sellerPools, address _legacyStaking) Ownable(msg.sender) {
        if (_identityRegistry == address(0) || _sellerPools == address(0)) revert InvalidAddress();
        identityRegistry = _identityRegistry;
        sellerPools = IAntseedSellerPools(_sellerPools);
        legacyStaking = IAntseedStaking(_legacyStaking);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        CORE — REGISTER SELLER
    // ═══════════════════════════════════════════════════════════════════

    function registerSeller(uint256 agentId) external {
        if (agentId == 0) revert InvalidValue();
        if (IERC8004Registry(identityRegistry).ownerOf(agentId) != msg.sender) revert NotAgentOwner();

        // A seller stays limited to one agent, but an agent it has since sold
        // must not lock the address out of registering a replacement.
        uint256 existingAgentId = _sellerAgentId[msg.sender];
        if (existingAgentId != 0 && existingAgentId != agentId) {
            if (_ownsAgent(msg.sender, existingAgentId)) revert AgentIdMismatch();
            if (agentSeller[existingAgentId] == msg.sender) agentSeller[existingAgentId] = address(0);
        }

        uint256 legacyAgentId = _legacyAgentId(msg.sender);
        if (legacyAgentId != 0 && legacyAgentId != agentId && _ownsAgent(msg.sender, legacyAgentId)) {
            revert AgentIdMismatch();
        }

        address existingSeller = agentSeller[agentId];
        if (existingSeller != address(0) && existingSeller != msg.sender && _sellerAgentId[existingSeller] == agentId) {
            _sellerAgentId[existingSeller] = 0;
        }

        _sellerAgentId[msg.sender] = agentId;
        agentSeller[agentId] = msg.sender;
        emit SellerRegistered(msg.sender, agentId);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        VIEWS
    // ═══════════════════════════════════════════════════════════════════

    function getStake(address seller) public view returns (uint256) {
        return _stakeForAgent(getAgentId(seller));
    }

    function isStakedAboveMin(address seller) external view returns (bool) {
        uint256 agentId = getAgentId(seller);
        if (agentId == 0) return false;
        if (_stakeForAgent(agentId) >= minSellerPoolStake) return true;
        return _legacyStakedAboveMin(seller);
    }

    function _stakeForAgent(uint256 agentId) internal view returns (uint256) {
        IAntseedSellerPools pools = sellerPools;
        uint256 epoch = pools.currentEpoch();
        if (agentId == 0 || !pools.hasPoolAtEpoch(agentId, epoch)) return 0;
        return pools.poolActiveStakeAtEpoch(agentId, epoch);
    }

    function getAgentId(address seller) public view returns (uint256) {
        uint256 agentId = _sellerAgentId[seller];
        if (agentId == 0) agentId = _legacyAgentId(seller);
        if (agentId == 0) return 0;
        return _ownsAgent(seller, agentId) ? agentId : 0;
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        UNSUPPORTED LEGACY STAKE SURFACE
    // ═══════════════════════════════════════════════════════════════════

    function stakeFor(address, uint256, uint256) external pure {
        revert UnsupportedStakeOperation();
    }

    /// @dev Legacy USDC stake stays in the legacy staking contract and is
    ///      msg.sender-attributed there, so it cannot be forwarded from here.
    ///      To unstake a seller contract's legacy deposit, temporarily point
    ///      registry.staking back at the legacy contract.
    function unstake() external pure {
        revert UnsupportedStakeOperation();
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        ADMIN FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════

    function setSellerPools(address _sellerPools) external onlyOwner {
        if (_sellerPools == address(0)) revert InvalidAddress();
        sellerPools = IAntseedSellerPools(_sellerPools);
        emit SellerPoolsSet(_sellerPools);
    }

    function setLegacyStaking(address _legacyStaking) external onlyOwner {
        legacyStaking = IAntseedStaking(_legacyStaking);
        emit LegacyStakingSet(_legacyStaking);
    }

    function setMinSellerPoolStake(uint256 value) external onlyOwner {
        minSellerPoolStake = value;
        emit MinSellerPoolStakeSet(value);
    }

    function setLegacyStakeEligibilityEnabled(bool enabled) external onlyOwner {
        legacyStakeEligibilityEnabled = enabled;
        emit LegacyStakeEligibilitySet(enabled);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        INTERNAL HELPERS
    // ═══════════════════════════════════════════════════════════════════

    function _legacyStakedAboveMin(address seller) internal view returns (bool) {
        if (!legacyStakeEligibilityEnabled) return false;
        IAntseedStaking legacy = legacyStaking;
        if (address(legacy) == address(0)) return false;

        try legacy.isStakedAboveMin(seller) returns (bool staked) {
            return staked;
        } catch {
            return false;
        }
    }

    /// @dev Fails closed rather than reverting: AntseedChannels is already
    ///      deployed and calls getAgentId() unguarded while settling and
    ///      closing, so a revert here would trap buyer funds in a channel.
    function _ownsAgent(address seller, uint256 agentId) internal view returns (bool) {
        try IERC8004Registry(identityRegistry).ownerOf(agentId) returns (address owner) {
            return owner == seller;
        } catch {
            return false;
        }
    }

    function _legacyAgentId(address seller) internal view returns (uint256) {
        IAntseedStaking legacy = legacyStaking;
        if (address(legacy) == address(0)) return 0;
        return legacy.getAgentId(seller);
    }
}
