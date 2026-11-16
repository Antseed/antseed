// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Decides which probe content B a tokenizer proof may measure. B is the part every seller counts, and
///         whoever writes it chooses what is compared: honest engines serving one model (llama.cpp, Hugging
///         Face tokenizers, harmony, tekken) count control-token text, unnormalized Unicode, non-ASCII capitals
///         or recently assigned code points differently, so a chosen B could make honest sellers disagree. A
///         guard accepts only content they all count alike. A is not checked: it is in both requests, so any
///         difference in it cancels. The tokenizer audit's owner can replace the guard as validated ranges grow.
interface IAntseedTokenizerProbeGuard {
    /// @notice True when every honest engine of the audited model families counts `b` alike.
    function isSafeProbe(bytes calldata b) external view returns (bool);
}
