import assert from 'node:assert/strict';
import {test} from 'node:test';
import {newCode, sourceOf} from './waitlist.ts';

test('invite codes start with a letter, so the sheet keeps them as text', () => {
  for (let i = 0; i < 5000; i++) {
    const code = newCode();
    assert.match(code, /^[a-z][a-z2-9]{5}$/);
    assert.ok(Number.isNaN(Number(code)), code);
  }
});

test('the invite link wins over utm_source and the referring site', () => {
  assert.equal(sourceOf('?ref=abc234&utm_source=x', 'https://t.co/1'), 'abc234');
  assert.equal(sourceOf('?utm_source=newsletter', 'https://t.co/1'), 'newsletter');
  assert.equal(sourceOf('', 'https://t.co/1'), 't.co');
  assert.equal(sourceOf('', ''), 'direct');
});
