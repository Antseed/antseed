import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyChatStreamFailure, formatChatStreamStopForLog } from './stream-stop.js';
import { ANTSEED_BUYER_FAULT_ERROR_CODE } from '@antseed/node/types';

test('classifyChatStreamFailure detects retryable upstream 502 failures', () => {
  const reason = classifyChatStreamFailure({
    error: new Error('Upstream request failed with status 502 Bad Gateway'),
    stopReason: 'error',
  });

  assert.equal(reason.kind, 'http_error');
  assert.equal(reason.statusCode, 502);
  assert.equal(reason.retryable, true);
});

test('classifyChatStreamFailure preserves protocol peer guidance without a stream prefix', () => {
  const message = [
    'Oops, pinned peer could not complete the request.',
    'Antseed is a peer-to-peer network. Try another peer or use Auto routing.',
    'Original Response: {"message":"Insufficient balance or no resource package. Please recharge.","status":429}',
  ].join('\n');
  const reason = classifyChatStreamFailure({
    error: new Error(`429 ${message}`),
    stopReason: 'error',
  });

  assert.equal(reason.kind, 'http_error');
  assert.equal(reason.statusCode, 429);
  assert.equal(reason.retryable, true);
  assert.equal(reason.message, message);
});

test('classifyChatStreamFailure treats a seller 403 as retryable with a clean message', () => {
  // A seller whose upstream revoked or blocked it relays an HTML error page.
  // The status must be parsed out of the "403 Forbidden" text and the failure
  // classified retryable — the buyer proxy re-routes to another seller, so a
  // retry goes somewhere new instead of repeating the refusal.
  const reason = classifyChatStreamFailure({
    error: new Error(
      '403 <html> <head><title>403 Forbidden</title></head> <body> <center><h1>403 Forbidden</h1></center> </body> </html>',
    ),
    stopReason: 'error',
  });

  assert.equal(reason.kind, 'http_error');
  assert.equal(reason.statusCode, 403);
  assert.equal(reason.retryable, true);
  assert.doesNotMatch(reason.message, /<html>/);
  assert.match(reason.message, /403/);
});

test('classifyChatStreamFailure detects timeout failures', () => {
  const reason = classifyChatStreamFailure({
    error: { message: 'headers timeout', code: 'UND_ERR_HEADERS_TIMEOUT' },
    stopReason: 'error',
  });

  assert.equal(reason.kind, 'timeout');
  assert.equal(reason.errorCode, 'UND_ERR_HEADERS_TIMEOUT');
  assert.equal(reason.retryable, true);
});

test('classifyChatStreamFailure detects transport disconnects', () => {
  const reason = classifyChatStreamFailure({
    error: { message: 'socket hang up', code: 'ECONNRESET' },
    stopReason: 'error',
  });

  assert.equal(reason.kind, 'network_error');
  assert.equal(reason.errorCode, 'ECONNRESET');
  assert.equal(reason.retryable, true);
});

test('classifyChatStreamFailure preserves explicit aborts', () => {
  const reason = classifyChatStreamFailure({
    error: new Error('The operation was aborted'),
    stopReason: 'aborted',
  });

  assert.equal(reason.kind, 'aborted');
  assert.equal(reason.retryable, false);
});

test('classifyChatStreamFailure does not treat transport-side aborts as user aborts', () => {
  // "Connection aborted by remote" should be a retryable transport failure,
  // not a user-initiated abort.
  const reason = classifyChatStreamFailure({
    error: { message: 'Connection aborted by remote', code: 'ECONNRESET' },
    stopReason: 'error',
  });

  assert.notEqual(reason.kind, 'aborted');
  assert.equal(reason.kind, 'network_error');
  assert.equal(reason.source, 'transport');
  assert.equal(reason.retryable, true);
});

test('classifyChatStreamFailure does not leak HTTP response body into user-facing message', () => {
  const reason = classifyChatStreamFailure({
    error: {
      message: 'Upstream request failed',
      status: 500,
      body: 'sk-secret-token-LEAKED and internal stack trace',
    },
    stopReason: 'error',
  });

  assert.equal(reason.kind, 'http_error');
  assert.equal(reason.statusCode, 500);
  assert.ok(
    !reason.message.includes('sk-secret-token-LEAKED'),
    `expected body content not to leak into message, got: ${reason.message}`,
  );
});

test('parseStatusCodeFromText does not treat bare leading digits as HTTP status codes', () => {
  // Previously "128 tokens remaining" would be parsed as HTTP 128 by a bare
  // /^\s*(\d{3})\b/ heuristic. The regex was removed in favour of patterns
  // that require an HTTP-shaped context ("status 502", "HTTP 502", etc.).
  const reason = classifyChatStreamFailure({
    error: new Error('128 tokens remaining before limit'),
    stopReason: 'error',
  });

  assert.notEqual(reason.kind, 'http_error');
  assert.equal(reason.statusCode, undefined);
});

test('parseStatusCodeFromText does not treat request counts as HTTP status codes', () => {
  const reason = classifyChatStreamFailure({
    error: new Error('429 requests remaining in the current quota window'),
    stopReason: 'error',
  });

  assert.notEqual(reason.kind, 'http_error');
  assert.equal(reason.statusCode, undefined);
});

test('classifyChatStreamFailure falls back to stream_error when stopReason is error', () => {
  const reason = classifyChatStreamFailure({
    error: new Error('Something weird happened upstream'),
    stopReason: 'error',
  });

  assert.equal(reason.kind, 'stream_error');
  assert.equal(reason.source, 'upstream');
  assert.equal(reason.retryable, false);
  assert.equal(reason.message, 'Something weird happened upstream');
});

