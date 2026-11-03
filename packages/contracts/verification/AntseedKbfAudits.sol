// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Ownable2Step } from "@openzeppelin/contracts/access/Ownable2Step.sol";

import { IAntseedKbfAudits } from "../interfaces/IAntseedKbfAudits.sol";
import { IAntseedSellerPools } from "../interfaces/IAntseedSellerPools.sol";
import { IAntseedVerificationResults } from "../interfaces/IAntseedVerificationResults.sol";
import { IERC8004Registry } from "../interfaces/IERC8004Registry.sol";

/// @notice KBF (Knowledge Boundary Fingerprinting) audit source. See `IAntseedKbfAudits`.
///
///         Each submission is one auditor's report for every listed (agent, service) under one
///         model. A verdict is recorded into the results layer once `requiredReports[verdict]`
///         distinct approved auditors report it for the same (agent, service, model) in the same
///         epoch and report round (defaults: SAME 1, DIFF 2, UNDETERMINED 1). Replacing a live DIFF
///         needs as many reports as a DIFF does, whatever the new result or model, so one auditor
///         cannot clear a confirmed DIFF either. An auditor's later report replaces its earlier one;
///         a repeated report adds no support, so it records again only when one report is enough.
///         Every report emits `ServiceAudited` with its round, the reports so far and the reports
///         needed.
///
///         Report rounds: a result recorded here that moves the service's live verdict into or out
///         of DIFF starts a new round, so support given before a DIFF was confirmed cannot clear it
///         and support given before a DIFF was cleared cannot restore it. Revoking an auditor starts
///         a new round everywhere. Verdict changes made by other sources or by the results owner do
///         not move KBF rounds; KBF still reads the live verdict, so any live DIFF needs DIFF-level
///         support to replace.
///
///         Results for agents the identity registry cannot resolve are skipped with
///         `UnknownAgentSkipped`, so one stale agent does not fail the whole audit. An auditor
///         cannot audit its own agent. An evidence hash belongs to the auditor that first submits
///         it; another auditor submitting it reverts.
///
///         Credits: a model audit that covers at least one agent with staked pool power earns the
///         auditor one credit through `results.credit`, at most `maxCreditsPerModelPerEpoch` per
///         model and epoch. The results layer applies this source's rewards start epoch and
///         per-verifier caps, and pays claims from this source's share of the verification bucket.
contract AntseedKbfAudits is IAntseedKbfAudits, Ownable2Step {
    uint256 public constant MAX_RESULTS_PER_AUDIT = 256;
    uint256 public constant MAX_EVIDENCE_URI_BYTES = 200;
    uint256 public constant MAX_PROFILE_NAME_BYTES = 64;
    uint256 public constant MAX_PROFILE_URI_BYTES = 256;

    IAntseedVerificationResults public immutable override results;
    IAntseedSellerPools public override sellerPools;

    /// @inheritdoc IAntseedKbfAudits
    mapping(address auditor => bool approved) public override approvedAuditors;
    /// @inheritdoc IAntseedKbfAudits
    uint256 public override auditorRevocations;
    mapping(address auditor => AuditorProfile profile) private _profiles;
    /// @notice Distinct approved auditors that must report a verdict in one epoch before it is recorded.
    mapping(IAntseedVerificationResults.Verdict verdict => uint8 reports) public override requiredReports;
    /// @inheritdoc IAntseedKbfAudits
    mapping(bytes32 evidenceHash => address auditor) public override evidenceAuditor;
    /// @inheritdoc IAntseedKbfAudits
    mapping(uint256 agentId => mapping(bytes32 serviceHash => uint256 changes)) public override diffChanges;

    /// @notice Safety limit: credited audits of the same model per auditor and epoch (default 1).
    ///         Stops an auditor from earning repeatedly by re-auditing one model.
    uint32 public override maxCreditsPerModelPerEpoch = 1;
    mapping(uint256 epoch => mapping(address auditor => mapping(bytes32 modelHash => uint256 credits)))
        public
        override modelCredits;

    // Reports per (epoch, agent, service, model, round): how many auditors report each verdict, and each auditor's report.
    mapping(bytes32 reportKey => mapping(IAntseedVerificationResults.Verdict verdict => uint256 reports)) private
        _reportCounts;
    mapping(bytes32 reportKey => mapping(address auditor => IAntseedVerificationResults.Verdict verdict)) private
        _reports;

    event SellerPoolsSet(address sellerPools);
    event RequiredReportsSet(IAntseedVerificationResults.Verdict indexed verdict, uint8 reports);
    event MaxCreditsPerModelPerEpochSet(uint32 maxCredits);
    event ModelAudited(
        bytes32 indexed modelHash,
        address indexed auditor,
        uint256 indexed epoch,
        bytes32 evidenceHash,
        string evidenceUri,
        uint256 resultCount
    );
    /// @param round The service's report round; only reports of the current round count.
    /// @param reports Distinct auditors reporting `verdict` for this service and model this epoch and round.
    /// @param required Reports `verdict` needs to be recorded; it is recorded once `reports` reaches it.
    event ServiceAudited(
        uint256 indexed agentId,
        bytes32 indexed serviceHash,
        address indexed auditor,
        bytes32 modelHash,
        IAntseedVerificationResults.Verdict verdict,
        uint256 round,
        uint256 reports,
        uint256 required
    );
    event AuditCredited(uint256 indexed epoch, address indexed auditor, bytes32 indexed modelHash);
    event UnknownAgentSkipped(uint256 indexed agentId, bytes32 indexed modelHash);

    error InvalidAddress();
    error InvalidValue();
    error NotApprovedAuditor();
    error EvidenceReused();
    error InvalidEvidenceUri();
    error InvalidProfile();
    error InvalidResults();
    error UnknownAgent();
    error SelfAudit();
    error EpochChanged();

    constructor(address results_, address sellerPools_) Ownable(msg.sender) {
        if (results_.code.length == 0) revert InvalidAddress();
        results = IAntseedVerificationResults(results_);
        _setSellerPools(sellerPools_);
        requiredReports[IAntseedVerificationResults.Verdict.SAME] = 1;
        requiredReports[IAntseedVerificationResults.Verdict.DIFF] = 2;
        requiredReports[IAntseedVerificationResults.Verdict.UNDETERMINED] = 1;
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        ADMIN
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Approves or revokes an auditor. Revoking bumps `auditorRevocations`, so the auditor's
    ///         waiting reports stop counting; recorded verdicts and granted credits are not touched. Emits `AuditorSet` on every call: off-chain assignment rebuilds the
    ///         auditor set at an epoch's start from these events.
    function setAuditor(address auditor, bool approved) external override onlyOwner {
        if (auditor == address(0)) revert InvalidAddress();
        if (approvedAuditors[auditor] && !approved) auditorRevocations += 1;
        approvedAuditors[auditor] = approved;
        emit AuditorSet(auditor, approved);
    }

    /// @inheritdoc IAntseedKbfAudits
    function clearAuditorProfile(address auditor) external override onlyOwner {
        delete _profiles[auditor];
        emit AuditorProfileSet(auditor, "", "", "");
    }

    function setSellerPools(address sellerPools_) external onlyOwner {
        _setSellerPools(sellerPools_);
    }

    /// @notice Distinct approved auditors `verdict` needs in one epoch before it is recorded.
    ///         Applies from the next report on.
    function setRequiredReports(IAntseedVerificationResults.Verdict verdict, uint8 reports) external onlyOwner {
        if (verdict == IAntseedVerificationResults.Verdict.NONE || reports == 0) revert InvalidValue();
        requiredReports[verdict] = reports;
        emit RequiredReportsSet(verdict, reports);
    }

    /// @notice Sets the per-model safety limit on credited audits per auditor and epoch.
    function setMaxCreditsPerModelPerEpoch(uint32 maxCredits) external onlyOwner {
        if (maxCredits == 0) revert InvalidValue();
        maxCreditsPerModelPerEpoch = maxCredits;
        emit MaxCreditsPerModelPerEpochSet(maxCredits);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        PROFILES
    // ═══════════════════════════════════════════════════════════════════

    /// @inheritdoc IAntseedKbfAudits
    function setAuditorProfile(string calldata name, string calldata iconUri, string calldata url)
        external
        override
    {
        if (!approvedAuditors[msg.sender]) revert NotApprovedAuditor();
        if (
            bytes(name).length > MAX_PROFILE_NAME_BYTES || bytes(iconUri).length > MAX_PROFILE_URI_BYTES
                || bytes(url).length > MAX_PROFILE_URI_BYTES
        ) revert InvalidProfile();
        _profiles[msg.sender] = AuditorProfile(name, iconUri, url);
        emit AuditorProfileSet(msg.sender, name, iconUri, url);
    }

    /// @inheritdoc IAntseedKbfAudits
    function auditorProfile(address auditor) external view override returns (AuditorProfile memory) {
        return _profiles[auditor];
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        AUDITS
    // ═══════════════════════════════════════════════════════════════════

    function submitModelAudit(
        uint256 expectedEpoch,
        bytes32 modelHash,
        bytes32 evidenceHash,
        string calldata evidenceUri,
        ServiceResult[] calldata serviceResults
    ) external override {
        if (!approvedAuditors[msg.sender]) revert NotApprovedAuditor();
        if (modelHash == bytes32(0) || evidenceHash == bytes32(0)) revert InvalidValue();
        _validateEvidenceUri(evidenceUri);
        uint256 count = serviceResults.length;
        if (count == 0 || count > MAX_RESULTS_PER_AUDIT) revert InvalidResults();

        uint256 epoch = results.currentEpoch();
        if (epoch != expectedEpoch) revert EpochChanged();

        address evidenceOwner = evidenceAuditor[evidenceHash];
        if (evidenceOwner == address(0)) evidenceAuditor[evidenceHash] = msg.sender;
        else if (evidenceOwner != msg.sender) revert EvidenceReused();

        IERC8004Registry identity = IERC8004Registry(results.registry().identityRegistry());
        bool staked;
        bool skipAgent;
        uint256 previousAgent;
        bytes32 previousService;
        for (uint256 i = 0; i < count; i++) {
            ServiceResult calldata result = serviceResults[i];
            if (
                result.serviceHash == bytes32(0) || result.verdict == IAntseedVerificationResults.Verdict.NONE
                    || result.agentId < previousAgent
                    || (result.agentId == previousAgent && result.serviceHash <= previousService)
            ) revert InvalidResults();
            if (i == 0 || result.agentId != previousAgent) {
                if (result.agentId == 0) revert UnknownAgent();
                (bool known, address owner) = _agentOwner(identity, result.agentId);
                if (known && msg.sender == owner) revert SelfAudit();
                skipAgent = !known;
                if (skipAgent) emit UnknownAgentSkipped(result.agentId, modelHash);
                else if (!staked) staked = _hasPoolPower(result.agentId, epoch);
                previousAgent = result.agentId;
            }
            previousService = result.serviceHash;
            if (skipAgent) continue;
            _report(result.agentId, result.serviceHash, modelHash, result.verdict, epoch, evidenceHash);
        }

        emit ModelAudited(modelHash, msg.sender, expectedEpoch, evidenceHash, evidenceUri, count);
        if (staked) _creditAudit(epoch, modelHash);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        VIEWS
    // ═══════════════════════════════════════════════════════════════════

    function agentOwner(uint256 agentId) external view override returns (bool known, address owner) {
        if (agentId == 0) return (false, address(0));
        return _agentOwner(IERC8004Registry(results.registry().identityRegistry()), agentId);
    }

    /// @notice The service's report round: only reports made in it count. It moves on whenever a
    ///         result recorded here moves the service's verdict into or out of DIFF, and whenever an
    ///         auditor is revoked. Both only grow, so a round never comes back.
    function reportRound(uint256 agentId, bytes32 serviceHash) public view override returns (uint256) {
        return diffChanges[agentId][serviceHash] + auditorRevocations;
    }

    function reportKey(uint256 epoch, uint256 agentId, bytes32 serviceHash, bytes32 modelHash, uint256 round)
        public
        pure
        override
        returns (bytes32)
    {
        return keccak256(abi.encode(epoch, agentId, serviceHash, modelHash, round));
    }

    function reportOf(bytes32 key, address auditor)
        external
        view
        override
        returns (IAntseedVerificationResults.Verdict)
    {
        return _reports[key][auditor];
    }

    function reportCount(bytes32 key, IAntseedVerificationResults.Verdict verdict)
        external
        view
        override
        returns (uint256)
    {
        return _reportCounts[key][verdict];
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        INTERNAL
    // ═══════════════════════════════════════════════════════════════════

    /// @dev Counts the caller's report and records the verdict once enough auditors report it.
    function _report(
        uint256 agentId,
        bytes32 serviceHash,
        bytes32 modelHash,
        IAntseedVerificationResults.Verdict verdict,
        uint256 epoch,
        bytes32 evidenceHash
    ) private {
        uint256 round = reportRound(agentId, serviceHash);
        bytes32 key = reportKey(epoch, agentId, serviceHash, modelHash, round);
        IAntseedVerificationResults.Verdict previous = _reports[key][msg.sender];
        bool addsSupport = previous != verdict;
        if (addsSupport) {
            if (previous != IAntseedVerificationResults.Verdict.NONE) _reportCounts[key][previous] -= 1;
            _reportCounts[key][verdict] += 1;
            _reports[key][msg.sender] = verdict;
        }
        uint256 reports = _reportCounts[key][verdict];
        uint256 required = requiredReports[verdict];
        IAntseedVerificationResults.Verdict live = results.liveVerdict(agentId, serviceHash);
        // Replacing a live DIFF takes as many auditors as giving one.
        if (
            verdict != IAntseedVerificationResults.Verdict.DIFF && live == IAntseedVerificationResults.Verdict.DIFF
        ) {
            uint256 diffRequired = requiredReports[IAntseedVerificationResults.Verdict.DIFF];
            if (diffRequired > required) required = diffRequired;
        }
        emit ServiceAudited(agentId, serviceHash, msg.sender, modelHash, verdict, round, reports, required);
        if (reports < required || (!addsSupport && required != 1)) return;

        // A DIFF given or cleared here (including one replaced under a new model) starts a new round.
        if (
            live == IAntseedVerificationResults.Verdict.DIFF || verdict == IAntseedVerificationResults.Verdict.DIFF
        ) {
            if (live != verdict || results.serviceStatus(agentId, serviceHash).modelHash != modelHash) {
                diffChanges[agentId][serviceHash] += 1;
            }
        }
        results.record(agentId, serviceHash, modelHash, verdict, evidenceHash);
    }

    /// @dev One credit per audit, up to the per-model cap here and the source's caps in the results layer.
    function _creditAudit(uint256 epoch, bytes32 modelHash) private {
        if (modelCredits[epoch][msg.sender][modelHash] >= maxCreditsPerModelPerEpoch) return;
        if (results.credit(msg.sender, 1) == 0) return;
        modelCredits[epoch][msg.sender][modelHash] += 1;
        emit AuditCredited(epoch, msg.sender, modelHash);
    }

    /// @dev Failing pools never block an audit; they only withhold the credit.
    function _hasPoolPower(uint256 agentId, uint256 epoch) private view returns (bool) {
        try sellerPools.poolWeightAtEpoch(agentId, epoch) returns (uint256 weight) {
            return weight != 0;
        } catch {
            return false;
        }
    }

    /// @dev `known` is false for agents the identity registry cannot resolve, e.g. burned ones.
    function _agentOwner(IERC8004Registry identity, uint256 agentId)
        private
        view
        returns (bool known, address owner)
    {
        try identity.ownerOf(agentId) returns (address agentOwner_) {
            return (agentOwner_ != address(0), agentOwner_);
        } catch {
            return (false, address(0));
        }
    }

    function _setSellerPools(address sellerPools_) private {
        if (sellerPools_.code.length == 0) revert InvalidAddress();
        sellerPools = IAntseedSellerPools(sellerPools_);
        emit SellerPoolsSet(sellerPools_);
    }

    function _validateEvidenceUri(string calldata evidenceUri) private pure {
        uint256 length = bytes(evidenceUri).length;
        if (length == 0) return;
        if (length <= 7 || length > MAX_EVIDENCE_URI_BYTES || bytes7(bytes(evidenceUri)[:7]) != bytes7("ipfs://")) {
            revert InvalidEvidenceUri();
        }
    }
}
