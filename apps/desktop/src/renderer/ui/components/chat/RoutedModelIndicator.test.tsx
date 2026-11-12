import assert from 'node:assert/strict';
import { test } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { RoutedModelIndicator, replyModelLabel } from './RoutedModelIndicator';

test('an assistant reply names the model id it came from', () => {
  const reply = { role: 'assistant', content: 'Reply', meta: { service: 'glm-5.3-flash' } };
  assert.equal(replyModelLabel(reply), 'glm-5.3-flash');
  assert.match(renderToStaticMarkup(<RoutedModelIndicator message={reply} />), />glm-5.3-flash</);
});

test('nothing is shown for user messages or replies without a model', () => {
  assert.equal(replyModelLabel({ role: 'user', content: 'Hi', meta: { service: 'glm-5.3-flash' } }), null);
  assert.equal(replyModelLabel({ role: 'assistant', content: 'Reply' }), null);
  assert.equal(renderToStaticMarkup(<RoutedModelIndicator message={{ role: 'assistant', content: '', meta: { service: ' ' } }} />), '');
});

test('names the seller next to the model, even for a pinned model', () => {
  const reply = { role: 'assistant', content: [], meta: { service: 'cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34@glm-5.3-flash', peerId: 'cd34ef565fa2', peerName: 'Example Seller' } };
  assert.equal(replyModelLabel(reply), 'glm-5.3-flash · Example Seller');
  assert.equal(replyModelLabel({ ...reply, meta: { service: 'glm-5.3-flash', peerId: 'cd34ef565fa2' } }), 'glm-5.3-flash · cd34ef56');
});
