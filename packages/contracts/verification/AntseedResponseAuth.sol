// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import { MessageHashUtils } from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import { Strings } from "@openzeppelin/contracts/utils/Strings.sol";

/// @notice On-chain check of a seller's ResponseAuth: the receipt a seller signs for every response
///         it serves. It lets a verification method use what a seller said as evidence anyone can
///         re-check, without trusting the buyer that collected it.
///
///         The seller signs, with its peer key (the seller's EVM address), an EIP-191 personal message
///         `"antseed-data-v1:" || payload`, where `payload` is 13 fields, each a big-endian uint32 byte
///         length followed by the field's UTF-8 bytes:
///         `"antseed-response-auth-v1"`, version, requestId, channelId (or empty), buyer and seller
///         peer ids (40 lowercase hex characters, no 0x), advertisedService, provider, statusCode,
///         requestHash, responseHash (each `0x` + 64 lowercase hex characters), responseStartedAt
///         and responseCompletedAt (milliseconds). Numbers are decimal ASCII.
///         `requestHash` and `responseHash` are keccak256 of the request and response in the
///         protocol's binary HTTP codec, so the signature covers the exact request and response bytes.
///
///         Request codec: u16 requestId length, requestId, u8 method length, method, u16 path length,
///         path, u16 header count, each header as (u16 length, key, u16 length, value), u32 body length,
///         body. Response codec: u16 requestId length, requestId, u16 status code, the same headers, u32
///         body length, body. All integers are big-endian.
/// @dev Off-chain side: `packages/buyer-core/src/response-auth.ts` (`encodeResponseAuthSigningPayload`)
///      and `packages/protocol/src/request-codec.ts`. Change both sides together.
library AntseedResponseAuth {
    bytes internal constant DOMAIN = "antseed-data-v1:";
    bytes internal constant RESPONSE_AUTH_DOMAIN = "antseed-response-auth-v1";

    /// @notice One signed response: the receipt fields the seller signed and the request and response
    ///         bytes they commit to.
    /// @param request The request in the binary HTTP codec (its keccak256 is the signed requestHash).
    /// @param response The response in the binary HTTP codec (its keccak256 is the signed responseHash).
    struct Receipt {
        uint32 version;
        string requestId;
        string channelId;
        address buyer;
        address seller;
        string advertisedService;
        string provider;
        uint16 statusCode;
        uint64 responseStartedAt;
        uint64 responseCompletedAt;
        bytes signature;
        bytes request;
        bytes response;
    }

    error MalformedRequest();
    error MalformedResponse();

    /// @notice The EIP-191 digest the seller signed for `receipt`.
    function digest(Receipt calldata receipt) internal pure returns (bytes32) {
        return MessageHashUtils.toEthSignedMessageHash(abi.encodePacked(DOMAIN, signingPayload(receipt)));
    }

    /// @notice True when `receipt.seller` signed the receipt. Never reverts on a bad signature.
    function signedBySeller(Receipt calldata receipt) internal pure returns (bool) {
        (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest(receipt), receipt.signature);
        return err == ECDSA.RecoverError.NoError && signer == receipt.seller && signer != address(0);
    }

    /// @notice The 13-field payload, exactly as the seller encodes it before signing.
    function signingPayload(Receipt calldata receipt) internal pure returns (bytes memory) {
        bytes memory head = abi.encodePacked(
            _field(RESPONSE_AUTH_DOMAIN),
            _field(bytes(Strings.toString(receipt.version))),
            _field(bytes(receipt.requestId)),
            _field(bytes(receipt.channelId)),
            _field(_peerId(receipt.buyer)),
            _field(_peerId(receipt.seller)),
            _field(bytes(receipt.advertisedService))
        );
        bytes memory tail = abi.encodePacked(
            _field(bytes(receipt.provider)),
            _field(bytes(Strings.toString(receipt.statusCode))),
            _field(bytes(Strings.toHexString(uint256(hashCalldata(receipt.request)), 32))),
            _field(bytes(Strings.toHexString(uint256(hashCalldata(receipt.response)), 32))),
            _field(bytes(Strings.toString(receipt.responseStartedAt))),
            _field(bytes(Strings.toString(receipt.responseCompletedAt)))
        );
        return bytes.concat(head, tail);
    }

    /// @notice Where the path and the body sit inside an encoded request.
    function requestPathAndBody(bytes calldata request)
        internal
        pure
        returns (uint256 pathStart, uint256 pathLength, uint256 bodyStart, uint256 bodyLength)
    {
        uint256 offset = 2 + _u16(request, 0, MalformedRequest.selector); // requestId
        if (offset >= request.length) revert MalformedRequest();
        offset += 1 + uint8(request[offset]); // method
        pathLength = _u16(request, offset, MalformedRequest.selector);
        pathStart = offset + 2;
        offset = _skipHeaders(request, pathStart + pathLength, MalformedRequest.selector);
        (bodyStart, bodyLength) = _body(request, offset, MalformedRequest.selector);
    }

    /// @notice The status code of an encoded response and where its body sits.
    function responseBody(bytes calldata response)
        internal
        pure
        returns (uint16 statusCode, uint256 start, uint256 length)
    {
        uint256 offset = 2 + _u16(response, 0, MalformedResponse.selector); // requestId
        statusCode = uint16(_u16(response, offset, MalformedResponse.selector));
        offset = _skipHeaders(response, offset + 2, MalformedResponse.selector);
        (start, length) = _body(response, offset, MalformedResponse.selector);
    }

    /// @notice keccak256 of calldata bytes without an ABI copy.
    function hashCalldata(bytes calldata data) internal pure returns (bytes32 result) {
        assembly ("memory-safe") {
            let ptr := mload(0x40)
            calldatacopy(ptr, data.offset, data.length)
            result := keccak256(ptr, data.length)
        }
    }

    function _field(bytes memory value) private pure returns (bytes memory) {
        return abi.encodePacked(uint32(value.length), value);
    }

    /// @dev 40 lowercase hex characters, no 0x, as the seller normalizes peer ids before signing.
    function _peerId(address peer) private pure returns (bytes memory out) {
        bytes memory full = bytes(Strings.toHexString(peer)); // "0x" + 40 lowercase hex
        out = new bytes(40);
        for (uint256 i = 0; i < 40; i++) {
            out[i] = full[i + 2];
        }
    }

    function _skipHeaders(bytes calldata data, uint256 offset, bytes4 err) private pure returns (uint256) {
        uint256 count = _u16(data, offset, err);
        offset += 2;
        for (uint256 i = 0; i < count; i++) {
            offset += 2 + _u16(data, offset, err); // key
            offset += 2 + _u16(data, offset, err); // value
        }
        return offset;
    }

    /// @dev The u32 body length at `offset` must cover exactly the rest of the encoding.
    function _body(bytes calldata data, uint256 offset, bytes4 err) private pure returns (uint256, uint256) {
        if (offset + 4 > data.length) _revert(err);
        uint256 length = uint32(bytes4(data[offset:offset + 4]));
        uint256 start = offset + 4;
        if (start + length != data.length) _revert(err);
        return (start, length);
    }

    function _u16(bytes calldata data, uint256 offset, bytes4 err) private pure returns (uint256) {
        if (offset + 2 > data.length) _revert(err);
        return uint16(bytes2(data[offset:offset + 2]));
    }

    function _revert(bytes4 selector) private pure {
        assembly ("memory-safe") {
            mstore(0, selector)
            revert(0, 4)
        }
    }
}
