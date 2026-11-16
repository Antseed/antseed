import assert from 'node:assert/strict';
import { test } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { formatElapsed, WalkingAnt } from './WalkingAnt';
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
  assert.match(markup, /role="status"[^>]*>Thinking…</);
  assert.match(markup, /aria-hidden="true"[^>]*>Planting seeds…/);
  assert.doesNotMatch(markup, /role="status"[^>]*>Planting seeds/);
});

test('a real step of the request replaces the meme and is announced', () => {
  const markup = renderToStaticMarkup(
    <WalkingAnt initialPhrase="Planting seeds" phaseLabel="Signing SpendingAuth" />,
  );
  assert.match(markup, /role="status"[^>]*>Signing SpendingAuth…</);
  assert.doesNotMatch(markup, /Planting seeds/);
});

test('a step that already ends in an ellipsis gets no second one', () => {
  const markup = renderToStaticMarkup(<WalkingAnt phaseLabel="Switching to Private…" />);
  assert.doesNotMatch(markup, /……/);
});

test('the elapsed timer reads seconds, then minutes', () => {
  assert.equal(formatElapsed(2_400), '2s');
  assert.equal(formatElapsed(59_999), '59s');
  assert.equal(formatElapsed(75_000), '1:15');
});
