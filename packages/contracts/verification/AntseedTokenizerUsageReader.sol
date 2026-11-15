// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IAntseedTokenizerUsageReader } from "../interfaces/IAntseedTokenizerUsageReader.sol";
import { AntseedResponseAuth } from "./AntseedResponseAuth.sol";

/// @notice Reads the prompt tokens a signed response reports, the way the buyer reads usage. See
///         `IAntseedTokenizerUsageReader`.
/// @dev Off-chain twin: `promptTokensOfBody` in `packages/node/src/payments/evm/tokenizer-usage.ts`. Change both
///      sides together.
contract AntseedTokenizerUsageReader is IAntseedTokenizerUsageReader {
    uint256 private constant MAX_TOKEN_DIGITS = 15;
    bytes private constant USAGE = '"usage"';
    bytes private constant PROMPT_TOKENS = '"prompt_tokens"';
    bytes private constant INPUT_TOKENS = '"input_tokens"';
    bytes private constant CACHE_READ_TOKENS = '"cache_read_input_tokens"';
    bytes private constant CACHE_CREATION_TOKENS = '"cache_creation_input_tokens"';
    bytes private constant CACHE_HIT_TOKENS = '"prompt_cache_hit_tokens"';
    bytes private constant INPUT_TOKENS_DETAILS = '"input_tokens_details"';
    bytes private constant PROMPT_TOKENS_DETAILS = '"prompt_tokens_details"';
    bytes private constant CACHED_TOKENS = '"cached_tokens"';
    /// @dev Which `*_tokens_details` object of `usage` the parser is inside.
    uint256 private constant IN_INPUT_DETAILS = 1;
    uint256 private constant IN_PROMPT_DETAILS = 2;
    /// @dev What `_keyValue` found at an offset.
    uint256 private constant NOT_KEY = 0;
    uint256 private constant NUMBER = 1;
    uint256 private constant NULL_VALUE = 2;
    uint256 private constant BAD_VALUE = 3;

    /// @inheritdoc IAntseedTokenizerUsageReader
    /// @dev The buyer's own reading of usage (`extractUsage` in `packages/api-adapter`): `prompt_tokens` is the
    ///      whole input; so is `input_tokens` when `input_tokens_details` has `cached_tokens` (a subset).
    ///      Otherwise `input_tokens` is fresh only, and the cache creation and the cached input are added: the
    ///      larger of `prompt_tokens_details.cached_tokens` and the cache reads (`cache_read_input_tokens`,
    ///      else `prompt_cache_hit_tokens`).
    function promptTokensOf(bytes calldata responseBody) external pure override returns (bool found, uint256 tokens) {
        UsageKeys memory usage = _usageKeys(responseBody);
        if (usage.objects != 1 || usage.ambiguous) return (false, 0);
        if (usage.promptCount == 1) return (true, usage.prompt);
        if (
            usage.promptCount > 1 || usage.inputCount != 1 || usage.readCount > 1 || usage.creationCount > 1
                || usage.hitCount > 1 || usage.inputDetailsCount > 1 || usage.promptDetailsCount > 1
                || usage.inputCachedCount > 1 || usage.promptCachedCount > 1
        ) return (false, 0);
        if (usage.inputCachedCount == 1) return (true, usage.input);
        uint256 separate = usage.readCount == 1 ? usage.cacheRead : usage.cacheHit;
        uint256 cached = usage.promptCached > separate ? usage.promptCached : separate;
        return (true, usage.input + usage.cacheCreation + cached);
    }

    /// @dev The top-level `usage` objects of a response, and inside them how many times each usage key
    ///      appears with a number, and its first number. `inputCachedCount` counts `cached_tokens` keys in
    ///      `input_tokens_details` whatever their value, as `extractUsage` only checks it is there.
    struct UsageKeys {
        uint256 objects;
        uint256 promptCount;
        uint256 prompt;
        uint256 inputCount;
        uint256 input;
        uint256 readCount;
        uint256 cacheRead;
        uint256 creationCount;
        uint256 cacheCreation;
        uint256 hitCount;
        uint256 cacheHit;
        uint256 inputDetailsCount;
        uint256 promptDetailsCount;
        uint256 inputCachedCount;
        uint256 promptCachedCount;
        uint256 promptCached;
        /// @dev A member name with an escape, or a usage key whose value is neither a whole number nor null:
        ///      the buyer's JSON parser could read it differently, so the usage is unreadable.
        bool ambiguous;
    }

    /// @dev One pass over the JSON `body`, tracking strings and nesting, that reads the usage keys directly
    ///      inside the top-level `usage` object, and `cached_tokens` directly inside its `input_tokens_details`
    ///      and `prompt_tokens_details`, only (other nested breakdowns, e.g. Responses' per-item usage, and text
    ///      that looks like a key are ignored). A member name with an escape at a level it reads (the top
    ///      level, `usage`, a details object) makes the usage ambiguous: it may decode to a key it looks for.
    function _usageKeys(bytes calldata body) private pure returns (UsageKeys memory usage) {
        uint256 length = body.length;
        uint256 depth;
        bool inString;
        bool escaped;
        bool watched;
        bool hadEscape;
        bool inUsage;
        uint256 inDetails;
        for (uint256 i = 0; i < length; i++) {
            bytes1 c;
            assembly {
                // `i < length`, so the read stays inside `body`.
                c := and(calldataload(add(body.offset, i)), shl(248, 0xff))
            }
            if (inString) {
                if (escaped) {
                    escaped = false;
                } else if (c == "\\") {
                    escaped = true;
                    hadEscape = true;
                } else if (c == '"') {
                    inString = false;
                    if (watched && hadEscape && _colonAt(body, i + 1)) usage.ambiguous = true;
                }
                continue;
            }
            if (c == "{" || c == "[") {
                depth++;
            } else if (c == "}" || c == "]") {
                if (depth == 2 && inUsage) inUsage = false;
                if (depth == 3) inDetails = 0;
                if (depth != 0) depth--;
            } else if (c == '"') {
                uint256 next = depth == 1 ? _objectAfter(body, i, USAGE) : 0;
                if (next != 0) {
                    usage.objects++;
                    inUsage = true;
                    depth = 2;
                    i = next;
                    continue;
                }
                if (depth == 2 && inUsage) {
                    inDetails = _detailsAt(body, i);
                    if (inDetails != 0) {
                        if (inDetails == IN_INPUT_DETAILS) usage.inputDetailsCount++;
                        else usage.promptDetailsCount++;
                        depth = 3;
                        i = _objectAfter(body, i, inDetails == IN_INPUT_DETAILS ? INPUT_TOKENS_DETAILS : PROMPT_TOKENS_DETAILS);
                        continue;
                    }
                    next = _readUsageKey(body, i, usage);
                } else if (depth == 3 && inDetails != 0) {
                    next = _readCachedTokens(body, i, inDetails, usage);
                }
                if (next != 0) {
                    i = next - 1;
                } else {
                    inString = true;
                    watched = depth == 1 || (depth == 2 && inUsage) || (depth == 3 && inDetails != 0);
                    hadEscape = false;
                }
            }
        }
    }

    /// @dev Whether optional whitespace and a colon follow `offset`.
    function _colonAt(bytes calldata body, uint256 offset) private pure returns (bool) {
        uint256 length = body.length;
        while (offset < length && _isAsciiSpace(body[offset])) offset++;
        return offset < length && body[offset] == ":";
    }

    /// @dev If `key` (quotes included) starts at `offset` and its value is an object, the offset of that `{`;
    ///      else 0.
    function _objectAfter(bytes calldata body, uint256 offset, bytes memory key) private pure returns (uint256) {
        uint256 end = _colonAfterKey(body, offset, key);
        if (end == 0) return 0;
        uint256 length = body.length;
        while (end < length && _isAsciiSpace(body[end])) end++;
        return end < length && body[end] == "{" ? end : 0;
    }

    /// @dev If `key` (quotes included) starts at `offset` followed by a colon, the offset after the colon; else 0.
    function _colonAfterKey(bytes calldata body, uint256 offset, bytes memory key) private pure returns (uint256) {
        uint256 end = offset + key.length;
        if (end > body.length || keccak256(key) != AntseedResponseAuth.hashCalldata(body[offset:end])) return 0;
        uint256 length = body.length;
        while (end < length && _isAsciiSpace(body[end])) end++;
        return end < length && body[end] == ":" ? end + 1 : 0;
    }

    /// @dev Which `*_tokens_details` object starts at `offset` (`IN_INPUT_DETAILS` or `IN_PROMPT_DETAILS`); 0 if none.
    function _detailsAt(bytes calldata body, uint256 offset) private pure returns (uint256) {
        if (_objectAfter(body, offset, INPUT_TOKENS_DETAILS) != 0) return IN_INPUT_DETAILS;
        if (_objectAfter(body, offset, PROMPT_TOKENS_DETAILS) != 0) return IN_PROMPT_DETAILS;
        return 0;
    }

    /// @dev Reads a `cached_tokens` key starting at `offset` inside a details object: in `input_tokens_details`
    ///      any value counts (only its presence matters), in `prompt_tokens_details` a number. Returns the offset
    ///      just after the key's closing quote; 0 otherwise.
    function _readCachedTokens(bytes calldata body, uint256 offset, uint256 inDetails, UsageKeys memory usage)
        private
        pure
        returns (uint256)
    {
        if (inDetails == IN_INPUT_DETAILS) {
            if (_colonAfterKey(body, offset, CACHED_TOKENS) == 0) return 0;
            usage.inputCachedCount++;
            return offset + CACHED_TOKENS.length;
        }
        (uint256 kind, uint256 value, uint256 end) = _keyValue(body, offset, CACHED_TOKENS);
        if (kind == NUMBER && usage.promptCachedCount++ == 0) usage.promptCached = value;
        if (kind == BAD_VALUE) usage.ambiguous = true;
        return end;
    }

    /// @dev Reads the usage key starting at `offset`, if it is one, and returns the offset just after the
    ///      key's closing quote; 0 otherwise. A null value counts as absent, as the buyer reads it; any value
    ///      other than a whole number or null makes the usage ambiguous.
    function _readUsageKey(bytes calldata body, uint256 offset, UsageKeys memory usage) private pure returns (uint256) {
        bytes1 first = offset + 1 < body.length ? body[offset + 1] : bytes1(0);
        uint256 kind;
        uint256 value;
        uint256 end;
        if (first == "p") {
            (kind, value, end) = _keyValue(body, offset, PROMPT_TOKENS);
            if (kind == NUMBER) {
                if (usage.promptCount++ == 0) usage.prompt = value;
            } else if (kind == NOT_KEY) {
                (kind, value, end) = _keyValue(body, offset, CACHE_HIT_TOKENS);
                if (kind == NUMBER && usage.hitCount++ == 0) usage.cacheHit = value;
            }
        } else if (first == "i") {
            (kind, value, end) = _keyValue(body, offset, INPUT_TOKENS);
            if (kind == NUMBER && usage.inputCount++ == 0) usage.input = value;
        } else if (first == "c") {
            (kind, value, end) = _keyValue(body, offset, CACHE_READ_TOKENS);
            if (kind == NUMBER) {
                if (usage.readCount++ == 0) usage.cacheRead = value;
            } else if (kind == NOT_KEY) {
                (kind, value, end) = _keyValue(body, offset, CACHE_CREATION_TOKENS);
                if (kind == NUMBER && usage.creationCount++ == 0) usage.cacheCreation = value;
            }
        }
        if (kind == BAD_VALUE) usage.ambiguous = true;
        return end;
    }

    /// @dev Whether `key` (quotes included) starts at `offset` as a member name, and its value: `NOT_KEY`,
    ///      `NUMBER` (1 to 15 digits ending the member: a decimal or exponent is no token count), `NULL_VALUE` or
    ///      `BAD_VALUE`; with the offset after the key unless `NOT_KEY`.
    function _keyValue(bytes calldata body, uint256 offset, bytes memory key)
        private
        pure
        returns (uint256 kind, uint256 value, uint256 end)
    {
        end = offset + key.length;
        if (end > body.length || keccak256(key) != AntseedResponseAuth.hashCalldata(body[offset:end])) {
            return (NOT_KEY, 0, 0);
        }
        uint256 length = body.length;
        uint256 at = end;
        while (at < length && _isAsciiSpace(body[at])) at++;
        if (at >= length || body[at] != ":") return (NOT_KEY, 0, 0);
        at++;
        while (at < length && _isAsciiSpace(body[at])) at++;
        kind = NUMBER;
        if (at + 4 <= length && bytes4(body[at:at + 4]) == "null") {
            kind = NULL_VALUE;
            at += 4;
        } else {
            uint256 digits;
            while (at < length && body[at] >= "0" && body[at] <= "9") {
                if (++digits > MAX_TOKEN_DIGITS) return (BAD_VALUE, 0, end);
                value = value * 10 + (uint8(body[at]) - 48);
                at++;
            }
            if (digits == 0) return (BAD_VALUE, 0, end);
        }
        while (at < length && _isAsciiSpace(body[at])) at++;
        if (at >= length || (body[at] != "," && body[at] != "}")) return (BAD_VALUE, 0, end);
    }

    function _isAsciiSpace(bytes1 c) private pure returns (bool) {
        return c == " " || c == "\t" || c == "\n" || c == "\r" || c == 0x0b || c == 0x0c;
    }
}
