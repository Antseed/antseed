import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyFailureReason, failureHttpStatus, leadingHttpStatus, type FailureSignal } from './failure.js';

// Real error strings seen from the buyer proxy and agent SDKs.
const OUT_OF_CREDITS = '402 You are out of AntSeed credits for this request. Add funds in the AntSeed app, or run "antseed buyer deposit <amount>" from the CLI, then retry.';
const INSUFFICIENT_DEPOSITS = '402 {"error":"payment_required","code":"insufficient_deposits","message":"Deposit more USDC"}';
const PINNED_UNREACHABLE = '502 Pinned peer 1d90f467689d... is not reachable right now. It may be offline, not announcing, or temporarily unreachable.';
const P2P_FAILED = '502 P2P request failed: Connection to 1d90f467 failed';
const OOPS_502 = '502 Oops, peer could not complete the request.';
const MODEL_NOT_FOUND = '502 {"error":{"type":"model_not_found","message":"No policy-allowed peer currently serves model claude-x"}}';
const PAYMENTS_INACTIVE = '503 {"error":{"type":"buyer_request_failed","code":"payments_inactive","message":"Payments are not active"}}';

const CTX = { hadPartialOutput: false, peersDiscoveredAtSend: true, freeSellersKnown: 1, buyerBalanceZero: false };
const ERR: FailureSignal = { kind: 'unknown' };

function reason(message: string, ctx: Partial<typeof CTX> = {}) {
  return classifyFailureReason(ERR, message, { ...CTX, ...ctx });
}

test('classifies the real buyer-proxy error strings', () => {
  assert.equal(reason(OUT_OF_CREDITS), 'out_of_credits');
  assert.equal(reason(OUT_OF_CREDITS, { buyerBalanceZero: true, freeSellersKnown: 0 }), 'model_needs_paid');
  assert.equal(reason(INSUFFICIENT_DEPOSITS), 'out_of_credits');
  assert.equal(reason(PINNED_UNREACHABLE), 'seller_unreachable');
  assert.equal(reason(P2P_FAILED), 'seller_unreachable');
  assert.equal(reason(OOPS_502), 'seller_5xx');
  assert.equal(reason(MODEL_NOT_FOUND), 'no_seller_available');
  assert.equal(reason(MODEL_NOT_FOUND, { peersDiscoveredAtSend: false }), 'no_seller_yet');
  assert.equal(reason(PAYMENTS_INACTIVE), 'local_error');
  assert.equal(reason('Connection error.'), 'seller_dropped_before_output');
  assert.equal(reason('terminated', { hadPartialOutput: true }), 'seller_dropped_mid_answer');
  assert.equal(reason('Request timed out.'), 'timeout');
  assert.equal(reason('504 Gateway Timeout'), 'timeout');
  assert.equal(classifyFailureReason({ kind: 'aborted' }, '', CTX), 'none');
  assert.equal(classifyFailureReason({ kind: 'http_error', statusCode: 429 }, '', CTX), 'rate_limited');
  assert.equal(classifyFailureReason({ kind: 'http_error', statusCode: 400 }, '', CTX), 'request_rejected');
  assert.equal(classifyFailureReason({ kind: 'http_error' }, 'odd', CTX), 'unknown');
});

test('reads only a leading status, not prose', () => {
  assert.equal(leadingHttpStatus(OUT_OF_CREDITS), 402);
  assert.equal(leadingHttpStatus('503 {"x":1}'), 503);
  assert.equal(leadingHttpStatus('stream failed: 400 data: {"a":1}'), 400);
  assert.equal(leadingHttpStatus('429 requests remaining'), undefined);
  assert.equal(failureHttpStatus({ kind: 'http_error', statusCode: 500 }, OUT_OF_CREDITS), 500);
});
