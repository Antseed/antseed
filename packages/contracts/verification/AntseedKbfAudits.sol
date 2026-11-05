// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Ownable2Step } from "@openzeppelin/contracts/access/Ownable2Step.sol";

import { IAntseedKbfAudits } from "../interfaces/IAntseedKbfAudits.sol";
import { IAntseedSellerPools } from "../interfaces/IAntseedSellerPools.sol";
import { IAntseedVerificationResults } from "../interfaces/IAntseedVerificationResults.sol";
import { IERC8004Registry } from "../interfaces/IERC8004Registry.sol";

/// @notice KBF (Knowledge Boundary Fingerprinting) audit. See `IAntseedKbfAudits`.
///
///         Each submission is one auditor's report for every listed (agent, service) under one
///         model. A verdict is recorded into the results layer once `requiredReports[verdict]`
///         distinct approved auditors report it for the same (agent, service, model) in the same
///         epoch and report round (defaults: SAME 1, DIFF 2, UNDETERMINED 1). Replacing a live DIFF
///         needs at least `diffReplacementReports` reports (default 1), whatever the new result or
///         model, so a single SAME clears a DIFF unless the owner raises it (e.g. to 2, so one auditor
///         cannot clear a confirmed DIFF). An auditor's later report replaces its earlier one;
///         a repeated report adds no support, so it records again only when one report is enough.
///         Every report emits `ServiceAudited` with its round, the reports so far and the reports
///         needed.
///
///         Report rounds: a result recorded here that moves the service's live verdict into or out
///         of DIFF starts a new round, so support given before a DIFF was confirmed cannot clear it
///         and support given before a DIFF was cleared cannot restore it. Revoking an auditor starts
///         a new round everywhere. The results layer counts moves into or out of DIFF made by any
///         audit (`diffChanges`) and owner clears (`serviceClears`), and both move KBF rounds too,
///         so support given before another audit's DIFF or an owner clear never counts after it.
///         Any live DIFF, whoever recorded it, needs `diffReplacementReports` support to replace.
///
///         Results for agents the identity registry cannot resolve are skipped with
///         `UnknownAgentSkipped`, so one stale agent does not fail the whole audit. An auditor
///         cannot audit its own agent. Any auditor may submit any evidence hash (as in the earlier
///         contract), so nobody can block another auditor's evidence by submitting its hash first.
///
///         Credits: a model audit that covers at least one agent with staked pool power earns the
///         auditor `creditsFor(modelHash)` credits through `results.credit` (the owner's
///         `creditsPerAudit`, default 1, or a per-model override), for at most
///         `maxCreditsPerModelPerEpoch` audits per model and epoch. The results layer applies this audit's rewards start epoch and
///         per-verifier caps, and pays claims from this audit's share of the verification bucket.
contract AntseedKbfAudits is IAntseedKbfAudits, Ownable2Step {
    uint256 public constant MAX_RESULTS_PER_AUDIT = 256;
    uint256 public constant MAX_EVIDENCE_URI_BYTES = 200;
    uint256 public constant MAX_PROFILE_NAME_BYTES = 64;
    uint256 public constant MAX_PROFILE_URI_BYTES = 256;
    /// @notice Most epochs a KBF verdict can count for, including the one it was given in.
    uint8 public constant MAX_VALIDITY_EPOCHS = 4;

    IAntseedVerificationResults public immutable override results;
    /// @notice ERC-8004 identity registry: resolves agent owners for the self-audit check.
    IERC8004Registry public immutable override identityRegistry;
    IAntseedSellerPools public override sellerPools;

    /// @inheritdoc IAntseedKbfAudits
    mapping(address auditor => bool approved) public override approvedAuditors;
    /// @inheritdoc IAntseedKbfAudits
    uint256 public override auditorRevocations;
    mapping(address auditor => AuditorProfile profile) private _profiles;
    /// @notice Distinct approved auditors that must report a verdict in one epoch before it is recorded.
    mapping(IAntseedVerificationResults.Verdict verdict => uint8 reports) public override requiredReports;
    /// @inheritdoc IAntseedKbfAudits
    uint8 public override diffReplacementReports = 1;
    /// @inheritdoc IAntseedKbfAudits
    uint8 public override validityEpochs = 2;

    /// @notice Safety limit: credited audits of the same model per auditor and epoch (default 1).
    ///         Stops an auditor from earning repeatedly by re-auditing one model.
    uint32 public override maxCreditsPerModelPerEpoch = 1;
    /// @inheritdoc IAntseedKbfAudits
    uint32 public override creditsPerAudit = 1;
    /// @inheritdoc IAntseedKbfAudits
    mapping(bytes32 modelHash => uint32 credits) public override modelCreditsPerAudit;
    /// @inheritdoc IAntseedKbfAudits
    mapping(uint256 epoch => mapping(address auditor => mapping(bytes32 modelHash => uint256 audits)))
        public
        override creditedAudits;

    // Reports per (epoch, agent, service, model, round): how many auditors report each verdict, and each auditor's report.
    mapping(bytes32 reportKey => mapping(IAntseedVerificationResults.Verdict verdict => uint256 reports)) private
        _reportCounts;
    mapping(bytes32 reportKey => mapping(address auditor => IAntseedVerificationResults.Verdict verdict)) private
        _reports;

    event SellerPoolsSet(address sellerPools);
    event RequiredReportsSet(IAntseedVerificationResults.Verdict indexed verdict, uint8 reports);
    event DiffReplacementReportsSet(uint8 reports);
    event ValidityEpochsSet(uint8 validityEpochs);
    event MaxCreditsPerModelPerEpochSet(uint32 maxCredits);
    event CreditsPerAuditSet(uint32 credits);
    /// @param credits Credits an audit of `modelHash` earns; 0 means it earns `creditsPerAudit`.
    event ModelCreditsPerAuditSet(bytes32 indexed modelHash, uint32 credits);
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
    /// @param credits Credits the results layer granted for the audit (after its per-auditor cap).
    event AuditCredited(uint256 indexed epoch, address indexed auditor, bytes32 indexed modelHash, uint256 credits);
    event UnknownAgentSkipped(uint256 indexed agentId, bytes32 indexed modelHash);

    error InvalidAddress();
    error InvalidValue();
    error NotApprovedAuditor();
    error InvalidEvidenceUri();
    error InvalidProfile();
    error InvalidResults();
    error UnknownAgent();
    error SelfAudit();
    error EpochChanged();

    constructor(address results_, address sellerPools_, address identityRegistry_) Ownable(msg.sender) {
        if (results_.code.length == 0 || identityRegistry_.code.length == 0) revert InvalidAddress();
        results = IAntseedVerificationResults(results_);
        identityRegistry = IERC8004Registry(identityRegistry_);
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
        emit AuditorSet(auditor, approved, auditorRevocations);
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

    /// @notice Distinct approved auditors a non-DIFF result needs to replace a live DIFF (default 1).
    ///         The result's own `requiredReports` still applies when it is higher. Applies from the
    ///         next report on.
    function setDiffReplacementReports(uint8 reports) external onlyOwner {
        if (reports == 0) revert InvalidValue();
        diffReplacementReports = reports;
        emit DiffReplacementReportsSet(reports);
    }

    /// @notice Epochs a KBF verdict counts for, including the one it was given in (default 2: KBF
    ///         audits every model every epoch, so a verdict lasts until the next audit lands).
    ///         Applies to verdicts recorded from now on; recorded ones keep their expiry.
    function setValidityEpochs(uint8 epochs) external onlyOwner {
        if (epochs == 0 || epochs > MAX_VALIDITY_EPOCHS) revert InvalidValue();
        validityEpochs = epochs;
        emit ValidityEpochsSet(epochs);
    }

    /// @notice Credits a model audit earns unless its model has its own amount (default 1).
    ///         Applies to audits submitted from now on.
    function setCreditsPerAudit(uint32 credits) external onlyOwner {
        if (credits == 0) revert InvalidValue();
        creditsPerAudit = credits;
        emit CreditsPerAuditSet(credits);
    }

    /// @notice Credits an audit of `modelHash` earns, e.g. more for a model that costs auditors
    ///         more to audit. 0 removes the override, so the model earns `creditsPerAudit` again.
    ///         Applies to audits submitted from now on.
    function setModelCreditsPerAudit(bytes32 modelHash, uint32 credits) external onlyOwner {
        if (modelHash == bytes32(0)) revert InvalidValue();
        modelCreditsPerAudit[modelHash] = credits;
        emit ModelCreditsPerAuditSet(modelHash, credits);
    }

    /// @inheritdoc IAntseedKbfAudits
    function creditsFor(bytes32 modelHash) public view override returns (uint256) {
        uint32 credits = modelCreditsPerAudit[modelHash];
        return credits == 0 ? creditsPerAudit : credits;
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
        if (bytes(name).length > MAX_PROFILE_NAME_BYTES || !_isPlainText(bytes(name))) revert InvalidProfile();
        _validateProfileUri(iconUri);
        _validateProfileUri(url);
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


        IERC8004Registry identity = identityRegistry;
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
            _report(result.agentId, result.serviceHash, modelHash, result.verdict, epoch);
        }

        emit ModelAudited(modelHash, msg.sender, expectedEpoch, evidenceHash, evidenceUri, count);
        if (staked) _creditAudit(epoch, modelHash);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        VIEWS
    // ═══════════════════════════════════════════════════════════════════

    function agentOwner(uint256 agentId) external view override returns (bool known, address owner) {
        if (agentId == 0) return (false, address(0));
        return _agentOwner(identityRegistry, agentId);
    }

    /// @notice The service's report round: only reports made in it count. It moves on whenever a
    ///         result recorded here moves the service's verdict into or out of DIFF, and whenever an
    ///         auditor is revoked. Both only grow, so a round never comes back.
    function reportRound(uint256 agentId, bytes32 serviceHash) public view override returns (uint256) {
        return results.diffChanges(agentId, serviceHash) + results.serviceClears(agentId, serviceHash) + auditorRevocations;
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
        uint256 epoch
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
        // Replacing a live DIFF takes at least `diffReplacementReports` auditors.
        if (
            verdict != IAntseedVerificationResults.Verdict.DIFF && live == IAntseedVerificationResults.Verdict.DIFF
            && diffReplacementReports > required
        ) {
            required = diffReplacementReports;
        }
        emit ServiceAudited(agentId, serviceHash, msg.sender, modelHash, verdict, round, reports, required);
        if (reports < required || (!addsSupport && required != 1)) return;

        results.record(agentId, serviceHash, modelHash, verdict, epoch + validityEpochs);
    }

    /// @dev `creditsFor(modelHash)` credits per audit, for at most `maxCreditsPerModelPerEpoch` audits
    ///      of the model per auditor and epoch, and within the results layer's caps.
    function _creditAudit(uint256 epoch, bytes32 modelHash) private {
        if (creditedAudits[epoch][msg.sender][modelHash] >= maxCreditsPerModelPerEpoch) return;
        uint256 credited = results.credit(msg.sender, creditsFor(modelHash));
        if (credited == 0) return;
        creditedAudits[epoch][msg.sender][modelHash] += 1;
        emit AuditCredited(epoch, msg.sender, modelHash, credited);
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

    /// @dev Empty, or an `https://` / `ipfs://` link of at most `MAX_PROFILE_URI_BYTES` with no spaces,
    ///      control characters, quotes, angle brackets, backslashes or backticks, so a UI can put it in
    ///      an `href` or `src` without it turning into script or markup.
    function _validateProfileUri(string calldata uri) private pure {
        bytes calldata b = bytes(uri);
        uint256 length = b.length;
        if (length == 0) return;
        if (length > MAX_PROFILE_URI_BYTES) revert InvalidProfile();
        bool https = length > 8 && bytes8(b[:8]) == bytes8("https://");
        bool ipfs = length > 7 && bytes7(b[:7]) == bytes7("ipfs://");
        if (!https && !ipfs) revert InvalidProfile();
        for (uint256 i = 0; i < length; i++) {
            bytes1 c = b[i];
            if (
                c <= 0x20 || c == 0x7f || c == '"' || c == "'" || c == "<" || c == ">" || c == "\\" || c == "`"
            ) revert InvalidProfile();
        }
    }

    /// @dev No control characters (UTF-8 multibyte characters are fine).
    function _isPlainText(bytes calldata b) private pure returns (bool) {
        for (uint256 i = 0; i < b.length; i++) {
            if (b[i] < 0x20 || b[i] == 0x7f) return false;
        }
        return true;
    }

    function _validateEvidenceUri(string calldata evidenceUri) private pure {
        uint256 length = bytes(evidenceUri).length;
        if (length == 0) return;
        if (length <= 7 || length > MAX_EVIDENCE_URI_BYTES || bytes7(bytes(evidenceUri)[:7]) != bytes7("ipfs://")) {
            revert InvalidEvidenceUri();
        }
    }
}
