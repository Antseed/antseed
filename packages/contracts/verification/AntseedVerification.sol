// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IAntseedRegistry} from "../interfaces/IAntseedRegistry.sol";
import {IAntseedVerification} from "../interfaces/IAntseedVerification.sol";
import {IERC8004Registry} from "../interfaces/IERC8004Registry.sol";

contract AntseedVerification is IAntseedVerification, Ownable2Step, ReentrancyGuard {
    uint256 public constant MAX_EVIDENCE_URI_BYTES = 200;
    uint256 public constant MAX_RESULTS_PER_BUNDLE = 256;
    IAntseedRegistry public immutable override registry;

    mapping(address verifier => bool approved) public override approvedVerifiers;
    mapping(bytes32 evidenceHash => VerificationBundle bundle) private _verificationBundles;
    mapping(bytes32 evidenceHash => VerificationResult[] results) private _verificationResults;

    event VerifierApprovalSet(address indexed verifier, bool approved);
    event VerificationBundleSubmitted(
        bytes32 indexed evidenceHash, address indexed verifier, uint32 resultCount, string evidenceUri
    );
    event VerificationResultSubmitted(
        bytes32 indexed evidenceHash,
        uint256 indexed agentId,
        bytes32 indexed serviceHash,
        address verifier,
        Verdict verdict
    );

    error InvalidAddress();
    error InvalidValue();
    error NotApprovedVerifier();
    error InvalidVerdict();
    error VerificationAlreadySubmitted();
    error InvalidEvidenceUri();
    error UnknownAgent();
    error SelfAudit();
    error DuplicateResult();

    modifier onlyApprovedVerifier() {
        if (!approvedVerifiers[msg.sender]) revert NotApprovedVerifier();
        _;
    }

    constructor(address registry_) Ownable(msg.sender) {
        if (registry_ == address(0) || registry_.code.length == 0) revert InvalidAddress();
        registry = IAntseedRegistry(registry_);
    }

    function setVerifier(address verifier, bool approved) external override onlyOwner {
        if (verifier == address(0)) revert InvalidAddress();
        approvedVerifiers[verifier] = approved;
        emit VerifierApprovalSet(verifier, approved);
    }

    function submitVerificationBundle(
        bytes32 evidenceHash,
        string calldata evidenceUri,
        VerificationResult[] calldata results
    ) external override onlyApprovedVerifier nonReentrant {
        if (evidenceHash == bytes32(0)) revert InvalidValue();
        if (results.length == 0 || results.length > MAX_RESULTS_PER_BUNDLE) revert InvalidValue();
        _validateEvidenceUri(evidenceUri);
        if (isVerificationSubmitted(evidenceHash)) revert VerificationAlreadySubmitted();

        for (uint256 i = 0; i < results.length; i++) {
            VerificationResult calldata result = results[i];
            _validateResult(result);
            if (_resolveAgentOwner(result.agentId) == msg.sender) revert SelfAudit();
            for (uint256 j = 0; j < i; j++) {
                if (results[j].agentId == result.agentId && results[j].serviceHash == result.serviceHash) {
                    revert DuplicateResult();
                }
            }
        }

        _verificationBundles[evidenceHash] = VerificationBundle({
            verifier: msg.sender,
            submittedAt: uint64(block.timestamp),
            resultCount: uint32(results.length),
            evidenceUri: evidenceUri
        });

        emit VerificationBundleSubmitted(evidenceHash, msg.sender, uint32(results.length), evidenceUri);
        for (uint256 i = 0; i < results.length; i++) {
            VerificationResult calldata result = results[i];
            _verificationResults[evidenceHash].push(result);
            emit VerificationResultSubmitted(
                evidenceHash, result.agentId, result.serviceHash, msg.sender, result.verdict
            );
        }
    }

    function isVerificationSubmitted(bytes32 evidenceHash) public view override returns (bool) {
        return _verificationBundles[evidenceHash].verifier != address(0);
    }

    function verificationBundle(bytes32 evidenceHash) external view override returns (VerificationBundle memory) {
        return _verificationBundles[evidenceHash];
    }

    function verificationResult(bytes32 evidenceHash, uint256 index)
        external
        view
        override
        returns (VerificationResult memory)
    {
        return _verificationResults[evidenceHash][index];
    }

    function _resolveAgentOwner(uint256 agentId) private view returns (address) {
        address identityRegistry = registry.identityRegistry();
        if (identityRegistry == address(0) || identityRegistry.code.length == 0) revert UnknownAgent();
        try IERC8004Registry(identityRegistry).ownerOf(agentId) returns (address owner) {
            if (owner == address(0)) revert UnknownAgent();
            return owner;
        } catch {
            revert UnknownAgent();
        }
    }

    function _validateResult(VerificationResult calldata result) private pure {
        if (result.agentId == 0 || result.serviceHash == bytes32(0)) revert InvalidValue();
        if (result.verdict == Verdict.UNKNOWN || uint8(result.verdict) > uint8(Verdict.UNDETERMINED)) {
            revert InvalidVerdict();
        }
    }

    function _validateEvidenceUri(string calldata evidenceUri) private pure {
        bytes memory uri = bytes(evidenceUri);
        if (uri.length == 0) return;
        if (
            uri.length <= 7 || uri.length > MAX_EVIDENCE_URI_BYTES || uri[0] != bytes1("i") || uri[1] != bytes1("p")
                || uri[2] != bytes1("f") || uri[3] != bytes1("s") || uri[4] != bytes1(":") || uri[5] != bytes1("/")
                || uri[6] != bytes1("/")
        ) revert InvalidEvidenceUri();
    }
}
