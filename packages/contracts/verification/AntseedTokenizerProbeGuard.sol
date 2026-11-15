// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IAntseedTokenizerProbeGuard } from "../interfaces/IAntseedTokenizerProbeGuard.sol";

/// @notice An allowlist guard for tokenizer probe content B. B is accepted when:
///         - it starts with exactly one space, so it can't complete a control token A ends with;
///         - it is valid, shortest-form UTF-8;
///         - every code point is printable ASCII or in `RANGES`: a few Latin-1 symbols and lowercase letters;
///           Greek, Cyrillic and Armenian lowercase; Hebrew and Arabic letters without marks; Georgian; Ethiopic
///           syllables; common typographic punctuation and the euro sign; CJK punctuation, kana, CJK ideographs
///           and Hangul syllables; emoji without skin tones. Nothing in it is a combining mark, a non-ASCII
///           capital, changes under NFC, or was assigned after Unicode 8;
///         - no ASCII sequence can open a control token: `<` followed by `|`, `/`, `_`, `!` or a letter; `[`
///           followed by `/` or a letter; `'` followed by a letter; and B does not end with `<`, `[` or `'`.
///         It fails closed: content outside it can't be proven either way, but can't frame an honest seller.
/// @dev Off-chain twin: `isSafeProbe` in `packages/node/src/payments/evm/tokenizer-probe-guard.ts`; the shared
///      vectors in `test/fixtures/tokenizer-probe-guard` check both against each other.
contract AntseedTokenizerProbeGuard is IAntseedTokenizerProbeGuard {
    /// @dev Sorted, disjoint, inclusive code point ranges above ASCII: 3-byte start, 3-byte end.
    bytes private constant RANGES =
        hex"0000a30000a30000a50000a50000a70000a70000a90000a90000b00000b10000d70000d70000df0000ff0003b10003c900043000044f0004510004510005610005860005d00005ea00062100063a00064100064a0010d00010fa00120000124800201300201400201800201900201c00201d0020220020220020260020260020ac0020ac00300100300200300c00300d0030410030960030a10030fa0030fc0030fc004e00009fa500ac0000d7a301f30001f3fa01f40001f64f01f68001f6c5";

    /// @inheritdoc IAntseedTokenizerProbeGuard
    function isSafeProbe(bytes calldata b) external pure returns (bool) {
        uint256 length = b.length;
        if (length < 2 || b[0] != " " || b[1] == " ") return false;
        bytes memory ranges = RANGES;
        uint256 i = 0;
        while (i < length) {
            uint8 c = uint8(b[i]);
            if (c < 0x80) {
                if (c < 0x20 || c == 0x7f || _opensControlToken(c, i + 1 < length ? uint8(b[i + 1]) : 0)) return false;
                i++;
                continue;
            }
            (bool ok, uint256 codePoint, uint256 size) = _decode(b, i);
            if (!ok || !_inRanges(ranges, codePoint)) return false;
            i += size;
        }
        return true;
    }

    /// @dev `next` is 0 at the end of B.
    function _opensControlToken(uint8 c, uint8 next) private pure returns (bool) {
        bool letter = (next >= 0x41 && next <= 0x5a) || (next >= 0x61 && next <= 0x7a);
        if (c == 0x3c) return next == 0 || letter || next == 0x7c || next == 0x2f || next == 0x5f || next == 0x21; // <
        if (c == 0x5b) return next == 0 || letter || next == 0x2f; // [
        if (c == 0x27) return next == 0 || letter; // '
        return false;
    }

    /// @dev A multi-byte UTF-8 sequence at `i`: rejects bad lead or continuation bytes, truncation and
    ///      overlong forms. Surrogates and code points above U+10FFFF are outside `RANGES`.
    function _decode(bytes calldata b, uint256 i) private pure returns (bool, uint256 codePoint, uint256 size) {
        uint8 lead = uint8(b[i]);
        uint256 min;
        if (lead & 0xe0 == 0xc0) (size, codePoint, min) = (2, lead & 0x1f, 0x80);
        else if (lead & 0xf0 == 0xe0) (size, codePoint, min) = (3, lead & 0x0f, 0x800);
        else if (lead & 0xf8 == 0xf0) (size, codePoint, min) = (4, lead & 0x07, 0x10000);
        else return (false, 0, 0);
        if (i + size > b.length) return (false, 0, 0);
        for (uint256 k = 1; k < size; k++) {
            uint8 next = uint8(b[i + k]);
            if (next & 0xc0 != 0x80) return (false, 0, 0);
            codePoint = (codePoint << 6) | (next & 0x3f);
        }
        return (codePoint >= min, codePoint, size);
    }

    function _inRanges(bytes memory ranges, uint256 codePoint) private pure returns (bool) {
        uint256 low = 0;
        uint256 high = ranges.length / 6;
        while (low < high) {
            uint256 mid = (low + high) / 2;
            uint256 offset = mid * 6;
            if (codePoint < _u24(ranges, offset)) high = mid;
            else if (codePoint > _u24(ranges, offset + 3)) low = mid + 1;
            else return true;
        }
        return false;
    }

    function _u24(bytes memory data, uint256 offset) private pure returns (uint256) {
        return (uint256(uint8(data[offset])) << 16) | (uint256(uint8(data[offset + 1])) << 8) | uint8(data[offset + 2]);
    }
}