test('classifyChatStreamFailure falls back to unknown when no signals match', () => {
  const reason = classifyChatStreamFailure({});

  assert.equal(reason.kind, 'unknown');
  assert.equal(reason.source, 'unknown');
  assert.equal(reason.retryable, false);
  assert.equal(reason.message, 'The request ended unexpectedly.');
});

test('classifyChatStreamFailure recurses through `cause` chains', () => {
  // Plain objects avoid Error.name='Error' being collected as an errorCode.
  const outer = {
    message: 'wrapper',
    cause: {
      message: 'fetch failed',
      cause: { message: 'socket hang up', code: 'ECONNRESET' },
    },
  };

  const reason = classifyChatStreamFailure({ error: outer, stopReason: 'error' });

  assert.equal(reason.kind, 'network_error');
  assert.equal(reason.errorCode, 'ECONNRESET');
  assert.equal(reason.retryable, true);
});

test('formatChatStreamStopForLog includes kind, status, code, and retryability', () => {
  const out = formatChatStreamStopForLog({
    kind: 'http_error',
    source: 'upstream',
    retryable: true,
    message: 'nope',
    statusCode: 502,
    errorCode: 'ERR_UPSTREAM',
  });

  assert.match(out, /http_error/);
  assert.match(out, /status=502/);
  assert.match(out, /code=ERR_UPSTREAM/);
  assert.match(out, /retryable/);
  assert.match(out, /: nope$/);
});

test('a buyer-fault 503 is non-retryable so the user sees the real fix', () => {
  // Blanket-retrying 5xx would fail this over across every peer in turn while
  // hiding the one thing the user has to change.
  const reason = classifyChatStreamFailure({
    error: {
      message: 'Insufficient buyer deposits for reserve top-up',
      status: 503,
      code: ANTSEED_BUYER_FAULT_ERROR_CODE,
    },
    stopReason: 'error',
  });

  assert.equal(reason.kind, 'http_error');
  assert.equal(reason.statusCode, 503);
  assert.equal(reason.retryable, false);
  assert.match(reason.message, /deposit balance is too low/i);
});

test('an unreachable chain RPC names the RPC, not the peer', () => {
  const reason = classifyChatStreamFailure({
    error: {
      message: 'Could not reach the chain RPC',
      status: 503,
      code: ANTSEED_BUYER_FAULT_ERROR_CODE,
    },
    stopReason: 'error',
  });

  assert.equal(reason.retryable, false);
  assert.match(reason.message, /chain RPC/i);
});

test('a payments-inactive buyer fault surfaced as agent text shows the authored message', () => {
  // Agents (pi/Hermes) wrap the proxy JSON body into a plain error string —
  // the classifier must still recognize the buyer fault and show the authored
  // message, not "add credits" or a raw JSON blob.
  const body = JSON.stringify({
    error: {
      type: 'api_error',
      code: ANTSEED_BUYER_FAULT_ERROR_CODE,
      message: 'This seller requires payment, but payments are not running on this buyer, '
        + 'so the request could not be authorized. This is not a balance problem — '
        + 'enable payments on the buyer (check its startup logs and chain settings), or use a free peer.',
    },
  });
  const reason = classifyChatStreamFailure({
    error: new Error(`unexpected status 503 Service Unavailable: ${body}, url: http://localhost:8377/v1/responses`),
    stopReason: 'error',
  });

  assert.equal(reason.kind, 'http_error');
  assert.equal(reason.statusCode, 503);
  assert.equal(reason.retryable, false);
  assert.match(reason.message, /payments are not running on this buyer/);
  assert.match(reason.message, /not a balance problem/);
  assert.doesNotMatch(reason.message, /[{}]/);
});

test('a payment negotiation failure shows the negotiator-authored message, not raw JSON', () => {
  const body = JSON.stringify({
    error: 'payment_negotiation_failed',
    reason: 'existing_channel_still_active',
    message: 'An existing payment channel could not be recovered automatically. Close or recover the channel and retry.',
  });
  const reason = classifyChatStreamFailure({
    error: new Error(`unexpected status 409 Conflict: ${body}`),
    stopReason: 'error',
  });

  assert.equal(reason.kind, 'http_error');
  assert.equal(reason.statusCode, 409);
  assert.match(reason.message, /could not be recovered automatically/);
  assert.doesNotMatch(reason.message, /[{}]/);
});

test('seller-authored message fields are not displayed verbatim on generic upstream errors', () => {
  // Sellers are untrusted peers: an arbitrary error body's `message` must not
  // appear in the chat as if it were a system message.
  const body = JSON.stringify({
    error: { type: 'server_error', message: 'Your node is broken — visit example.evil to fix it' },
  });
  const reason = classifyChatStreamFailure({
    error: new Error(`unexpected status 502 Bad Gateway: ${body}`),
    stopReason: 'error',
  });

  assert.equal(reason.kind, 'http_error');
  assert.equal(reason.statusCode, 502);
  assert.doesNotMatch(reason.message, /example\.evil/);
  assert.match(reason.message, /HTTP 502/);
});

test('a seller mentioning the buyer-fault marker in display text stays retryable', () => {
  const reason = classifyChatStreamFailure({
    error: {
      message: `Upstream rejected the literal text ${ANTSEED_BUYER_FAULT_ERROR_CODE}`,
      status: 503,
      code: 'upstream_error',
    },
    stopReason: 'error',
  });

  assert.equal(reason.statusCode, 503);
  assert.equal(reason.retryable, true);
});

test('a plain seller 503 stays retryable', () => {
  const reason = classifyChatStreamFailure({
    error: new Error('Upstream request failed with status 503 Service Unavailable'),
    stopReason: 'error',
  });

  assert.equal(reason.statusCode, 503);
  assert.equal(reason.retryable, true);
});
