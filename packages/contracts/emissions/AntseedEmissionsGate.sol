// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import { IANTSToken } from "../interfaces/IANTSToken.sol";
import { IAntseedEmissionsGate } from "../interfaces/IAntseedEmissionsGate.sol";

/**
 * @title AntseedEmissionsGate
 * @notice Canonical ANTS mint authority and immutable emission curve.
 *
 *         Each offchain minter id controls one emission plan. The id owns the
 *         epoch share and minted amount; the configured controller is only the
 *         address currently authorized to mint against that id.
 */
contract AntseedEmissionsGate is IAntseedEmissionsGate, Ownable2Step, ReentrancyGuard {
    struct ShareCheckpoint {
        uint256 startEpoch;
        uint32 shareBps;
    }

    address public constant ANTS_TOKEN = 0xa87EE81b2C0Bc659307ca2D9ffdC38514DD85263;
    uint256 public constant GENESIS = 1_775_728_461;
    uint256 public constant EPOCH_DURATION = 7 days;
    uint256 public constant HALVING_INTERVAL = 104;
    uint256 public constant INITIAL_EMISSION = 5_000_000e18;
    uint256 public constant SHARE_DENOMINATOR = 100_000;
    uint256 public constant BURN_CAP_BPS = 30_000;
    address public constant DEAD_ADDRESS = 0x000000000000000000000000000000000000dEaD;
    bytes32 public constant TEAM_MINTER_ID = keccak256("antseed.emissions.team.v1");
    bytes32 public constant RESERVE_MINTER_ID = keccak256("antseed.emissions.reserve.v1");

    IANTSToken private immutable _antsToken;

    uint256 public immutable effectiveEpoch;
    /// @notice Escrow holding the one-time pre-minted backlog covering every
    ///         epoch before `effectiveEpoch`. Once funded, the gate refuses
    ///         pre-effective epochs unconditionally: past epochs belong to the
    ///         escrow, present and future epochs to the minter buckets.
    address public legacyEscrow;
    mapping(uint256 epoch => uint256 amount) public epochMinted;
    mapping(uint256 epoch => uint256 amount) public epochBurnedAmount;

    uint32 public totalMinterShareBps;
    mapping(bytes32 minterId => Minter config) private _minters;
    mapping(address controller => bytes32 minterId) public controllerMinterIds;
    mapping(bytes32 minterId => ShareCheckpoint[] checkpoints) private _minterShareCheckpoints;
    mapping(bytes32 minterId => mapping(uint256 epoch => uint256 amount)) public minterEpochMinted;

    event LegacyEscrowFunded(address indexed escrow, uint256 amount);
    event EmissionClaimed(
        bytes32 indexed minterId, address indexed controller, address indexed recipient, uint256 epoch, uint256 amount
    );
    event EmissionRemainderClaimed(
        bytes32 indexed minterId,
        address indexed controller,
        uint256 indexed epoch,
        uint256 burnedAmount,
        uint256 reserveAmount
    );
    event MinterSet(bytes32 indexed minterId, address indexed controller, uint32 shareBps, bool editable);
    event MinterRemoved(bytes32 indexed minterId, address indexed controller);

    error InvalidAddress();
    error InvalidValue();
    error EpochNotFinalized();
    error NotEmissionMinter();
    error MinterNotEditable();
    error BucketBudgetExceeded();
    error EpochEmissionExceeded();
    error PreEffectiveEpoch();
    error LegacyEscrowAlreadyFunded();
    error LegacyEscrowNotFunded();
    error MintersNotSet();
    error InvalidMinterId();

    constructor(address teamWallet, address protocolReserve, uint32 teamShareBps, uint32 reserveShareBps)
        Ownable(msg.sender)
    {
        if (teamWallet == address(0) || protocolReserve == address(0)) revert InvalidAddress();
        _antsToken = IANTSToken(ANTS_TOKEN);
        uint256 epoch = block.timestamp <= GENESIS ? 0 : (block.timestamp - GENESIS) / EPOCH_DURATION;
        effectiveEpoch = epoch + 1;

        _setMinter(TEAM_MINTER_ID, teamWallet, teamShareBps, false);
        _setMinter(RESERVE_MINTER_ID, protocolReserve, reserveShareBps, false);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        TOKEN AUTH FACADE
    // ═══════════════════════════════════════════════════════════════════

    /// @notice The gate is set as the ANTS token's registry; its mint guard
    ///         reads `registry.emissions()` and must resolve to the gate.
    function emissions() external view returns (address) {
        return address(this);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        OWNER CONFIGURATION
    // ═══════════════════════════════════════════════════════════════════

    function setMinter(bytes32 id, address controller, uint32 shareBps, bool editable) external onlyOwner {
        _setMinter(id, controller, shareBps, editable);
    }

    function setMinterController(bytes32 id, address controller) external onlyOwner {
        _setMinterController(id, controller);
    }

    function removeMinter(bytes32 id) external onlyOwner {
        _removeMinter(id);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        CORE — CLAIMING
    // ═══════════════════════════════════════════════════════════════════

    function claim(uint256 epoch, address recipient, uint256 amount) external nonReentrant {
        _claimFromMinter(controllerMinterIds[msg.sender], msg.sender, epoch, recipient, amount);
    }

    function claimRemainder(uint256 epoch, address reserveRecipient, uint256 amount)
        external
        nonReentrant
        returns (uint256 burnedAmount, uint256 reserveAmount)
    {
        bytes32 id = controllerMinterIds[msg.sender];
        if (amount == 0) revert InvalidValue();

        address expectedReserve = _emissionsReserve();
        if (expectedReserve == address(0) || reserveRecipient != expectedReserve) revert InvalidAddress();

        _chargeMinterBudget(id, msg.sender, epoch, amount);

        uint256 burnCap = _shareBudget(epoch, uint32(BURN_CAP_BPS));
        uint256 alreadyBurned = epochBurnedAmount[epoch];
        if (alreadyBurned < burnCap) {
            uint256 remainingBurn = burnCap - alreadyBurned;
            burnedAmount = amount < remainingBurn ? amount : remainingBurn;
            epochBurnedAmount[epoch] = alreadyBurned + burnedAmount;
        }
        reserveAmount = amount - burnedAmount;

        if (burnedAmount != 0) _antsToken.mint(DEAD_ADDRESS, burnedAmount);
        if (reserveAmount != 0) _antsToken.mint(reserveRecipient, reserveAmount);
        emit EmissionRemainderClaimed(id, msg.sender, epoch, burnedAmount, reserveAmount);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        VIEWS
    // ═══════════════════════════════════════════════════════════════════

    function minters(bytes32 id) external view returns (address controller, uint32 shareBps, bool editable) {
        Minter memory minter = _minters[id];
        return (minter.controller, minter.shareBps, minter.editable);
    }

    function minterEpochBudget(bytes32 id, uint256 epoch) public view returns (uint256) {
        Minter memory minter = _minters[id];
        if (minter.controller == address(0)) return 0;
        return _shareBudget(epoch, _minterShareBpsAt(id, epoch));
    }

    function controllerEpochBudget(address controller, uint256 epoch) public view returns (uint256) {
        return minterEpochBudget(controllerMinterIds[controller], epoch);
    }

    function emissionsReserve() external view returns (address) {
        return _emissionsReserve();
    }

    function currentEpoch() public view returns (uint256) {
        if (block.timestamp <= GENESIS) return 0;
        return (block.timestamp - GENESIS) / EPOCH_DURATION;
    }

    function getEpochEmission(uint256 epoch) public pure returns (uint256) {
        return INITIAL_EMISSION >> (epoch / HALVING_INTERVAL);
    }

    function currentEmissionRate() external view returns (uint256) {
        return getEpochEmission(currentEpoch()) / EPOCH_DURATION;
    }

    function genesis() external pure returns (uint256) {
        return GENESIS;
    }

    function epochDuration() external pure returns (uint256) {
        return EPOCH_DURATION;
    }

    /// @notice Total scheduled emission for epochs `0..epochExclusive-1`.
    function cumulativeEmissionThrough(uint256 epochExclusive) public pure returns (uint256 total) {
        uint256 fullPeriods = epochExclusive / HALVING_INTERVAL;
        for (uint256 period = 0; period < fullPeriods; period++) {
            total += (INITIAL_EMISSION >> period) * HALVING_INTERVAL;
        }
        total += (INITIAL_EMISSION >> fullPeriods) * (epochExclusive % HALVING_INTERVAL);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        ONE-TIME WIRING
    // ═══════════════════════════════════════════════════════════════════

    /// @notice One-time mint of the entire pre-effective backlog into the
    ///         legacy emissions escrow: everything the schedule owes for
    ///         epochs before `effectiveEpoch` that is not already circulating.
    ///         Must run after the token's registry points at this gate. Once
    ///         funded, past epochs are settled in full and no gate minter can
    ///         ever touch them.
    function fundLegacyEscrow(address escrow) external onlyOwner nonReentrant returns (uint256 amount) {
        if (escrow == address(0)) revert InvalidAddress();
        if (legacyEscrow != address(0)) revert LegacyEscrowAlreadyFunded();
        legacyEscrow = escrow;

        uint256 scheduled = cumulativeEmissionThrough(effectiveEpoch);
        uint256 supply = IERC20(ANTS_TOKEN).totalSupply();
        amount = scheduled > supply ? scheduled - supply : 0;
        if (amount != 0) _antsToken.mint(escrow, amount);
        emit LegacyEscrowFunded(escrow, amount);
    }

    function renounceOwnership() public override onlyOwner {
        if (totalMinterShareBps != SHARE_DENOMINATOR) revert MintersNotSet();
        if (legacyEscrow == address(0)) revert LegacyEscrowNotFunded();
        super.renounceOwnership();
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        INTERNAL HELPERS
    // ═══════════════════════════════════════════════════════════════════

    function _setMinter(bytes32 id, address controller, uint32 shareBps, bool editable) internal {
        if (id == bytes32(0)) revert InvalidMinterId();
        if (controller == address(0)) revert InvalidAddress();
        if (shareBps == 0) revert InvalidValue();

        Minter memory existing = _minters[id];
        if (existing.controller != address(0) && !existing.editable) revert MinterNotEditable();

        bytes32 assignedId = controllerMinterIds[controller];
        if (assignedId != bytes32(0) && assignedId != id) revert InvalidMinterId();

        uint32 previousShareBps = existing.controller == address(0) ? 0 : existing.shareBps;
        uint32 nextTotalMinterShareBps = totalMinterShareBps - previousShareBps + shareBps;
        if (nextTotalMinterShareBps > SHARE_DENOMINATOR) revert InvalidValue();

        if (existing.controller != address(0) && existing.controller != controller) {
            delete controllerMinterIds[existing.controller];
        }
        controllerMinterIds[controller] = id;

        totalMinterShareBps = nextTotalMinterShareBps;
        _minters[id] = Minter({ controller: controller, shareBps: shareBps, editable: editable });
        // Every share change — first add included — takes effect from the
        // NEXT epoch, so each epoch's share set is exactly the config at the
        // end of the previous epoch and per-epoch sums can never exceed
        // 100%. A first-time checkpoint any earlier would stack on top of
        // shares that removed/shrunk minters keep for past epochs and let a
        // first-mover drain the global epochMinted cap out from under other
        // buckets' unclaimed rewards.
        _recordMinterShare(id, currentEpoch() + 1, shareBps);
        emit MinterSet(id, controller, shareBps, editable);
    }

    function _setMinterController(bytes32 id, address controller) internal {
        if (id == bytes32(0)) revert InvalidMinterId();
        if (controller == address(0)) revert InvalidAddress();

        Minter memory existing = _minters[id];
        if (existing.controller == address(0)) revert NotEmissionMinter();

        bytes32 assignedId = controllerMinterIds[controller];
        if (assignedId != bytes32(0) && assignedId != id) revert InvalidMinterId();

        if (existing.controller != controller) {
            delete controllerMinterIds[existing.controller];
            controllerMinterIds[controller] = id;
            _minters[id] = Minter({ controller: controller, shareBps: existing.shareBps, editable: existing.editable });
        }

        emit MinterSet(id, controller, existing.shareBps, existing.editable);
    }

    function _removeMinter(bytes32 id) internal {
        if (id == bytes32(0)) revert InvalidMinterId();
        Minter memory existing = _minters[id];
        if (existing.controller == address(0)) revert NotEmissionMinter();
        if (!existing.editable) revert MinterNotEditable();

        totalMinterShareBps -= existing.shareBps;
        // Removal takes effect from the NEXT epoch, matching _setMinter: the
        // in-progress epoch keeps its share so already-earned claims stay
        // mintable, and the checkpoint array stays sorted even when a
        // same-epoch _setMinter already scheduled a checkpoint at
        // currentEpoch() + 1.
        _recordMinterShare(id, currentEpoch() + 1, 0);
        // Entry retained with a zero share: _chargeMinterBudget authorizes
        // against it, so deleting it would strand already-earned budget.
        _minters[id] = Minter({ controller: existing.controller, shareBps: 0, editable: existing.editable });
        emit MinterRemoved(id, existing.controller);
    }

    function _claimFromMinter(bytes32 id, address controller, uint256 epoch, address recipient, uint256 amount)
        internal
    {
        if (recipient == address(0)) revert InvalidAddress();

        _chargeMinterBudget(id, controller, epoch, amount);

        _antsToken.mint(recipient, amount);
        emit EmissionClaimed(id, controller, recipient, epoch, amount);
    }

    function _chargeMinterBudget(bytes32 id, address controller, uint256 epoch, uint256 amount) internal {
        Minter memory minter = _minters[id];
        if (minter.controller == address(0) || minter.controller != controller) revert NotEmissionMinter();
        if (amount == 0) revert InvalidValue();
        if (epoch >= currentEpoch()) revert EpochNotFinalized();
        // Pre-effective epochs are the legacy escrow's, settled in full at
        // funding time — never mintable through a bucket.
        if (epoch < effectiveEpoch) revert PreEffectiveEpoch();
        // The escrow pot is sized as `schedule − totalSupply` at funding
        // time; a gate mint landing before funding would inflate supply and
        // underfund pre-effective legacy claims. No bucket mints until the
        // escrow is settled.
        if (legacyEscrow == address(0)) revert LegacyEscrowNotFunded();

        uint256 newMinterMinted = minterEpochMinted[id][epoch] + amount;
        if (newMinterMinted > _shareBudget(epoch, _minterShareBpsAt(id, epoch))) revert BucketBudgetExceeded();
        minterEpochMinted[id][epoch] = newMinterMinted;

        uint256 minted = epochMinted[epoch] + amount;
        if (minted > getEpochEmission(epoch)) revert EpochEmissionExceeded();
        epochMinted[epoch] = minted;
    }

    function _shareBudget(uint256 epoch, uint32 shareBps) internal pure returns (uint256) {
        return (getEpochEmission(epoch) * shareBps) / SHARE_DENOMINATOR;
    }

    function _emissionsReserve() internal view returns (address reserve) {
        reserve = _minters[RESERVE_MINTER_ID].controller;
    }

    function _recordMinterShare(bytes32 id, uint256 startEpoch, uint32 shareBps) internal {
        ShareCheckpoint[] storage checkpoints = _minterShareCheckpoints[id];
        uint256 length = checkpoints.length;

        if (length != 0 && checkpoints[length - 1].startEpoch == startEpoch) {
            checkpoints[length - 1].shareBps = shareBps;
            return;
        }

        checkpoints.push(ShareCheckpoint({ startEpoch: startEpoch, shareBps: shareBps }));
    }

    function _minterShareBpsAt(bytes32 id, uint256 epoch) internal view returns (uint32) {
        ShareCheckpoint[] storage checkpoints = _minterShareCheckpoints[id];
        uint256 length = checkpoints.length;
        if (length == 0 || epoch < checkpoints[0].startEpoch) return 0;

        uint256 low;
        uint256 high = length;
        while (low < high) {
            uint256 mid = (low + high) / 2;
            if (checkpoints[mid].startEpoch <= epoch) {
                low = mid + 1;
            } else {
                high = mid;
            }
        }

        return checkpoints[low - 1].shareBps;
    }
}
