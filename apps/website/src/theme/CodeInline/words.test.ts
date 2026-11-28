import {test} from 'node:test';
import assert from 'node:assert/strict';
import {softParts, KEEP_WHOLE_MAX, words} from './words.ts';

test('a chip keeps each word whole and breaks only at its spaces', () => {
  assert.deepEqual(words('antseed --no-buyer'), [
    {text: 'antseed', whole: true, parts: ['antseed']},
    {text: ' ', whole: false, parts: [' ']},
    {text: '--no-buyer', whole: true, parts: ['--no-buyer']},
  ]);
});

test('a whole word may break after its punctuation, never at a hyphen', () => {
  assert.deepEqual(words('seller.maxConcurrentBuyers')[0].parts, ['seller.', 'maxConcurrentBuyers']);
  assert.deepEqual(words('ANTSEED_PASSPHRASE_FILE')[0].parts, ['ANTSEED_', 'PASSPHRASE_', 'FILE']);
  assert.deepEqual(words('--data-dir=~/.antseed/')[0].parts, ['--data-dir=', '~/', '.', 'antseed/']);
});

test('a word too long for a phone column is left free to wrap, after its punctuation first', () => {
  const long = 'x'.repeat(KEEP_WHOLE_MAX + 1);
  assert.deepEqual(words(long), [{text: long, whole: false, parts: [long]}]);
  assert.deepEqual(words('seller.maxInboundConnectionsPerIp')[0], {text: 'seller.maxInboundConnectionsPerIp', whole: false, parts: ['seller.', 'maxInboundConnectionsPerIp']});
});

test('the words and their parts put back together give the chip unchanged', () => {
  for (const chip of [' <data-dir>/verifier  --epoch <n> ', 'http://localhost:8377/v1', 'a.b_c/d:e=f.']) {
    assert.equal(words(chip).map((p) => p.text).join(''), chip);
    assert.equal(words(chip).flatMap((p) => p.parts).join(''), chip);
  }
});

test('a part splits into its camelCase and hyphenated words, never in a leading --, and puts back together unchanged', () => {
  assert.deepEqual(softParts('--disable-metadata-v2-services'), ['--disable-', 'metadata-', 'v2-', 'services']);
  assert.deepEqual(softParts('maxInboundConnectionsPerIp'), ['max', 'Inbound', 'Connections', 'Per', 'Ip']);
  assert.deepEqual(softParts('ANTSEED_'), ['ANTSEED_']);
  assert.equal(softParts('inboundIdleTimeoutMs').join(''), 'inboundIdleTimeoutMs');
});
