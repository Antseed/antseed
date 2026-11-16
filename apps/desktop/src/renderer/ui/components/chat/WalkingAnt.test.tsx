import assert from 'node:assert/strict';
import { test } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  antLine,
  formatElapsed,
  PHRASE_EVERY_MS,
  SHOW_TIMER_AFTER_MS,
  SLOW_AFTER_MS,
  SLOW_MESSAGE,
  WalkingAnt,
} from './WalkingAnt';
import { pickThinkingPhrase, THINKING_PHRASES } from './thinking-phrases';

test('the ant has the original lines and at least 30 new ones, each short and unique', () => {
  assert.ok(THINKING_PHRASES.length >= 50, `only ${THINKING_PHRASES.length} lines`);
  assert.equal(new Set(THINKING_PHRASES).size, THINKING_PHRASES.length, 'a line is listed twice');
  for (const phrase of ['Hodl', 'Wen channel', 'Foraging for tokens', 'Sharding the prompt']) {
    assert.ok(THINKING_PHRASES.includes(phrase), `lost the original "${phrase}"`);
  }
  for (const phrase of THINKING_PHRASES) {
    assert.ok(phrase.length > 0 && phrase.length <= 34, `"${phrase}" is too long for one line`);
    assert.doesNotMatch(phrase, /[.…]$/, `"${phrase}" carries its own ellipsis; the ant adds it`);
  }
});

test('a re-roll never repeats the line on screen', () => {
  let call = 0;
  // The first two picks land on the current line; the third does not.
  const random = () => (call++ < 2 ? 0 : 0.5);
  const next = pickThinkingPhrase(THINKING_PHRASES[0], random);
  assert.notEqual(next, THINKING_PHRASES[0]);
});

test('the ant shows a meme but screen readers hear only "Thinking"', () => {
  const markup = renderToStaticMarkup(<WalkingAnt initialPhrase="Planting seeds" />);
  assert.match(markup, /<svg/);
  assert.match(markup, /role="status"[^>]*>Thinking\.\.\.</);
  assert.match(markup, /aria-hidden="true"[^>]*>Planting seeds\.\.\./);
  assert.doesNotMatch(markup, /role="status"[^>]*>Planting seeds/);
});

test('a real step of the request replaces the meme and is announced', () => {
  const markup = renderToStaticMarkup(
    <WalkingAnt initialPhrase="Planting seeds" phaseLabel="Signing SpendingAuth" />,
  );
  assert.match(markup, /role="status"[^>]*>Signing SpendingAuth\.\.\.</);
  assert.doesNotMatch(markup, /Planting seeds/);
});

test('the timer counts from when the request started, as before', () => {
  const fresh = renderToStaticMarkup(<WalkingAnt initialPhrase="Planting seeds" startedAt={Date.now() - 12_400} />);
  assert.match(fresh, />Planting seeds\.\.\.(<!-- -->)? · 12s</);

  const quick = renderToStaticMarkup(<WalkingAnt initialPhrase="Planting seeds" startedAt={Date.now() - 500} />);
  assert.doesNotMatch(quick, / · \d/, 'no timer in the first two seconds');
});

test('after 30 seconds the ant says the provider is slow, also to screen readers', () => {
  const markup = renderToStaticMarkup(<WalkingAnt initialPhrase="Planting seeds" startedAt={Date.now() - 31_000} />);
  assert.ok(markup.includes(`role="status">${SLOW_MESSAGE}<`), markup);
  assert.doesNotMatch(markup, /Planting seeds/);
});

test('the elapsed timer reads seconds, then minutes', () => {
  assert.equal(formatElapsed(2_400), '2s');
  assert.equal(formatElapsed(59_999), '59s');
  assert.equal(formatElapsed(75_000), '1:15');
});

test('the old timings stay: a new line every 5 s, the timer from 2 s', () => {
  assert.equal(PHRASE_EVERY_MS, 5_000);
  assert.equal(SHOW_TIMER_AFTER_MS, 2_000);
  assert.equal(SLOW_AFTER_MS, 30_000);
});

test('the line at each boundary: no timer, timer, slow note', () => {
  assert.deepEqual(antLine({ elapsedMs: 1_999, phrase: 'gm' }), { slow: false, shown: 'gm...', spoken: 'Thinking...', timer: '' });
  assert.deepEqual(antLine({ elapsedMs: 2_000, phrase: 'gm' }), { slow: false, shown: 'gm...', spoken: 'Thinking...', timer: ' · 2s' });
  assert.deepEqual(antLine({ elapsedMs: 29_999, phaseLabel: 'Dialing peer', phrase: 'gm' }), { slow: false, shown: 'Dialing peer...', spoken: 'Dialing peer...', timer: ' · 29s' });
  assert.deepEqual(antLine({ elapsedMs: 30_000, phaseLabel: 'Dialing peer', phrase: 'gm' }), { slow: true, shown: SLOW_MESSAGE, spoken: SLOW_MESSAGE, timer: ' · 30s' });
});

test('only the slow note may wrap; the short lines stay on one line as before', () => {
  const meme = renderToStaticMarkup(<WalkingAnt initialPhrase="gm" startedAt={Date.now()} />);
  const slow = renderToStaticMarkup(<WalkingAnt initialPhrase="gm" startedAt={Date.now() - 31_000} />);
  assert.doesNotMatch(meme, /timer-wrap|timerWrap/);
  assert.match(slow, /timer-wrap|timerWrap/);
});
