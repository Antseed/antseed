import { describe, it, expect } from 'vitest';
import { isSafeProbe } from './tokenizer-probe-guard.js';

const bytes = (...values: number[]) => Uint8Array.from(values);

describe('isSafeProbe', () => {
  it('accepts natural text in the allowed scripts', () => {
    expect(isSafeProbe(' My budget is 450 € and my friend said “obrigado” 😅 — here is my plan: `trip.days = 9`')).toBe(true);
    expect(isSafeProbe(' 내일 회의는 3시에 시작해요. 東京の天気はどうですか、明日は雨かな。')).toBe(true);
    expect(isSafeProbe(' Also, the cron job runs at 03:15 and logs go to /var/log/backup.log 🙂 if x < 5 and y > 2')).toBe(true);
    expect(isSafeProbe(' שלום, מה שלומך? привет, как дела? españa, ¿qué tal? γεια σου')).toBe(false); // ¿ is not allowed
    expect(isSafeProbe(' שלום מה שלומך, привет как дела, españa, γεια σου')).toBe(true);
  });

  it('needs exactly one leading space', () => {
    expect(isSafeProbe('No space')).toBe(false);
    expect(isSafeProbe('  Two spaces')).toBe(false);
    expect(isSafeProbe(' ')).toBe(false);
    // A could end in `<` and B complete a control token without the space.
    expect(isSafeProbe('image_soft_token> more')).toBe(false);
  });

  it('refuses ASCII sequences that can open a control token', () => {
    for (const b of [' a </s>', ' a <|im_end|>', ' a <_x', ' a <!x', ' a <s>', ' [INST] hi', ' a [/INST]', " it's", ' a <', ' a [', " a '"]) {
      expect(isSafeProbe(b), b).toBe(false);
    }
    for (const b of [' 3<4', ' a < 5', ' [1] and [ x', " a ' b", ' don’t']) expect(isSafeProbe(b), b).toBe(true);
  });

  it('refuses the divergent classes: capitals, decomposed or combined text, new code points', () => {
    expect(isSafeProbe(' ESPAÑA')).toBe(false);
    expect(isSafeProbe(' Ελλάδα')).toBe(false);
    expect(isSafeProbe(' e\u0301')).toBe(false);
    expect(isSafeProbe(' \u1100\u1161')).toBe(false); // NFD Hangul jamo
    expect(isSafeProbe(' 가')).toBe(true);
    expect(isSafeProbe(' \u9fa5')).toBe(true);
    expect(isSafeProbe(' \u9fa6')).toBe(false);
    expect(isSafeProbe(' 👍\u{1f3fb}')).toBe(false); // skin tone
    expect(isSafeProbe(' ❤\ufe0f')).toBe(false); // VS16
    expect(isSafeProbe(' 👨\u200d👩')).toBe(false); // ZWJ
  });

  it('refuses control characters and malformed UTF-8', () => {
    expect(isSafeProbe(bytes(0x20, 0x41, 0x09))).toBe(false);
    expect(isSafeProbe(bytes(0x20, 0x41, 0xc0, 0xaf))).toBe(false); // overlong
    expect(isSafeProbe(bytes(0x20, 0x41, 0xe0, 0x82, 0xa3))).toBe(false); // overlong £
    expect(isSafeProbe(bytes(0x20, 0x41, 0xed, 0xa0, 0x80))).toBe(false); // surrogate
    expect(isSafeProbe(bytes(0x20, 0x41, 0xe4, 0xb8))).toBe(false); // truncated
    expect(isSafeProbe(bytes(0x20, 0x41, 0x80))).toBe(false); // lone continuation
    expect(isSafeProbe(bytes(0x20, 0x41, 0xf4, 0x90, 0x80, 0x80))).toBe(false); // above U+10FFFF
    expect(isSafeProbe(bytes(0x20, 0x41, 0xc2, 0xa3))).toBe(true); // £
  });
});
