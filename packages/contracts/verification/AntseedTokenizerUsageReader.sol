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
    /// @dev One slot per member the reader looks for: its bit in `Usage.seen` and `Usage.numbers`, and for the
    ///      token counts its index in `Usage.values`. `*_CACHED` is `cached_tokens` in that details object.
    uint256 private constant PROMPT = 0;
    uint256 private constant INPUT = 1;
    uint256 private constant CACHE_READ = 2;
    uint256 private constant CACHE_CREATION = 3;
    uint256 private constant CACHE_HIT = 4;
    uint256 private constant PROMPT_CACHED = 5;
    uint256 private constant INPUT_CACHED = 6;
    uint256 private constant INPUT_DETAILS = 7;
    uint256 private constant PROMPT_DETAILS = 8;
    uint256 private constant USAGE_OBJECT = 9;

    /// @dev What one pass over a response found where usage is read.
    /// @param seen The members met, whatever their value. The buyer's JSON parser keeps the last of a repeated
    ///        member, so a second one makes the usage ambiguous.
    /// @param numbers The members whose value is a whole number; null counts as absent, as the buyer reads it.
    /// @param entered Whether the top-level `usage` is an object.
    /// @param ambiguous The buyer's JSON parser could read the usage differently: a repeated member, a member
    ///        name with an escape, or a value that is neither a whole number nor null.
    struct Usage {
        uint256 seen;
        uint256 numbers;
        uint256[7] values;
        bool entered;
        bool ambiguous;
    }

    /// @inheritdoc IAntseedTokenizerUsageReader
    /// @dev The buyer's own reading of usage (`extractUsage` in `packages/api-adapter`): `prompt_tokens` is the
    ///      whole input; so is `input_tokens` when `input_tokens_details` has `cached_tokens` (a subset).
    ///      Otherwise `input_tokens` is fresh only, and the cache creation and the cached input are added: the
    ///      larger of `prompt_tokens_details.cached_tokens` and the cache reads (`cache_read_input_tokens`,
    ///      else `prompt_cache_hit_tokens`).
    function promptTokensOf(bytes calldata responseBody) external pure override returns (bool found, uint256 tokens) {
        Usage memory usage = _readUsage(responseBody);
        if (!usage.entered || usage.ambiguous) return (false, 0);
        if (_has(usage.numbers, PROMPT)) return (true, usage.values[PROMPT]);
        if (!_has(usage.numbers, INPUT)) return (false, 0);
        // `extractUsage` only checks that `cached_tokens` is there, so null counts too.
        if (_has(usage.seen, INPUT_CACHED)) return (true, usage.values[INPUT]);
        uint256 separate = usage.values[_has(usage.numbers, CACHE_READ) ? CACHE_READ : CACHE_HIT];
        uint256 cached = usage.values[PROMPT_CACHED] > separate ? usage.values[PROMPT_CACHED] : separate;
        return (true, usage.values[INPUT] + usage.values[CACHE_CREATION] + cached);
    }

    /// @dev One pass over the JSON `body`, tracking strings and nesting, that reads the usage keys directly
    ///      inside the top-level `usage` object, and `cached_tokens` directly inside its `input_tokens_details`
    ///      and `prompt_tokens_details`, only (other nested breakdowns, e.g. Responses' per-item usage, and text
    ///      that looks like a key are ignored). A member name with an escape at a level it reads (the top
    ///      level, `usage`, a details object) makes the usage ambiguous: it may decode to a key it looks for.
    function _readUsage(bytes calldata body) private pure returns (Usage memory usage) {
        uint256 length = body.length;
        uint256 depth;
        bool inString;
        bool escaped;
        bool watched;
        bool hadEscape;
        bool inUsage;
        // `INPUT_DETAILS` or `PROMPT_DETAILS` inside that object of `usage`; else 0.
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
                    if (watched && hadEscape) {
                        uint256 after_ = _skipSpace(body, i + 1);
                        if (after_ < length && body[after_] == ":") usage.ambiguous = true;
                    }
                }
                continue;
            }
            if (c == "{" || c == "[") {
                depth++;
            } else if (c == "}" || c == "]") {
                if (depth == 2) inUsage = false;
                if (depth == 3) inDetails = 0;
                if (depth != 0) depth--;
            } else if (c == '"') {
                // Where to go on from when a member the reader looks for starts here; else 0.
                uint256 next;
                if (depth == 1) {
                    next = _enterObject(body, i, USAGE, USAGE_OBJECT, usage);
                    if (next != 0) (depth, inUsage, usage.entered) = (2, true, true);
                } else if (depth == 2 && inUsage) {
                    next = _enterObject(body, i, INPUT_TOKENS_DETAILS, INPUT_DETAILS, usage);
                    if (next != 0) {
                        inDetails = INPUT_DETAILS;
                    } else {
                        next = _enterObject(body, i, PROMPT_TOKENS_DETAILS, PROMPT_DETAILS, usage);
                        if (next != 0) inDetails = PROMPT_DETAILS;
                    }
                    if (next != 0) depth = 3;
                    else next = _readUsageKey(body, i, usage);
                } else if (depth == 3 && inDetails != 0) {
                    next = _readNumber(
                        body, i, CACHED_TOKENS, inDetails == INPUT_DETAILS ? INPUT_CACHED : PROMPT_CACHED, usage
                    );
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

    /// @dev Reads the token count starting at `offset` directly inside `usage`, if it is one, and returns the
    ///      offset after its name; 0 otherwise.
    function _readUsageKey(bytes calldata body, uint256 offset, Usage memory usage) private pure returns (uint256 end) {
        end = _readNumber(body, offset, PROMPT_TOKENS, PROMPT, usage);
        if (end == 0) end = _readNumber(body, offset, INPUT_TOKENS, INPUT, usage);
        if (end == 0) end = _readNumber(body, offset, CACHE_READ_TOKENS, CACHE_READ, usage);
        if (end == 0) end = _readNumber(body, offset, CACHE_CREATION_TOKENS, CACHE_CREATION, usage);
        if (end == 0) end = _readNumber(body, offset, CACHE_HIT_TOKENS, CACHE_HIT, usage);
    }

    /// @dev If the member `key` (quotes included) starts at `offset`: marks `slot` seen, keeps its value when it
    ///      is a whole number (1 to 15 digits ending the member: a decimal or exponent is no token count) and
    ///      makes the usage ambiguous when it is anything else but null. Returns the offset after the name; 0
    ///      when `key` is not there.
    function _readNumber(bytes calldata body, uint256 offset, bytes memory key, uint256 slot, Usage memory usage)
        private
        pure
        returns (uint256 end)
    {
        uint256 at = _colonAfterKey(body, offset, key);
        if (at == 0) return 0;
        end = offset + key.length;
        _markSeen(usage, slot);
        uint256 length = body.length;
        at = _skipSpace(body, at);
        bool isNull = at + 4 <= length && bytes4(body[at:at + 4]) == "null";
        uint256 value;
        uint256 digits;
        if (isNull) {
            at += 4;
        } else {
            while (at < length && body[at] >= "0" && body[at] <= "9" && digits <= MAX_TOKEN_DIGITS) {
                value = value * 10 + (uint8(body[at]) - 48);
                digits++;
                at++;
            }
        }
        at = _skipSpace(body, at);
        bool endsMember = at < length && (body[at] == "," || body[at] == "}");
        if (!endsMember || (!isNull && (digits == 0 || digits > MAX_TOKEN_DIGITS))) {
            usage.ambiguous = true;
        } else if (!isNull) {
            usage.numbers |= 1 << slot;
            usage.values[slot] = value;
        }
    }

    /// @dev If the member `key` (quotes included) starts at `offset`: marks `slot` seen and, when its value is
    ///      an object, returns the offset after that `{`. 0 when `key` is not there or its value is no object.
    function _enterObject(bytes calldata body, uint256 offset, bytes memory key, uint256 slot, Usage memory usage)
        private
        pure
        returns (uint256)
    {
        uint256 at = _colonAfterKey(body, offset, key);
        if (at == 0) return 0;
        _markSeen(usage, slot);
        at = _skipSpace(body, at);
        return at < body.length && body[at] == "{" ? at + 1 : 0;
    }

    /// @dev If `key` (quotes included) starts at `offset` followed by a colon, the offset after the colon; else 0.
    function _colonAfterKey(bytes calldata body, uint256 offset, bytes memory key) private pure returns (uint256) {
        uint256 end = offset + key.length;
        // The closing quote is checked first: it tells most other names apart without hashing.
        if (
            end > body.length || body[end - 1] != '"'
                || keccak256(key) != AntseedResponseAuth.hashCalldata(body[offset:end])
        ) return 0;
        end = _skipSpace(body, end);
        return end < body.length && body[end] == ":" ? end + 1 : 0;
    }

    function _markSeen(Usage memory usage, uint256 slot) private pure {
        if (_has(usage.seen, slot)) usage.ambiguous = true;
        usage.seen |= 1 << slot;
    }

    function _has(uint256 slots, uint256 slot) private pure returns (bool) {
        return slots & (1 << slot) != 0;
    }

    /// @dev The first offset at or after `offset` that is not whitespace (`body.length` when none).
    function _skipSpace(bytes calldata body, uint256 offset) private pure returns (uint256) {
        uint256 length = body.length;
        while (offset < length && _isAsciiSpace(body[offset])) offset++;
        return offset;
    }

    function _isAsciiSpace(bytes1 c) private pure returns (bool) {
        return c == " " || c == "\t" || c == "\n" || c == "\r" || c == 0x0b || c == 0x0c;
    }
}
