// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Reads usage from a signed response body exactly as the buyer does, so a tokenizer proof measures what
///         a seller is paid on.
interface IAntseedTokenizerUsageReader {
    /// @notice The prompt tokens a signed response body reports, read as the buyer reads usage: Chat Completions
    ///         `prompt_tokens`; Responses `input_tokens` (with `input_tokens_details`, whose cached tokens it
    ///         includes); else `input_tokens` plus cache creation and cache reads (`cache_read_input_tokens`, else
    ///         `prompt_cache_hit_tokens`). `found` is false when the body has no single usage field, or when the
    ///         buyer's JSON parser could read it differently (an escaped member name, a value that is neither a
    ///         whole number nor null).
    function promptTokensOf(bytes calldata responseBody) external pure returns (bool found, uint256 tokens);
}
