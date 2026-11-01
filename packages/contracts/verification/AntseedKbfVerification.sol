// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

import {IAntseedEmissionsGate} from "../interfaces/IAntseedEmissionsGate.sol";
import {IAntseedRegistry} from "../interfaces/IAntseedRegistry.sol";
import {IAntseedSellerPools} from "../interfaces/IAntseedSellerPools.sol";
import {IAntseedKbfVerification} from "../interfaces/IAntseedKbfVerification.sol";
import {IERC8004Registry} from "../interfaces/IERC8004Registry.sol";

interface IEmissionsGateSource {
    function emissionsGate() external view returns (address);
}

interface IEmissionsGateSchedule {
    function genesis() external view returns (uint256);
    function epochDuration() external view returns (uint256);
}

/// @notice Distributed KBF (Knowledge Boundary Fingerprinting) model verification. Many approved
///         verifiers buy slices of one seed-derived sample from each seller, publish the
///         seller-signed transcripts, score everything independently against one sealed
///         reference, and a majority must attest the same results root before any verdict counts.
///         See `IAntseedKbfVerification` for the round. KBF is one of several verification
///         methods: another method gets its own contract, points policy and emissions bucket.
///
///         Roles:
///         - owner: approves verifiers and the publisher, sets the audited model list and the
///           schedule, and can void an epoch or clear verdicts as remediation;
///         - publisher: Antseed's automated reference publisher. It builds and seals each epoch's
///           question bank, commits the plan and reveals the bank key. It decides no verdicts;
///         - verifiers: collect slices, attest results and earn rewards.
///
///         The publisher is a convenience, not a dependency:
///         - if no plan is in effect `publisherGraceSeconds` into the epoch, any verifier can take
///           the epoch over (`takeOverBank`) with its own bank and act as the epoch's publisher;
///           each takeover waits another grace period after the previous one, the epoch publisher
///           cannot take its own epoch over again, and a verifier takes one epoch over at most
///           `MAX_TAKEOVERS_PER_VERIFIER` times;
///         - nothing the epoch publisher commits is final until the verifiers accept it
///           (`acceptPlan`): the plan, each verifier's envelopes and the key escrow (`commitKeyShares`,
///           a Feldman-verifiable Shamir split with the finalization majority as threshold, one
///           share sealed to each verifier, whose commitments' constant term is the committed key's
///           point). The plan takes effect once a majority of the verifiers other than the epoch
///           publisher accepted it; before that, collection cannot start and the epoch can still be
///           taken over, so a publisher cannot freeze a round with a plan or escrow the others
///           cannot use. If the key is not revealed by the backup deadline, verifiers post their
///           shares (`revealKeyShare`) and anyone combines them into `revealBankKey`. A majority
///           that pools its shares early learns the questions, but a majority can already finalize
///           any root, so the escrow adds no new trust.
///
///         Rewards: from `rewardsStartEpoch` on, an epoch's verification budget is split into an
///         attester pool (`attestRewardBps`), shared equally by the verifiers that attested the
///         finalized root, and a collector pool, shared by the slices the finalized root credits
///         each verifier with. One verifier's claim is capped at `maxVerifierShareBps` of the
///         budget; budget above the cap is never minted. The split, the cap and whether the
///         epoch earns rewards at all are fixed per epoch when it is opened.
contract AntseedKbfVerification is IAntseedKbfVerification, Ownable2Step {
    uint256 public constant MAX_VERIFIERS = 64;
    uint256 public constant MAX_MODELS = 64;
    uint256 public constant MAX_URI_BYTES = 200;
    uint256 public constant MAX_SLICE_COMMITS = 8;
    uint8 public constant MAX_VALIDITY_EPOCHS = 4;
    uint256 public constant MAX_KEY_SHARE_BYTES = 64;
    /// @notice Blocks between opening an epoch and the block whose hash seeds it.
    uint64 public constant SEED_DELAY_BLOCKS = 4;
    /// @notice Takeovers one verifier may make in one epoch, so no verifier can keep the epoch to
    ///         itself by taking it over again every grace period.
    uint256 public constant MAX_TAKEOVERS_PER_VERIFIER = 2;
    /// @dev secp256k1 group order and generator x coordinate, to check a bank key against its
    ///      committed address with `ecrecover`.
    uint256 private constant SECP256K1_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
    uint256 private constant SECP256K1_GX = 0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798;
    uint256 public constant BPS = 10_000;

    uint8 private constant LEAF_SERVICE = 1;
    uint8 private constant LEAF_COLLECTOR = 2;

    struct EpochCounts {
        uint32 same;
        uint32 diff;
    }

    struct EpochState {
        uint64 seedBlock;
        bytes32 seed;
        uint32 modelsVersion;
        Schedule schedule;
        bytes32 bankHash;
        bytes32 bankKeyHash;
        bytes32 bankKey;
        bytes32 planHash;
        bytes32 finalizedRoot;
        bool voided;
        address[] verifiers;
        // Whoever committed the bank: the publisher, or the verifier that took the epoch over.
        address publisher;
        uint64 takenOverAt;
        bytes32 keySharesHash;
        // Bumped by every bank commit or takeover, so acceptances never carry over to another bank.
        uint32 bankGeneration;
        // Set once enough verifiers accepted the plan and escrow: collection may start, and the
        // epoch can no longer be taken over.
        bool planActive;
        uint16 attestRewardBps;
        uint16 maxVerifierShareBps;
        // Whether the epoch earns rewards, fixed at opening from `rewardsStartEpoch`.
        bool rewarded;
    }

    IAntseedRegistry public immutable override registry;
    IAntseedEmissionsGate public immutable override emissionsGate;
    IAntseedSellerPools public override sellerPools;
    uint8 public override validityEpochs = 2;
    address public override publisher;
    uint32 public override modelsVersion;
    /// @notice Share of an epoch's budget paid to the verifiers that attested the finalized root.
    ///         Epochs keep the value in force when they were opened.
    uint16 public attestRewardBps = 2_000;
    /// @notice Most of an epoch's budget one verifier can claim (default 20%). Epochs keep the
    ///         value in force when they were opened.
    uint16 public maxVerifierShareBps = 2_000;
    /// @notice How long into an epoch, and after each takeover, the publisher has to commit a
    ///         plan before a verifier can take the epoch over.
    uint32 public override publisherGraceSeconds = 6 hours;
    /// @notice First epoch that earns rewards; `type(uint256).max` keeps rewards off.
    uint256 public override rewardsStartEpoch = type(uint256).max;

    Schedule private _schedule;
    address[] private _verifiers;
    mapping(address verifier => uint256 indexPlusOne) private _verifierIndex;
    mapping(address verifier => bytes32 key) public override encryptionKeys;
    mapping(uint32 version => Model[] list) private _models;

    mapping(uint256 epoch => EpochState state) private _epochs;
    mapping(uint256 epoch => mapping(address verifier => bool member)) private _epochMember;
    mapping(uint256 epoch => mapping(address verifier => uint256 count)) public sliceCommits;
    mapping(uint256 epoch => mapping(address verifier => bytes32 root)) public override attestations;
    mapping(uint256 epoch => mapping(bytes32 root => uint256 votes)) public override rootVotes;
    mapping(uint256 epoch => mapping(bytes32 leaf => bool applied)) public resultApplied;
    mapping(uint256 epoch => mapping(address verifier => bool claimed)) public rewardClaimed;
    mapping(uint256 epoch => mapping(address verifier => bool revealed)) public keyShareRevealed;
    // Acceptances per (bank generation, key shares, plan) of an epoch: see `acceptPlan`.
    mapping(uint256 epoch => mapping(bytes32 round => mapping(address verifier => bool accepted))) private _accepted;
    mapping(uint256 epoch => mapping(bytes32 round => uint256 count)) private _acceptances;
    /// @notice Takeovers each verifier made in an epoch (at most `MAX_TAKEOVERS_PER_VERIFIER`).
    mapping(uint256 epoch => mapping(address verifier => uint256 count)) public override takeovers;

    mapping(uint256 agentId => mapping(bytes32 serviceHash => ServiceStatus status)) private _serviceStatus;
    /// @notice First epoch whose results can still change a service. Clearing a service moves it
    ///         past the current epoch, so a finalized but unapplied older result cannot bring a
    ///         cleared verdict back.
    mapping(uint256 agentId => mapping(bytes32 serviceHash => uint256 epoch)) public override serviceResultsFrom;
    // Latest SAME/DIFF verdicts given in each epoch; a verdict moves out when the service gets a new one.
    mapping(uint256 agentId => mapping(uint256 epoch => EpochCounts counts)) private _epochCounts;

    event VerifierSet(address indexed verifier, bool approved);
    event EncryptionKeySet(address indexed verifier, bytes32 key);
    event PublisherSet(address indexed publisher);
    event ModelsSet(uint32 indexed version, Model[] models);
    event ScheduleSet(Schedule schedule);
    event SellerPoolsSet(address sellerPools);
    event ValidityEpochsSet(uint8 validityEpochs);
    event RewardsStartEpochSet(uint256 epoch);
    event AttestRewardBpsSet(uint16 bps);
    event MaxVerifierShareBpsSet(uint16 bps);
    event PublisherGraceSecondsSet(uint32 seconds_);
    event EpochTakenOver(uint256 indexed epoch, address indexed verifier);
    event KeySharesCommitted(uint256 indexed epoch, address indexed publisher, bytes32 sharesHash, string sharesUri);
    event KeyShareRevealed(uint256 indexed epoch, address indexed verifier, bytes share);
    event PlanAccepted(uint256 indexed epoch, address indexed verifier, bytes32 sharesHash, bytes32 planHash);
    event PlanActivated(uint256 indexed epoch, bytes32 planHash);
    event BankCommitted(uint256 indexed epoch, bytes32 bankHash, bytes32 bankKeyHash, string bankUri);
    event EpochOpened(uint256 indexed epoch, uint64 seedBlock, uint32 modelsVersion, uint16 verifierCount);
    event SeedRearmed(uint256 indexed epoch, uint64 seedBlock);
    event SeedFixed(uint256 indexed epoch, bytes32 seed);
    event PlanCommitted(uint256 indexed epoch, address indexed publisher, bytes32 planHash, string planUri);
    event BankKeyRevealed(uint256 indexed epoch, bytes32 bankKey);
    event SlicesCommitted(
        uint256 indexed epoch, address indexed verifier, bool backup, bytes32 slicesRoot, string manifestUri
    );
    event Attested(uint256 indexed epoch, address indexed verifier, bytes32 resultsRoot, string evidenceUri);
    event EpochFinalized(uint256 indexed epoch, bytes32 resultsRoot, uint256 votes);
    event EpochVoided(uint256 indexed epoch);
    event ServiceAudited(
        uint256 indexed agentId, bytes32 indexed serviceHash, uint256 indexed epoch, bytes32 modelHash, Verdict verdict
    );
    event ServiceStatusChanged(
        uint256 indexed agentId, bytes32 indexed serviceHash, bytes32 modelHash, Verdict previous, Verdict current
    );
    event AgentStatusChanged(uint256 indexed agentId, uint16 verifiedCount, uint16 diffCount);
    event UnknownAgentSkipped(uint256 indexed agentId, uint256 indexed epoch);
    event ClearedResultSkipped(uint256 indexed agentId, bytes32 indexed serviceHash, uint256 indexed epoch);
    event RewardClaimed(uint256 indexed epoch, address indexed verifier, uint256 amount);

    error InvalidAddress();
    error InvalidValue();
    error InvalidUri();
    error InvalidResults();
    error InvalidProof();
    error NotVerifier();
    error NotPublisher();
    error WrongEpoch();
    error WrongPhase();
    error TooManyVerifiers();
    error TooManyCommits();
    error AlreadyAttested();
    error EpochVoidedError();
    error EpochNotFinalized();
    error AlreadyClaimed();
    error AlreadyRevealed();
    error KeyNotEscrowed();
    error AlreadyAccepted();
    error PlanAlreadyCommitted();

    modifier onlyPublisher() {
        if (msg.sender != publisher) revert NotPublisher();
        _;
    }

    modifier onlyEpochPublisher(uint256 epoch) {
        if (msg.sender != _epochs[epoch].publisher) revert NotPublisher();
        _;
    }

    /// @dev Pins the emissions gate behind `registry.emissions()`. After M001 the registry points at
    ///      usage accounting, which exposes the gate as `emissionsGate()`; otherwise the registry
    ///      entry is the gate itself. Verdict epochs only make sense against one gate, so a new
    ///      gate needs a new verification deployment.
    constructor(address registry_, address sellerPools_) Ownable(msg.sender) {
        if (registry_.code.length == 0) revert InvalidAddress();
        registry = IAntseedRegistry(registry_);
        address emissions = IAntseedRegistry(registry_).emissions();
        if (emissions.code.length == 0) revert InvalidAddress();
        address gate = emissions;
        try IEmissionsGateSource(emissions).emissionsGate() returns (address source) {
            if (source.code.length != 0) gate = source;
        } catch {}
        emissionsGate = IAntseedEmissionsGate(gate);
        _setSellerPools(sellerPools_);
        _setSchedule(
            Schedule({
                collectSeconds: 3 days, backupSeconds: 1 days, attestSeconds: 1 days, probesPerService: 100, slicesPerService: 4
            })
        );
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        ADMIN
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Approves or removes a verifier. Takes effect from the next epoch opened; an open
    ///         epoch keeps its snapshot.
    function setVerifier(address verifier, bool approved) external onlyOwner {
        if (verifier == address(0)) revert InvalidAddress();
        uint256 indexPlusOne = _verifierIndex[verifier];
        if (approved && indexPlusOne == 0) {
            if (_verifiers.length >= MAX_VERIFIERS) revert TooManyVerifiers();
            _verifiers.push(verifier);
            _verifierIndex[verifier] = _verifiers.length;
        } else if (!approved && indexPlusOne != 0) {
            address last = _verifiers[_verifiers.length - 1];
            _verifiers[indexPlusOne - 1] = last;
            _verifierIndex[last] = indexPlusOne;
            _verifiers.pop();
            delete _verifierIndex[verifier];
        }
        emit VerifierSet(verifier, approved);
    }

    function setPublisher(address publisher_) external onlyOwner {
        if (publisher_ == address(0)) revert InvalidAddress();
        publisher = publisher_;
        emit PublisherSet(publisher_);
    }

    /// @notice Replaces the standing list of audited models. Each epoch audits the list in force
    ///         when it was opened.
    function setModels(Model[] calldata list) external onlyOwner {
        uint256 count = list.length;
        if (count == 0 || count > MAX_MODELS) revert InvalidValue();
        uint32 version = modelsVersion + 1;
        Model[] storage stored = _models[version];
        for (uint256 i = 0; i < count; i++) {
            Model calldata model = list[i];
            bytes memory service = bytes(model.service);
            if (service.length == 0 || service.length > 128 || model.modelHash != keccak256(service)) {
                revert InvalidValue();
            }
            for (uint256 j = 0; j < i; j++) {
                if (list[j].modelHash == model.modelHash) revert InvalidValue();
            }
            stored.push(model);
        }
        modelsVersion = version;
        emit ModelsSet(version, list);
    }

    /// @notice Sets the timing and sampling for epochs opened from now on.
    function setSchedule(Schedule calldata schedule_) external onlyOwner {
        _setSchedule(schedule_);
    }

    function setSellerPools(address sellerPools_) external onlyOwner {
        _setSellerPools(sellerPools_);
    }

    /// @notice Epochs a verdict counts for, including the one it was given in. Applies to
    ///         existing verdicts immediately.
    function setValidityEpochs(uint8 epochs) external onlyOwner {
        if (epochs == 0 || epochs > MAX_VALIDITY_EPOCHS) revert InvalidValue();
        validityEpochs = epochs;
        emit ValidityEpochsSet(epochs);
    }

    /// @notice Epochs from this one on earn rewards; `type(uint256).max` turns new rewards off.
    ///         Applies to epochs opened from now on: an opened epoch keeps what it was opened with,
    ///         so rewards already earned stay claimable.
    function setRewardsStartEpoch(uint256 epoch) external onlyOwner {
        rewardsStartEpoch = epoch;
        emit RewardsStartEpochSet(epoch);
    }

    /// @notice Sets the attester pool for epochs opened from now on.
    function setAttestRewardBps(uint16 bps) external onlyOwner {
        if (bps > BPS) revert InvalidValue();
        attestRewardBps = bps;
        emit AttestRewardBpsSet(bps);
    }

    /// @notice Caps one verifier's share of the budget of epochs opened from now on.
    function setMaxVerifierShareBps(uint16 bps) external onlyOwner {
        if (bps == 0 || bps > BPS) revert InvalidValue();
        maxVerifierShareBps = bps;
        emit MaxVerifierShareBpsSet(bps);
    }

    function setPublisherGraceSeconds(uint32 seconds_) external onlyOwner {
        if (seconds_ == 0) revert InvalidValue();
        publisherGraceSeconds = seconds_;
        emit PublisherGraceSecondsSet(seconds_);
    }

    /// @notice Remediation for a bad round, e.g. a leaked bank or a colluding majority: no more
    ///         results of `epoch` can be applied and nothing of it can be claimed. Results already
    ///         applied stay until cleared with `clearServiceStatuses`.
    function voidEpoch(uint256 epoch) external onlyOwner {
        _epochs[epoch].voided = true;
        emit EpochVoided(epoch);
    }

    /// @notice Remediation for wrong results: resets each listed service's verdict, and ignores
    ///         results of the current and earlier epochs for it from now on, applied or not.
    ///         `agentIds[i]` pairs with `serviceHashes[i]`.
    function clearServiceStatuses(uint256[] calldata agentIds, bytes32[] calldata serviceHashes)
        external
        onlyOwner
    {
        uint256 count = agentIds.length;
        if (count != serviceHashes.length) revert InvalidValue();
        uint256 epoch = emissionsGate.currentEpoch();
        for (uint256 i = 0; i < count; i++) {
            serviceResultsFrom[agentIds[i]][serviceHashes[i]] = epoch + 1;
            _resetService(agentIds[i], serviceHashes[i], _serviceStatus[agentIds[i]][serviceHashes[i]], epoch);
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        VERIFIERS
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Sets the caller's X25519 public key, which the publisher encrypts its question
    ///         envelopes to. Only approved verifiers have one.
    function setEncryptionKey(bytes32 key) external {
        if (_verifierIndex[msg.sender] == 0) revert NotVerifier();
        if (key == bytes32(0)) revert InvalidValue();
        encryptionKeys[msg.sender] = key;
        emit EncryptionKeySet(msg.sender, key);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        ROUND
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Commits the epoch's sealed bank: `bankHash` is the hash of the encrypted bank at
    ///         `bankUri`, `bankKeyHash` the key's address: the Ethereum address of `key·G` on
    ///         secp256k1, left-padded to 32 bytes. Escrowed shares are checked against that point,
    ///         so verifiers know before the plan that the shares rebuild the committed key.
    ///         Possible for the current or next epoch until the epoch is opened, and not once a
    ///         verifier has taken it over.
    function commitBank(uint256 epoch, bytes32 bankHash, bytes32 bankKeyHash, string calldata bankUri)
        external
        onlyPublisher
    {
        uint256 current = emissionsGate.currentEpoch();
        if (epoch != current && epoch != current + 1) revert WrongEpoch();
        EpochState storage state = _epochs[epoch];
        if (state.seedBlock != 0 || state.takenOverAt != 0) revert WrongPhase();
        _setBank(epoch, state, bankHash, bankKeyHash, bankUri);
    }

    /// @notice Lets a verifier stand in for a publisher that has not committed a plan by
    ///         `publisherGraceSeconds` into the current epoch (or that long after the previous
    ///         takeover). The caller's bank replaces any committed one and the caller becomes the
    ///         epoch's publisher. An opened epoch keeps its snapshot but draws a new seed, since
    ///         the seed is bound to the bank.
    function takeOverBank(uint256 epoch, bytes32 bankHash, bytes32 bankKeyHash, string calldata bankUri) external {
        if (epoch != emissionsGate.currentEpoch()) revert WrongEpoch();
        EpochState storage state = _epochs[epoch];
        bool opened = state.seedBlock != 0;
        if (opened ? !_epochMember[epoch][msg.sender] : _verifierIndex[msg.sender] == 0) revert NotVerifier();
        // An accepted plan is final. Until then, a plan the verifiers would not accept (or never
        // saw) does not stop another verifier from carrying the epoch.
        if (state.planActive) revert WrongPhase();
        // Not the epoch's own publisher again, and only a few times per verifier.
        if (msg.sender == state.publisher || takeovers[epoch][msg.sender] >= MAX_TAKEOVERS_PER_VERIFIER) revert WrongPhase();
        uint256 start = _epochStart(epoch);
        uint256 since = state.takenOverAt == 0 ? start : state.takenOverAt;
        uint256 collect = opened ? state.schedule.collectSeconds : _schedule.collectSeconds;
        if (block.timestamp < since + publisherGraceSeconds || block.timestamp >= start + collect) revert WrongPhase();
        takeovers[epoch][msg.sender] += 1;
        _setBank(epoch, state, bankHash, bankKeyHash, bankUri);
        state.takenOverAt = uint64(block.timestamp);
        if (opened) {
            state.seed = bytes32(0);
            state.seedBlock = uint64(block.number) + SEED_DELAY_BLOCKS;
            emit SeedRearmed(epoch, state.seedBlock);
        }
        emit EpochTakenOver(epoch, msg.sender);
    }

    /// @notice Opens the current epoch once its bank is committed: snapshots the verifiers, the
    ///         model list and the schedule, and picks the block whose hash will seed the epoch.
    ///         Anyone can call it, but only before the collection window ends.
    function openEpoch(uint256 epoch) external {
        if (epoch != emissionsGate.currentEpoch()) revert WrongEpoch();
        EpochState storage state = _epochs[epoch];
        if (state.seedBlock != 0 || state.bankHash == bytes32(0) || modelsVersion == 0) revert WrongPhase();
        Schedule memory schedule_ = _schedule;
        if (block.timestamp >= _epochStart(epoch) + schedule_.collectSeconds) revert WrongPhase();
        uint256 count = _verifiers.length;
        if (count == 0) revert NotVerifier();
        state.verifiers = _verifiers;
        for (uint256 i = 0; i < count; i++) {
            _epochMember[epoch][_verifiers[i]] = true;
        }
        state.modelsVersion = modelsVersion;
        state.schedule = schedule_;
        state.attestRewardBps = attestRewardBps;
        state.maxVerifierShareBps = maxVerifierShareBps;
        state.rewarded = epoch >= rewardsStartEpoch;
        state.seedBlock = uint64(block.number) + SEED_DELAY_BLOCKS;
        emit EpochOpened(epoch, state.seedBlock, state.modelsVersion, uint16(count));
    }

    /// @notice Fixes the epoch seed from the hash of the block chosen at opening. If that block is
    ///         older than 256 blocks its hash is gone, so a new future block is chosen instead.
    function fixSeed(uint256 epoch) external {
        EpochState storage state = _epochs[epoch];
        uint64 seedBlock = state.seedBlock;
        if (seedBlock == 0 || state.seed != bytes32(0) || block.number <= seedBlock) revert WrongPhase();
        if (block.number - seedBlock > 256) {
            state.seedBlock = uint64(block.number) + SEED_DELAY_BLOCKS;
            emit SeedRearmed(epoch, state.seedBlock);
            return;
        }
        bytes32 seed = keccak256(abi.encode(blockhash(seedBlock), epoch, state.bankHash));
        state.seed = seed;
        emit SeedFixed(epoch, seed);
    }

    /// @notice Proposes the target list and the per-verifier question envelopes derived from the seed:
    ///         each verifier's primary slices, and, sealed alongside, the slices it backs up, which
    ///         it buys after the commit deadline if their owner did not deliver them. The round
    ///         therefore needs no publisher action between the plan and the key reveal. A plan
    ///         takes effect once verifiers accept it (`acceptPlan`); until then the publisher may
    ///         propose another one, and once in effect a different hash reverts.
    function commitPlan(uint256 epoch, bytes32 planHash, string calldata planUri) external onlyEpochPublisher(epoch) {
        EpochState storage state = _epochs[epoch];
        if (state.seed == bytes32(0) || block.timestamp >= _commitDeadline(epoch, state)) revert WrongPhase();
        // Without escrowed shares, losing the publisher after the plan would strand the round.
        if (state.keySharesHash == bytes32(0)) revert KeyNotEscrowed();
        if (planHash == bytes32(0)) revert InvalidValue();
        if (state.planActive) {
            if (state.planHash == planHash) return;
            revert PlanAlreadyCommitted();
        }
        _validateUri(planUri);
        state.planHash = planHash;
        emit PlanCommitted(epoch, msg.sender, planHash, planUri);
        _activateIfAccepted(epoch, state);
    }

    /// @notice Escrows the bank key with the epoch's verifiers: `sharesHash` is the hash of the
    ///         file at `sharesUri` holding one Shamir share of the key per verifier, each sealed to
    ///         its encryption key, any `threshold(epoch)` of which rebuild the key.
    function commitKeyShares(uint256 epoch, bytes32 sharesHash, string calldata sharesUri)
        external
        onlyEpochPublisher(epoch)
    {
        EpochState storage state = _epochs[epoch];
        // Fixed once the plan is in effect, so the shares verifiers rely on cannot be swapped.
        if (
            state.seedBlock == 0 || state.planActive || state.bankKey != bytes32(0)
                || block.timestamp >= _commitDeadline(epoch, state)
        ) {
            revert WrongPhase();
        }
        if (sharesHash == bytes32(0)) revert InvalidValue();
        _validateUri(sharesUri);
        state.keySharesHash = sharesHash;
        emit KeySharesCommitted(epoch, msg.sender, sharesHash, sharesUri);
    }

    /// @notice Accepts the epoch's current plan and key escrow. A verifier accepts only after
    ///         checking that the plan and its own envelopes are fetchable and well formed, that the
    ///         escrow's threshold is the epoch's, and that its own share lies on the escrow's
    ///         committed polynomial, whose constant term is the committed key's point. Epoch
    ///         verifiers other than the epoch publisher; the plan takes effect at
    ///         `requiredPlanAcceptances(epoch)`. Acceptances are bound to the bank, the shares and
    ///         the plan, so a replaced bank, escrow or plan needs accepting again.
    function acceptPlan(uint256 epoch, bytes32 sharesHash, bytes32 planHash) external {
        if (!_epochMember[epoch][msg.sender]) revert NotVerifier();
        EpochState storage state = _epochs[epoch];
        if (msg.sender == state.publisher) revert NotVerifier();
        if (state.planActive || state.planHash == bytes32(0) || block.timestamp >= _commitDeadline(epoch, state)) {
            revert WrongPhase();
        }
        if (sharesHash != state.keySharesHash || planHash != state.planHash) revert InvalidValue();
        bytes32 round = _roundKey(state);
        if (_accepted[epoch][round][msg.sender]) revert AlreadyAccepted();
        _accepted[epoch][round][msg.sender] = true;
        _acceptances[epoch][round] += 1;
        emit PlanAccepted(epoch, msg.sender, sharesHash, planHash);
        _activateIfAccepted(epoch, state);
    }

    /// @notice Acceptances of the current bank, escrow and plan so far.
    function planAcceptances(uint256 epoch) external view override returns (uint256) {
        EpochState storage state = _epochs[epoch];
        return _acceptances[epoch][_roundKey(state)];
    }

    /// @notice Whether `verifier` accepted the current bank, escrow and plan.
    function hasAcceptedPlan(uint256 epoch, address verifier) external view override returns (bool) {
        return _accepted[epoch][_roundKey(_epochs[epoch])][verifier];
    }

    /// @notice Acceptances a plan needs: the threshold, from verifiers other than the epoch
    ///         publisher. When fewer such verifiers exist, all of them: the publisher could then
    ///         block finalization by not attesting anyway, so it gains nothing.
    function requiredPlanAcceptances(uint256 epoch) external view override returns (uint256) {
        return _requiredAcceptances(epoch, _epochs[epoch]);
    }

    /// @notice Publishes the caller's decrypted key share when the bank key is still hidden at
    ///         the backup deadline. Once per verifier; anyone can combine `threshold(epoch)`
    ///         shares and call `revealBankKey`, which checks the key against its hash.
    function revealKeyShare(uint256 epoch, bytes calldata share) external {
        if (!_epochMember[epoch][msg.sender]) revert NotVerifier();
        EpochState storage state = _epochs[epoch];
        if (
            !state.planActive || state.bankKey != bytes32(0)
                || block.timestamp < _backupDeadline(epoch, state) || block.timestamp >= _attestDeadline(epoch, state)
        ) revert WrongPhase();
        if (share.length == 0 || share.length > MAX_KEY_SHARE_BYTES) revert InvalidValue();
        if (keyShareRevealed[epoch][msg.sender]) revert AlreadyRevealed();
        keyShareRevealed[epoch][msg.sender] = true;
        emit KeyShareRevealed(epoch, msg.sender, share);
    }

    /// @notice Reveals the bank key once collection is over, so everyone can read the bank and
    ///         score. Anyone holding the key can reveal it; it must match the committed hash.
    function revealBankKey(uint256 epoch, bytes32 bankKey) external {
        EpochState storage state = _epochs[epoch];
        if (!state.planActive || state.bankKey != bytes32(0)) revert WrongPhase();
        if (block.timestamp < _backupDeadline(epoch, state)) revert WrongPhase();
        address keyAddress = _keyAddress(bankKey);
        if (keyAddress == address(0) || bytes32(uint256(uint160(keyAddress))) != state.bankKeyHash) revert InvalidValue();
        state.bankKey = bankKey;
        emit BankKeyRevealed(epoch, bankKey);
    }

    /// @notice Commits seller-signed transcripts bought by the caller: `slicesRoot` is the
    ///         keccak256 hash of the canonical JSON manifest bytes at `manifestUri` (a content
    ///         hash, not a Merkle root). Commits before the commit deadline are primary, later
    ///         ones (until the backup deadline) are backups.
    function commitSlices(uint256 epoch, bytes32 slicesRoot, string calldata manifestUri) external {
        if (!_epochMember[epoch][msg.sender]) revert NotVerifier();
        EpochState storage state = _epochs[epoch];
        if (!state.planActive || block.timestamp >= _backupDeadline(epoch, state)) revert WrongPhase();
        if (slicesRoot == bytes32(0)) revert InvalidValue();
        _validateUri(manifestUri);
        uint256 commits = sliceCommits[epoch][msg.sender] + 1;
        if (commits > MAX_SLICE_COMMITS) revert TooManyCommits();
        sliceCommits[epoch][msg.sender] = commits;
        emit SlicesCommitted(
            epoch, msg.sender, block.timestamp >= _commitDeadline(epoch, state), slicesRoot, manifestUri
        );
    }

    /// @notice Attests the Merkle root of every (service, verdict) and collector credit the caller
    ///         computed for the epoch. Once per verifier. The first root a majority of the epoch's
    ///         verifiers attests becomes final.
    function attest(uint256 epoch, bytes32 resultsRoot, string calldata evidenceUri) external {
        if (!_epochMember[epoch][msg.sender]) revert NotVerifier();
        EpochState storage state = _epochs[epoch];
        if (state.voided) revert EpochVoidedError();
        if (state.bankKey == bytes32(0) || block.timestamp >= _attestDeadline(epoch, state)) revert WrongPhase();
        if (resultsRoot == bytes32(0)) revert InvalidValue();
        if (attestations[epoch][msg.sender] != bytes32(0)) revert AlreadyAttested();
        _validateUri(evidenceUri);
        attestations[epoch][msg.sender] = resultsRoot;
        uint256 votes = rootVotes[epoch][resultsRoot] + 1;
        rootVotes[epoch][resultsRoot] = votes;
        emit Attested(epoch, msg.sender, resultsRoot, evidenceUri);
        if (state.finalizedRoot == bytes32(0) && votes >= _threshold(state)) {
            state.finalizedRoot = resultsRoot;
            emit EpochFinalized(epoch, resultsRoot, votes);
        }
    }

    /// @notice Applies finalized results. Anyone can call it; each result needs a Merkle proof
    ///         against the epoch's finalized root. Results already applied are skipped, a
    ///         service keeps a newer epoch's verdict over an older one, and results up to the epoch
    ///         a service was cleared in are ignored.
    function applyResults(uint256 epoch, ServiceResult[] calldata results, bytes32[][] calldata proofs) external {
        EpochState storage state = _epochs[epoch];
        if (state.voided) revert EpochVoidedError();
        bytes32 root = state.finalizedRoot;
        if (root == bytes32(0)) revert EpochNotFinalized();
        uint256 count = results.length;
        if (count == 0 || count != proofs.length) revert InvalidResults();
        for (uint256 i = 0; i < count; i++) {
            ServiceResult calldata result = results[i];
            if (result.verdict == Verdict.NONE || result.serviceHash == bytes32(0)) revert InvalidResults();
            bytes32 leaf = serviceLeaf(epoch, result);
            if (!MerkleProof.verifyCalldata(proofs[i], root, leaf)) revert InvalidProof();
            if (resultApplied[epoch][leaf]) continue;
            resultApplied[epoch][leaf] = true;
            if (!_agentKnown(result.agentId)) {
                emit UnknownAgentSkipped(result.agentId, epoch);
                continue;
            }
            if (epoch < serviceResultsFrom[result.agentId][result.serviceHash]) {
                emit ClearedResultSkipped(result.agentId, result.serviceHash, epoch);
                continue;
            }
            emit ServiceAudited(result.agentId, result.serviceHash, epoch, result.modelHash, result.verdict);
            _applyResult(result.agentId, result.serviceHash, result.modelHash, result.verdict, epoch);
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        REWARDS
    // ═══════════════════════════════════════════════════════════════════

    function claimRewards(uint256 epoch, uint32 slices, uint32 totalSlices, bytes32[] calldata proof)
        external
        override
        returns (uint256 amount)
    {
        if (rewardClaimed[epoch][msg.sender]) revert AlreadyClaimed();
        IAntseedEmissionsGate gate = emissionsGate;
        if (epoch >= gate.currentEpoch()) revert EpochNotFinalized();
        amount = _pendingReward(gate, msg.sender, epoch, slices, totalSlices, proof);
        if (amount == 0) return 0;
        rewardClaimed[epoch][msg.sender] = true;
        gate.claim(epoch, msg.sender, amount);
        emit RewardClaimed(epoch, msg.sender, amount);
    }

    /// @notice Claimable reward for a finished epoch; 0 while the epoch is current, already
    ///         claimed, voided or unfinalized. Pass `slices = 0` and an empty proof for a verifier
    ///         that only attested.
    function pendingReward(
        address verifier,
        uint256 epoch,
        uint32 slices,
        uint32 totalSlices,
        bytes32[] calldata proof
    ) external view override returns (uint256) {
        if (rewardClaimed[epoch][verifier]) return 0;
        IAntseedEmissionsGate gate = emissionsGate;
        if (epoch >= gate.currentEpoch()) return 0;
        return _pendingReward(gate, verifier, epoch, slices, totalSlices, proof);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        VIEWS
    // ═══════════════════════════════════════════════════════════════════

    function isVerifier(address verifier) external view override returns (bool) {
        return _verifierIndex[verifier] != 0;
    }

    function verifiers() external view override returns (address[] memory) {
        return _verifiers;
    }

    function models(uint32 version) external view override returns (Model[] memory) {
        return _models[version];
    }

    function schedule() external view override returns (Schedule memory) {
        return _schedule;
    }

    function epochInfo(uint256 epoch) external view override returns (EpochInfo memory info) {
        EpochState storage state = _epochs[epoch];
        info.startedAt = _epochStart(epoch);
        info.seedBlock = state.seedBlock;
        info.seed = state.seed;
        info.modelsVersion = state.modelsVersion;
        info.verifierCount = uint16(state.verifiers.length);
        info.schedule = state.seedBlock == 0 ? _schedule : state.schedule;
        info.bankHash = state.bankHash;
        info.bankKeyHash = state.bankKeyHash;
        info.bankKey = state.bankKey;
        info.planHash = state.planHash;
        info.finalizedRoot = state.finalizedRoot;
        info.voided = state.voided;
        info.publisher = state.publisher;
        info.takenOverAt = state.takenOverAt;
        info.keySharesHash = state.keySharesHash;
        info.planActive = state.planActive;
    }

    function epochVerifiers(uint256 epoch) external view override returns (address[] memory) {
        return _epochs[epoch].verifiers;
    }

    function threshold(uint256 epoch) external view override returns (uint256) {
        return _threshold(_epochs[epoch]);
    }

    /// @notice Leaf of a service result in an epoch's results root (OpenZeppelin double-hash format).
    function serviceLeaf(uint256 epoch, ServiceResult calldata result) public pure returns (bytes32) {
        return keccak256(
            bytes.concat(
                keccak256(
                    abi.encode(
                        LEAF_SERVICE, epoch, result.agentId, result.serviceHash, result.modelHash, result.verdict
                    )
                )
            )
        );
    }

    /// @notice Leaf crediting `collector` with `slices` of the epoch's `totalSlices` valid slices.
    function collectorLeaf(uint256 epoch, address collector, uint32 slices, uint32 totalSlices)
        public
        pure
        returns (bytes32)
    {
        return keccak256(bytes.concat(keccak256(abi.encode(LEAF_COLLECTOR, epoch, collector, slices, totalSlices))));
    }

    function serviceStatus(uint256 agentId, bytes32 serviceHash)
        external
        view
        override
        returns (ServiceStatus memory)
    {
        return _serviceStatus[agentId][serviceHash];
    }

    function agentStatus(uint256 agentId) public view override returns (AgentStatus memory) {
        return _agentStatusAt(agentId, emissionsGate.currentEpoch());
    }

    function isVerified(uint256 agentId) external view override returns (bool) {
        AgentStatus memory agent = agentStatus(agentId);
        return agent.verifiedCount > 0 && agent.diffCount == 0;
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        INTERNAL
    // ═══════════════════════════════════════════════════════════════════

    function _threshold(EpochState storage state) private view returns (uint256) {
        return state.verifiers.length / 2 + 1;
    }

    function _requiredAcceptances(uint256 epoch, EpochState storage state) private view returns (uint256) {
        uint256 others = state.verifiers.length - (_epochMember[epoch][state.publisher] ? 1 : 0);
        uint256 needed = _threshold(state);
        return needed < others ? needed : others;
    }

    function _roundKey(EpochState storage state) private view returns (bytes32) {
        return keccak256(abi.encode(state.bankGeneration, state.keySharesHash, state.planHash));
    }

    function _activateIfAccepted(uint256 epoch, EpochState storage state) private {
        if (_acceptances[epoch][_roundKey(state)] < _requiredAcceptances(epoch, state)) return;
        state.planActive = true;
        emit PlanActivated(epoch, state.planHash);
    }

    /// @dev Address of `key·G`, or zero for a key outside (0, n). With h = 0, R = G (even y, so
    ///      v = 27) and s = key·Gx mod n, ecrecover returns the address of Gx⁻¹·s·G = key·G.
    function _keyAddress(bytes32 key) private pure returns (address) {
        uint256 scalar = uint256(key);
        if (scalar == 0 || scalar >= SECP256K1_N) return address(0);
        return ecrecover(bytes32(0), 27, bytes32(SECP256K1_GX), bytes32(mulmod(scalar, SECP256K1_GX, SECP256K1_N)));
    }

    function _epochStart(uint256 epoch) private view returns (uint256) {
        IEmissionsGateSchedule gate = IEmissionsGateSchedule(address(emissionsGate));
        return gate.genesis() + epoch * gate.epochDuration();
    }

    function _commitDeadline(uint256 epoch, EpochState storage state) private view returns (uint256) {
        return _epochStart(epoch) + state.schedule.collectSeconds;
    }

    function _backupDeadline(uint256 epoch, EpochState storage state) private view returns (uint256) {
        return _commitDeadline(epoch, state) + state.schedule.backupSeconds;
    }

    function _attestDeadline(uint256 epoch, EpochState storage state) private view returns (uint256) {
        return _backupDeadline(epoch, state) + state.schedule.attestSeconds;
    }

    function _setSchedule(Schedule memory schedule_) private {
        if (
            schedule_.collectSeconds == 0 || schedule_.backupSeconds == 0 || schedule_.attestSeconds == 0
                || schedule_.slicesPerService == 0 || schedule_.probesPerService < schedule_.slicesPerService
        ) revert InvalidValue();
        uint256 total = uint256(schedule_.collectSeconds) + schedule_.backupSeconds + schedule_.attestSeconds;
        if (total > IEmissionsGateSchedule(address(emissionsGate)).epochDuration()) revert InvalidValue();
        _schedule = schedule_;
        emit ScheduleSet(schedule_);
    }

    function _pendingReward(
        IAntseedEmissionsGate gate,
        address verifier,
        uint256 epoch,
        uint32 slices,
        uint32 totalSlices,
        bytes32[] calldata proof
    ) private view returns (uint256) {
        EpochState storage state = _epochs[epoch];
        bytes32 root = state.finalizedRoot;
        if (root == bytes32(0) || state.voided || !state.rewarded) return 0;
        uint256 budget = gate.controllerEpochBudget(address(this), epoch);
        if (budget == 0) return 0;
        uint256 attestBps = state.attestRewardBps;
        uint256 reward;
        if (attestations[epoch][verifier] == root) {
            reward = (budget * attestBps) / BPS / rootVotes[epoch][root];
        }
        if (slices != 0) {
            if (totalSlices < slices) revert InvalidValue();
            if (!MerkleProof.verifyCalldata(proof, root, collectorLeaf(epoch, verifier, slices, totalSlices))) {
                revert InvalidProof();
            }
            reward += (budget * (BPS - attestBps) * slices) / BPS / totalSlices;
        }
        uint256 cap = (budget * state.maxVerifierShareBps) / BPS;
        return reward < cap ? reward : cap;
    }

    function _applyResult(uint256 agentId, bytes32 serviceHash, bytes32 modelHash, Verdict verdict, uint256 epoch)
        private
    {
        ServiceStatus storage service = _serviceStatus[agentId][serviceHash];
        // A late apply never overwrites a verdict from a newer epoch.
        if (service.verdict != Verdict.NONE && service.epoch > epoch) return;
        uint256 current = emissionsGate.currentEpoch();
        if (service.modelHash != modelHash) {
            if (service.modelHash != bytes32(0)) _resetService(agentId, serviceHash, service, current);
            service.modelHash = modelHash;
        }
        Verdict previous = _liveVerdict(service, current);
        if (service.verdict == verdict && service.epoch == epoch) return;
        _uncount(agentId, service);
        EpochCounts storage counts = _epochCounts[agentId][epoch];
        if (verdict == Verdict.SAME) counts.same += 1;
        else if (verdict == Verdict.DIFF) counts.diff += 1;
        service.verdict = verdict;
        service.epoch = uint64(epoch);
        Verdict live = _liveVerdict(service, current);
        if (previous == live) return;
        service.updatedAt = uint64(block.timestamp);
        _emitServiceChange(agentId, serviceHash, service, previous, live, current);
    }

    function _resetService(uint256 agentId, bytes32 serviceHash, ServiceStatus storage service, uint256 epoch)
        private
    {
        Verdict previous = _liveVerdict(service, epoch);
        _uncount(agentId, service);
        service.verdict = Verdict.NONE;
        service.epoch = 0;
        service.updatedAt = uint64(block.timestamp);
        if (previous != Verdict.NONE) _emitServiceChange(agentId, serviceHash, service, previous, Verdict.NONE, epoch);
    }

    /// @dev Removes the service's stored verdict from the counter of the epoch it was given in.
    function _uncount(uint256 agentId, ServiceStatus storage service) private {
        Verdict stored = service.verdict;
        if (stored == Verdict.NONE) return;
        EpochCounts storage counts = _epochCounts[agentId][service.epoch];
        if (stored == Verdict.SAME) counts.same -= 1;
        else if (stored == Verdict.DIFF) counts.diff -= 1;
    }

    function _liveVerdict(ServiceStatus storage service, uint256 epoch) private view returns (Verdict) {
        Verdict stored = service.verdict;
        if (stored == Verdict.NONE || epoch >= service.epoch + validityEpochs) return Verdict.NONE;
        return stored;
    }

    /// @dev Sums the counters of the epochs whose verdicts are still live, saturating at uint16.
    function _agentStatusAt(uint256 agentId, uint256 epoch) private view returns (AgentStatus memory status) {
        uint256 same;
        uint256 diff;
        uint256 window = validityEpochs;
        for (uint256 i = 0; i < window && i <= epoch; i++) {
            EpochCounts storage counts = _epochCounts[agentId][epoch - i];
            same += counts.same;
            diff += counts.diff;
        }
        status.verifiedCount = uint16(same > type(uint16).max ? type(uint16).max : same);
        status.diffCount = uint16(diff > type(uint16).max ? type(uint16).max : diff);
    }

    function _emitServiceChange(
        uint256 agentId,
        bytes32 serviceHash,
        ServiceStatus storage service,
        Verdict previous,
        Verdict current,
        uint256 epoch
    ) private {
        emit ServiceStatusChanged(agentId, serviceHash, service.modelHash, previous, current);
        AgentStatus memory agent = _agentStatusAt(agentId, epoch);
        emit AgentStatusChanged(agentId, agent.verifiedCount, agent.diffCount);
    }

    function _setBank(
        uint256 epoch,
        EpochState storage state,
        bytes32 bankHash,
        bytes32 bankKeyHash,
        string calldata bankUri
    ) private {
        // `bankKeyHash` is an address: anything wider could never be revealed.
        if (bankHash == bytes32(0) || bankKeyHash == bytes32(0) || uint256(bankKeyHash) >> 160 != 0) revert InvalidValue();
        _validateUri(bankUri);
        state.bankHash = bankHash;
        state.bankKeyHash = bankKeyHash;
        state.keySharesHash = bytes32(0);
        state.planHash = bytes32(0);
        state.bankGeneration += 1;
        state.publisher = msg.sender;
        emit BankCommitted(epoch, bankHash, bankKeyHash, bankUri);
    }

    function _setSellerPools(address sellerPools_) private {
        if (sellerPools_.code.length == 0) revert InvalidAddress();
        sellerPools = IAntseedSellerPools(sellerPools_);
        emit SellerPoolsSet(sellerPools_);
    }

    /// @dev False for agents the identity registry cannot resolve, e.g. burned ones.
    function _agentKnown(uint256 agentId) private view returns (bool) {
        if (agentId == 0) return false;
        try IERC8004Registry(registry.identityRegistry()).ownerOf(agentId) returns (address owner) {
            return owner != address(0);
        } catch {
            return false;
        }
    }

    function _validateUri(string calldata uri) private pure {
        uint256 length = bytes(uri).length;
        if (length <= 7 || length > MAX_URI_BYTES || bytes7(bytes(uri)[:7]) != bytes7("ipfs://")) revert InvalidUri();
    }
}
