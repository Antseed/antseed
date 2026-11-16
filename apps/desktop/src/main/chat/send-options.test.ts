import assert from 'node:assert/strict';
import test from 'node:test';
import type { OutgoingPrivacy } from '../../shared/chat-gateway-types.js';
import { runEventEmitter, sendStreamHandler, sendTagOf, streamOptionsFrom } from './send-options.js';

test('the send-stream handler hands the run the renderer\'s sendId, so its terminal events carry it back', async () => {
  const seen: OutgoingPrivacy[] = [];
  const handler = sendStreamHandler(async (_conversationId, _message, _model, _attachments, _mode, options) => {
    seen.push(options);
    // What streaming-run tags its done and abort events with.
    return sendTagOf(options);
  });
  const tag = await handler({}, 'conv-1', 'hi', 'model-a', undefined, 'manual', { requirePrivate: true, sendId: 7 });
  assert.deepEqual(seen, [{ requirePrivate: true, allowPrivateHistory: false, sendId: 7 }]);
  assert.deepEqual(tag, { sendId: 7 });
});

test('stream options read from IPC keep only well-formed values', () => {
  assert.deepEqual(streamOptionsFrom(undefined), { requirePrivate: false, allowPrivateHistory: false });
  assert.deepEqual(streamOptionsFrom({ sendId: '7', requirePrivate: 'yes' }), { requirePrivate: false, allowPrivateHistory: false });
  assert.deepEqual(streamOptionsFrom({ sendId: 1.5 }), { requirePrivate: false, allowPrivateHistory: false });
  assert.deepEqual(streamOptionsFrom({ allowPrivateHistory: true, sendId: 3 }), { requirePrivate: false, allowPrivateHistory: true, sendId: 3 });
  assert.deepEqual(sendTagOf({}), {});
});

test('every reply event of a run names its send, as the IPC handler received it', async () => {
  const sent: Array<{ channel: string; payload: unknown }> = [];
  const handler = sendStreamHandler(async (conversationId, _message, _model, _attachments, _mode, options) => {
    const emit = runEventEmitter((channel, payload) => sent.push({ channel, payload }), options);
    emit('chat:ai-stream-start', { conversationId, turn: 0 });
    emit('chat:ai-stream-delta', { conversationId, index: 0, blockType: 'text', text: 'hi' });
    emit('chat:ai-tool-result', { conversationId, toolUseId: 't1', output: 'ok', isError: false });
    return { ok: true };
  });
  await handler(null, 'conv-a', 'hello', undefined, undefined, undefined, { sendId: 7 });
  assert.deepEqual(sent.map(({ payload }) => (payload as { sendId?: number }).sendId), [7, 7, 7]);

  // A send without an id (an older renderer) emits untagged events, which are always taken.
  sent.length = 0;
  await handler(null, 'conv-a', 'hello', undefined, undefined, undefined, {});
  assert.ok(sent.every(({ payload }) => !('sendId' in (payload as object))));
});
