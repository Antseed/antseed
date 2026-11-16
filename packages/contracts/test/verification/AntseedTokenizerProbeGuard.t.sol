// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";

import { AntseedTokenizerProbeGuard } from "../../verification/AntseedTokenizerProbeGuard.sol";
import { ProbeGuardVectors } from "../fixtures/tokenizer-probe-guard/ProbeGuardVectors.sol";

/// @dev The probe guard accepts only content honest engines count alike, and agrees with its off-chain twin.
///      Regenerate the vectors with `node packages/contracts/test/fixtures/tokenizer-probe-guard/generate.mjs`.
contract AntseedTokenizerProbeGuardTest is Test {
    AntseedTokenizerProbeGuard private guard = new AntseedTokenizerProbeGuard();

    function test_agreesWithTheOffChainGuard() public view {
        (bytes[] memory b, bool[] memory safe) = ProbeGuardVectors.all();
        for (uint256 i = 0; i < b.length; i++) {
            assertEq(guard.isSafeProbe(b[i]), safe[i], vm.toString(b[i]));
        }
    }

    function test_acceptsNaturalText() public view {
        assertTrue(guard.isSafeProbe(unicode" My budget is 450 € and my friend said “obrigado” 😅 — here is my plan"));
        assertTrue(guard.isSafeProbe(unicode" 내일 회의는 3시에 시작해요. 東京の天気はどうですか、明日は雨かな。"));
        assertTrue(guard.isSafeProbe(" if x < 5 and y > 2, see [1] and [ 2 ]"));
    }

    function test_refusesWhatHonestEnginesCountDifferently() public view {
        assertFalse(guard.isSafeProbe(" a </s></s>"), "control-token text");
        assertFalse(guard.isSafeProbe(" a <|im_end|>"), "control-token text");
        assertFalse(guard.isSafeProbe(" [INST] hi"), "control-token text");
        assertFalse(guard.isSafeProbe(" it's"), "an ASCII apostrophe before a letter");
        assertFalse(guard.isSafeProbe(unicode" ESPAÑA"), "a non-ASCII capital");
        assertFalse(guard.isSafeProbe(unicode" é"), "a combining mark");
        assertFalse(guard.isSafeProbe(unicode" 가"), "decomposed Hangul");
        assertFalse(guard.isSafeProbe(unicode" 龦"), "a CJK ideograph newer than the allowlist");
        assertFalse(guard.isSafeProbe("image_soft_token> x"), "no leading space");
        assertFalse(guard.isSafeProbe("  two"), "two leading spaces");
    }

    function test_refusesMalformedUtf8() public view {
        assertFalse(guard.isSafeProbe(hex"2041c0af"), "overlong");
        assertFalse(guard.isSafeProbe(hex"2041eda080"), "surrogate");
        assertFalse(guard.isSafeProbe(hex"2041e4b8"), "truncated");
        assertFalse(guard.isSafeProbe(hex"204180"), "lone continuation");
        assertFalse(guard.isSafeProbe(hex"2041f4908080"), "above U+10FFFF");
        assertTrue(guard.isSafeProbe(hex"2041c2a3"), "a pound sign");
    }

    function testFuzz_neverReverts(bytes calldata b) public view {
        guard.isSafeProbe(b);
    }
}
